import { describe, expect, it } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import {
	OBSIDIAN_NO_SOURCE_MAP_SUFFIX,
	type ArtifactIntegrityResult,
} from "../src/domain";
import {
	PersistentDataController,
	type SyncAssetsPersistedData,
} from "../src/persisted-state";
import {
	deleteVerifiedBackups,
	isRepairRecordBlocking,
	PersistentRepairJournal,
	recordAllPostRestartHealthyProofs,
	recordPostRestartHealthyProof,
} from "../src/repair-lifecycle";
import type { RepairReceipt } from "../src/repair-transaction";
import {
	RepairTransactionEngine,
	type RepairAuthorization,
} from "../src/repair-transaction";
import type { RemoteHttpClient } from "../src/remote-release";
import {
	createRepairFixture,
	FakeRepairAdapter,
	OWN_PLUGIN_PATH,
	PLUGIN_ID,
	PLUGIN_PATH,
	TRANSACTION_ID,
	textBytes,
} from "./repair-fixtures";
import { sha256ArrayBuffer } from "../src/integrity-verification";

const ORIGIN_SESSION = `session-${"1".repeat(32)}`;
const NEW_SESSION = `session-${"2".repeat(32)}`;
const REPAIR_ROOT_PATH = `${OWN_PLUGIN_PATH}/.repair`;

class Storage {
	readonly saves: SyncAssetsPersistedData[] = [];

	constructor(public raw: unknown) {}

	load(): Promise<unknown> {
		return Promise.resolve(structuredClone(this.raw));
	}

	save(data: SyncAssetsPersistedData): Promise<void> {
		this.raw = structuredClone(data);
		this.saves.push(structuredClone(data));
		return Promise.resolve();
	}
}

function committedReceipt(run: IntegrityCheckRun): RepairReceipt {
	const remote = run.remote?.records[0];
	const verification = run.verification?.records[0];
	if (remote?.status !== "resolved" || verification?.outcome !== "evaluated") {
		throw new Error("Fixture is not resolved and evaluated.");
	}
	const artifacts = verification.result.artifacts
		.filter(artifact => artifact.repairEligible)
		.map(artifact => {
			if (artifact.expected === null) {
				throw new Error("Missing expected fingerprint.");
			}
			const original = artifact.local.exists === false
				? { exists: false as const }
				: {
					exists: true as const,
					sizeBytes: artifact.local.sizeBytes ?? 0,
					mtimeMs: 100,
					sha256: artifact.local.sha256 ?? `sha256:${"0".repeat(64)}`,
				};
			return {
				assetName: artifact.assetName,
				targetPath: `.obsidian/plugins/${PLUGIN_ID}/${artifact.assetName}`,
				stagedPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/staged/${artifact.assetName}`,
				backupPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/backup/${artifact.assetName}`,
				expected: artifact.expected,
				original,
				state: "verified" as const,
				backupRetained: original.exists,
			};
		});
	return {
		transactionId: TRANSACTION_ID,
		planFingerprint: "repair-plan-v1\nfixture",
		runId: run.runId,
		pluginId: PLUGIN_ID,
		repository: remote.repository,
		manifestVersion: remote.manifestVersion,
		releaseId: remote.release.releaseId,
		releaseTag: remote.release.tagName,
		phase: "committed",
		startedAtMs: 10,
		updatedAtMs: 20,
		finishedAtMs: 20,
		restartRequired: true,
		artifacts,
		completedSteps: ["transaction-committed"],
		reason: null,
	};
}

function stateWithReceipt(receipt: RepairReceipt): SyncAssetsPersistedData {
	return {
		schemaVersion: 2,
		revision: 1,
		startupCheckEnabled: false,
		repositories: [{ pluginId: PLUGIN_ID, repository: receipt.repository }],
		repairRecords: [{
			receipt,
			originSessionId: ORIGIN_SESSION,
			healthyProof: null,
			backupCleanup: {
				status: receipt.artifacts.some(artifact => artifact.backupRetained) ? "retained" : "none",
				deletedAssetNames: [],
				reason: null,
			},
		}],
	};
}

function receiptWithTransactionId(
	receipt: RepairReceipt,
	transactionId: string,
): RepairReceipt {
	return {
		...receipt,
		transactionId,
		planFingerprint: `${receipt.planFingerprint}\n${transactionId}`,
		artifacts: receipt.artifacts.map(artifact => ({
			...artifact,
			stagedPath: artifact.stagedPath.replace(receipt.transactionId, transactionId),
			backupPath: artifact.backupPath.replace(receipt.transactionId, transactionId),
		})),
	};
}

function recordForReceipt(
	receipt: RepairReceipt,
): SyncAssetsPersistedData["repairRecords"][number] {
	return {
		receipt,
		originSessionId: ORIGIN_SESSION,
		healthyProof: null,
		backupCleanup: {
			status: receipt.artifacts.some(artifact => artifact.backupRetained) ? "retained" : "none",
			deletedAssetNames: [],
			reason: null,
		},
	};
}

function seedTransactionDirectories(
	adapter: FakeRepairAdapter,
	transactionId = TRANSACTION_ID,
): void {
	const workspacePath = `${REPAIR_ROOT_PATH}/${transactionId}`;
	adapter.seedFolder(REPAIR_ROOT_PATH);
	adapter.seedFolder(workspacePath);
	adapter.seedFolder(`${workspacePath}/staged`);
	adapter.seedFolder(`${workspacePath}/backup`);
}

function healthyRun(run: IntegrityCheckRun): IntegrityCheckRun {
	const verification = run.verification;
	if (verification === null || verification.records[0]?.outcome !== "evaluated") {
		throw new Error("Fixture verification is unavailable.");
	}
	const source = verification.records[0];
	const artifacts: ArtifactIntegrityResult[] = source.result.artifacts.map(artifact => ({
		...artifact,
		status: "healthy",
		local: artifact.expected === null
			? artifact.local
			: { exists: true, sizeBytes: artifact.expected.sizeBytes, sha256: artifact.expected.sha256 },
		hashStatus: artifact.expected === null ? "not-required" : "computed",
		repairEligible: false,
		reason: null,
	}));
	return {
		...run,
		runId: run.runId + 1,
		verification: {
			status: "completed",
			reason: null,
			records: [{
				...source,
				status: "healthy",
				result: { ...source.result, status: "healthy", artifacts, repairEligible: false, reason: null },
				reason: null,
			}],
		},
	};
}

async function loadedJournal(data: SyncAssetsPersistedData, sessionId = NEW_SESSION): Promise<{
	journal: PersistentRepairJournal;
	storage: Storage;
}> {
	const storage = new Storage(data);
	const persistence = new PersistentDataController(storage);
	await persistence.load();
	return { journal: new PersistentRepairJournal(persistence, sessionId), storage };
}

describe("persistent repair lifecycle", () => {
	it("persists every production repair phase without turning a commit into a repair lock", async () => {
		const fixture = await createRepairFixture(true);
		const storage = new Storage(null);
		const persistence = new PersistentDataController(storage);
		await persistence.load();
		const journal = new PersistentRepairJournal(persistence, ORIGIN_SESSION);
		const adapter = new FakeRepairAdapter();
		adapter.seedFolder(".obsidian/plugins");
		adapter.seedFolder(OWN_PLUGIN_PATH);
		adapter.seedFolder(PLUGIN_PATH);
		adapter.seedFile(`${PLUGIN_PATH}/main.js`, fixture.originalFiles["main.js"]);
		adapter.seedFile(`${PLUGIN_PATH}/manifest.json`, fixture.originalFiles["manifest.json"]);
		const downloads = new Map([
			["https://github.com/example/plugin/releases/download/1.2.3/main.js", fixture.expectedFiles["main.js"]],
			["https://github.com/example/plugin/releases/download/1.2.3/styles.css", fixture.expectedFiles["styles.css"]],
		]);
		const http: RemoteHttpClient = request => {
			const bytes = downloads.get(request.url);
			return Promise.resolve(bytes === undefined
				? { status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "" }
				: { status: 200, headers: {}, arrayBuffer: bytes.slice(0), text: "" });
		};
		const engine = new RepairTransactionEngine({
			adapter,
			http,
			journal,
			approval: {
				requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve({
					transactionId: request.transactionId,
					planFingerprint: request.planFingerprint,
					approvedAssetNames: request.artifacts.map(artifact => artifact.assetName),
				}),
			},
			ownPluginId: "sync-assets",
			normalizePath: (path): string => path,
			createTransactionId: (): string => TRANSACTION_ID,
		});

		const repaired = await engine.repair(fixture.run, PLUGIN_ID);
		expect(repaired.status).toBe("committed");
		expect(journal.getSnapshot().blockingRecord).toBeNull();
		expect(journal.getSnapshot().records[0]?.originSessionId).toBe(ORIGIN_SESSION);
		expect(journal.getSnapshot().records[0]?.healthyProof).toBeNull();
		expect(journal.getSnapshot().records[0]?.backupCleanup.status).toBe("retained");
		expect(storage.saves.length).toBeGreaterThanOrEqual(4);
	});

	it("enforces create, legal phase transitions, and immutable transaction identity", async () => {
		const fixture = await createRepairFixture(false);
		const committed = committedReceipt(fixture.run);
		const authorized: RepairReceipt = {
			...committed,
			phase: "authorized",
			finishedAtMs: null,
			artifacts: committed.artifacts.map(artifact => ({
				...artifact,
				original: null,
				state: "pending",
				backupRetained: false,
			})),
		};
		const storage = new Storage(null);
		const persistence = new PersistentDataController(storage);
		await persistence.load();
		const journal = new PersistentRepairJournal(persistence, ORIGIN_SESSION);
		await journal.create(authorized);
		expect(journal.getSnapshot().blockingRecord?.receipt.phase).toBe("authorized");

		const staged: RepairReceipt = {
			...authorized,
			phase: "staged",
			updatedAtMs: 21,
			artifacts: authorized.artifacts.map(artifact => ({ ...artifact, state: "staged" })),
		};
		await journal.update(staged);
		await expect(journal.update({ ...staged, phase: "committed", finishedAtMs: 22 })).rejects.toThrow("Illegal repair phase transition");
		await expect(journal.update({ ...staged, pluginId: "other-plugin" })).rejects.toThrow("immutable identity");
	});

	it("keeps committed proof pending without blocking a fresh repair", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const { journal } = await loadedJournal(stateWithReceipt(receipt), ORIGIN_SESSION);

		expect(isRepairRecordBlocking(journal.getSnapshot().records[0]!)).toBe(false);
		const sameSession = await recordPostRestartHealthyProof(journal, healthyRun(fixture.run), ORIGIN_SESSION, 30);
		expect(sameSession.status).toBe("same-session");
		expect(journal.getSnapshot().records[0]?.healthyProof).toBeNull();
		const startupRun = { ...healthyRun(fixture.run), trigger: "startup" as const };
		const recorded = await recordPostRestartHealthyProof(journal, startupRun, NEW_SESSION, 31);
		expect(recorded.status).toBe("recorded");
		expect(journal.getSnapshot().blockingRecord).toBeNull();
		expect(journal.getSnapshot().records[0]?.backupCleanup.status).toBe("cleanup-eligible");
	});

	it("allows a new authorized transaction while an earlier commit awaits proof", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const { journal } = await loadedJournal(stateWithReceipt(receipt), ORIGIN_SESSION);
		const nextTransactionId = `repair-${"3".repeat(32)}`;
		const nextAuthorized: RepairReceipt = {
			...receipt,
			transactionId: nextTransactionId,
			planFingerprint: "repair-plan-v1\nnext-fixture",
			phase: "authorized",
			startedAtMs: 21,
			updatedAtMs: 21,
			finishedAtMs: null,
			artifacts: receipt.artifacts.map(artifact => ({
				...artifact,
				stagedPath: artifact.stagedPath.replace(TRANSACTION_ID, nextTransactionId),
				backupPath: artifact.backupPath.replace(TRANSACTION_ID, nextTransactionId),
				original: null,
				state: "pending",
				backupRetained: false,
			})),
			completedSteps: [],
		};

		await expect(journal.create(nextAuthorized)).resolves.toBeUndefined();
		expect(journal.getSnapshot().records).toHaveLength(2);
		expect(journal.getSnapshot().blockingRecord?.receipt.transactionId).toBe(nextTransactionId);
	});

	it("records healthy proof for every matching committed repair in one check", async () => {
		const fixture = await createRepairFixture(false);
		const first = committedReceipt(fixture.run);
		const second = receiptWithTransactionId(first, `repair-${"4".repeat(32)}`);
		const base = stateWithReceipt(first);
		const { journal } = await loadedJournal({
			...base,
			repairRecords: [recordForReceipt(first), recordForReceipt(second)],
		});

		const attempts = await recordAllPostRestartHealthyProofs(
			journal,
			healthyRun(fixture.run),
			NEW_SESSION,
			31,
		);

		expect(attempts.map(attempt => attempt.result.status)).toEqual(["recorded", "recorded"]);
		expect(journal.getSnapshot().records.every(record => record.healthyProof !== null)).toBe(true);
	});

	it("continues to later committed repairs when an earlier record does not match", async () => {
		const fixture = await createRepairFixture(false);
		const matching = committedReceipt(fixture.run);
		const stale = {
			...receiptWithTransactionId(matching, `repair-${"5".repeat(32)}`),
			releaseId: matching.releaseId + 1,
		};
		const base = stateWithReceipt(matching);
		const { journal } = await loadedJournal({
			...base,
			repairRecords: [recordForReceipt(stale), recordForReceipt(matching)],
		});

		const attempts = await recordAllPostRestartHealthyProofs(
			journal,
			healthyRun(fixture.run),
			NEW_SESSION,
			31,
		);

		expect(attempts.map(attempt => attempt.result.status)).toEqual(["no-match", "recorded"]);
		expect(journal.getSnapshot().records[0]?.healthyProof).toBeNull();
		expect(journal.getSnapshot().records[1]?.healthyProof).not.toBeNull();
	});

	it("accepts an exact healthy Obsidian nosourcemap variant as post-restart proof", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const { journal } = await loadedJournal(stateWithReceipt(receipt), ORIGIN_SESSION);
		const healthy = healthyRun(fixture.run);
		const verification = healthy.verification;
		if (verification?.records[0]?.outcome !== "evaluated") {
			throw new Error("Healthy verification fixture is unavailable.");
		}
		const source = verification.records[0];
		const artifacts = source.result.artifacts.map(artifact => (
			artifact.assetName === "main.js" && artifact.expected !== null
				? {
					...artifact,
					local: {
						exists: true as const,
						sizeBytes: artifact.expected.sizeBytes + OBSIDIAN_NO_SOURCE_MAP_SUFFIX.length,
						sha256: artifact.expected.sha256,
					},
					acceptedVariant: "obsidian-nosourcemap-suffix" as const,
				}
				: artifact
		));
		const markerRun: IntegrityCheckRun = {
			...healthy,
			verification: {
				...verification,
				records: [{
					...source,
					result: { ...source.result, artifacts },
				}],
			},
		};

		expect((await recordPostRestartHealthyProof(journal, markerRun, NEW_SESSION, 31)).status).toBe("recorded");
	});

	it("does not accept the wrong exact release or unhealthy artifacts", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const { journal } = await loadedJournal(stateWithReceipt(receipt));
		const wrongRun = healthyRun(fixture.run);
		const remote = wrongRun.remote;
		if (remote?.records[0]?.status !== "resolved") {
			throw new Error("Remote fixture missing.");
		}
		const mismatched: IntegrityCheckRun = {
			...wrongRun,
			remote: {
				...remote,
				records: [{ ...remote.records[0], release: { ...remote.records[0].release, releaseId: 45 } }],
			},
		};
		expect((await recordPostRestartHealthyProof(journal, mismatched, NEW_SESSION)).status).toBe("no-match");
		expect((await recordPostRestartHealthyProof(journal, fixture.run, NEW_SESSION)).status).toBe("no-match");
	});

	it("verifies every backup before deleting only transaction-owned allowlisted paths", async () => {
		const fixture = await createRepairFixture(false);
		const originalMain = textBytes("original-main");
		const receipt = committedReceipt(fixture.run);
		const mainIndex = receipt.artifacts.findIndex(artifact => artifact.assetName === "main.js");
		const main = receipt.artifacts[mainIndex];
		if (main === undefined) {
			throw new Error("Main receipt missing.");
		}
		const mainDigest = await sha256ArrayBuffer(originalMain);
		const cleanupReceipt: RepairReceipt = {
			...receipt,
			artifacts: receipt.artifacts.map(artifact => artifact.assetName === "main.js" ? {
				...artifact,
				original: { exists: true, sizeBytes: originalMain.byteLength, mtimeMs: 100, sha256: mainDigest },
				backupRetained: true,
			} : { ...artifact, backupRetained: false }),
		};
		const base = stateWithReceipt(cleanupReceipt);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...base.repairRecords[0]!,
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: fixture.run.runId + 1,
					verifiedAtMs: 30,
					releaseId: cleanupReceipt.releaseId,
					releaseTag: cleanupReceipt.releaseTag,
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		seedTransactionDirectories(adapter);
		adapter.seedFile(main.backupPath, originalMain);

		expect((await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, false)).status).toBe("cancelled");
		expect(adapter.calls).toEqual([]);
		const result = await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, true);
		expect(result.status).toBe("deleted");
		expect(adapter.calls.filter(call => call.startsWith("remove:"))).toEqual([`remove:${main.backupPath}`]);
		expect(await adapter.stat(`${REPAIR_ROOT_PATH}/${TRANSACTION_ID}`)).toBeNull();
		expect(journal.getSnapshot().records).toEqual([]);
	});

	it("rejects a persisted backup path outside the trusted repair root", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const forgedReceipt: RepairReceipt = {
			...receipt,
			artifacts: receipt.artifacts.map(artifact => ({
				...artifact,
				backupPath: `notes/${artifact.backupPath}`,
			})),
		};
		const base = stateWithReceipt(forgedReceipt);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...recordForReceipt(forgedReceipt),
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: 10,
					verifiedAtMs: 30,
					releaseId: forgedReceipt.releaseId,
					releaseTag: forgedReceipt.releaseTag,
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		for (const artifact of forgedReceipt.artifacts.filter(candidate => candidate.backupRetained)) {
			if (artifact.assetName === "main.js" || artifact.assetName === "manifest.json") {
				adapter.seedFile(artifact.backupPath, fixture.originalFiles[artifact.assetName]);
			}
		}

		const result = await deleteVerifiedBackups(
			journal,
			TRANSACTION_ID,
			adapter,
			REPAIR_ROOT_PATH,
			true,
		);

		expect(result.status).toBe("blocked");
		expect(result.status === "blocked" ? result.reason.code : null).toBe("unsafe-backup-path");
		expect(adapter.calls.some(call => call.startsWith("remove:"))).toBe(false);
	});

	it("fails closed before remove when a retained backup digest changed", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const base = stateWithReceipt(receipt);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...base.repairRecords[0]!,
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: 10,
					verifiedAtMs: 30,
					releaseId: receipt.releaseId,
					releaseTag: receipt.releaseTag,
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		for (const artifact of receipt.artifacts.filter(candidate => candidate.backupRetained)) {
			adapter.seedFile(artifact.backupPath, textBytes("tampered"));
		}
		const result = await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, true);
		expect(result.status).toBe("blocked");
		expect(adapter.calls.some(call => call.startsWith("remove:"))).toBe(false);
	});

	it("removes an older verified record after rechecking every retained backup", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const base = stateWithReceipt(receipt);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...base.repairRecords[0]!,
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: 10,
					verifiedAtMs: 30,
					releaseId: receipt.releaseId,
					releaseTag: receipt.releaseTag,
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		for (const artifact of receipt.artifacts.filter(candidate => candidate.backupRetained)) {
			if (artifact.assetName === "styles.css") {
				throw new Error("Unexpected retained styles fixture.");
			}
			adapter.seedFile(artifact.backupPath, fixture.originalFiles[artifact.assetName]);
		}
		const result = await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, true);
		expect(result.status).toBe("deleted");
		expect(journal.getSnapshot().records).toEqual([]);
	});

	it("removes a verified successful record that retained no backup", async () => {
		const fixture = await createRepairFixture(false);
		const receipt = committedReceipt(fixture.run);
		const withoutBackups: RepairReceipt = {
			...receipt,
			artifacts: receipt.artifacts.map(artifact => ({
				...artifact,
				original: { exists: false as const },
				backupRetained: false,
			})),
		};
		const base = stateWithReceipt(withoutBackups);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...base.repairRecords[0]!,
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: 10,
					verifiedAtMs: 30,
					releaseId: receipt.releaseId,
					releaseTag: receipt.releaseTag,
				},
				backupCleanup: { status: "none", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		seedTransactionDirectories(adapter);

		const result = await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, true);
		expect(result.status).toBe("deleted");
		expect(adapter.calls.some(call => call.startsWith("remove:"))).toBe(false);
		expect(await adapter.stat(`${REPAIR_ROOT_PATH}/${TRANSACTION_ID}`)).toBeNull();
		expect(journal.getSnapshot().records).toEqual([]);
	});

	it("records needs-attention after a partial cleanup and does not continue", async () => {
		const fixture = await createRepairFixture(true);
		const receipt = committedReceipt(fixture.run);
		const base = stateWithReceipt(receipt);
		const initial: SyncAssetsPersistedData = {
			...base,
			repairRecords: [{
				...base.repairRecords[0]!,
				healthyProof: {
					sessionId: NEW_SESSION,
					runId: 10,
					verifiedAtMs: 30,
					releaseId: receipt.releaseId,
					releaseTag: receipt.releaseTag,
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}],
		};
		const { journal } = await loadedJournal(initial);
		const adapter = new FakeRepairAdapter();
		const main = receipt.artifacts.find(artifact => artifact.assetName === "main.js")!;
		const manifest = receipt.artifacts.find(artifact => artifact.assetName === "manifest.json")!;
		adapter.seedFile(main.backupPath, fixture.originalFiles["main.js"]);
		adapter.seedFile(manifest.backupPath, fixture.originalFiles["manifest.json"]);
		adapter.failRemove = (path): boolean => path === manifest.backupPath;

		const result = await deleteVerifiedBackups(journal, TRANSACTION_ID, adapter, REPAIR_ROOT_PATH, true);
		expect(result.status).toBe("needs-attention");
		expect(journal.getSnapshot().records[0]?.backupCleanup.status).toBe("needs-attention");
		expect(journal.getSnapshot().records[0]?.backupCleanup.deletedAssetNames).toEqual(["main.js"]);
		expect(journal.getSnapshot().blockingRecord?.receipt.transactionId).toBe(TRANSACTION_ID);
	});
});
