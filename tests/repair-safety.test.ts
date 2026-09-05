import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import { OBSIDIAN_NO_SOURCE_MAP_SUFFIX } from "../src/domain";
import { verifyPluginIntegrity } from "../src/integrity-verification";
import { PersistentDataController, type PersistedDataStorage, type SyncAssetsPersistedData } from "../src/persisted-state";
import {
	deleteVerifiedBackups,
	PersistentRepairJournal,
	recordAllPostRestartHealthyProofs,
} from "../src/repair-lifecycle";
import { REPAIR_DOWNLOAD_TIMEOUT_MS, RepairTransactionEngine, type RepairAuthorization } from "../src/repair-transaction";
import type { RemoteHttpClient, RemoteHttpResponse } from "../src/remote-release";
import {
	createRepairFixture,
	FakeRepairAdapter,
	OWN_PLUGIN_PATH,
	PLUGIN_ID,
	PLUGIN_PATH,
	textBytes,
	type RepairFixture,
} from "./repair-fixtures";

const ORIGIN_SESSION = `session-${"1".repeat(32)}`;
const NEXT_SESSION = `session-${"2".repeat(32)}`;
const MANIFEST_PATH = `${PLUGIN_PATH}/manifest.json`;

function text(bytes: ArrayBuffer | null): string {
	return bytes === null ? "" : new TextDecoder().decode(bytes);
}

async function setup(includeManifestRepair = false): Promise<{
	fixture: RepairFixture;
	adapter: FakeRepairAdapter;
	engine: RepairTransactionEngine;
	journal: PersistentRepairJournal;
	storage: PersistedDataStorage;
	saves: SyncAssetsPersistedData[];
	http: Mock<RemoteHttpClient>;
	responseFor: (url: string) => RemoteHttpResponse;
	verify: () => Promise<IntegrityCheckRun>;
}> {
	const fixture = await createRepairFixture(includeManifestRepair);
	const adapter = new FakeRepairAdapter();
	adapter.seedFolder(".obsidian/plugins");
	adapter.seedFolder(OWN_PLUGIN_PATH);
	adapter.seedFolder(PLUGIN_PATH);
	adapter.seedFile(`${PLUGIN_PATH}/main.js`, fixture.originalFiles["main.js"]);
	adapter.seedFile(MANIFEST_PATH, fixture.originalFiles["manifest.json"]);
	adapter.seedFile(`${PLUGIN_PATH}/data.json`, textBytes("user settings"));
	let raw: unknown = null;
	const saves: SyncAssetsPersistedData[] = [];
	const storage = {
		load: (): Promise<unknown> => Promise.resolve(structuredClone(raw)),
		save: (data: SyncAssetsPersistedData): Promise<void> => {
			raw = structuredClone(data);
			saves.push(structuredClone(data));
			return Promise.resolve();
		},
	};
	const persistence = new PersistentDataController(storage);
	await persistence.load();
	const journal = new PersistentRepairJournal(persistence, ORIGIN_SESSION);
	const responseFor = (url: string): RemoteHttpResponse => {
		const bytes = url.endsWith("/main.js")
			? fixture.expectedFiles["main.js"]
			: fixture.expectedFiles["styles.css"];
		return { status: 200, headers: {}, arrayBuffer: bytes.slice(0), text: "" };
	};
	const http = vi.fn<RemoteHttpClient>(request => Promise.resolve(responseFor(request.url)));
	let clock = 1000;
	let transaction = 0;
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
		now: (): number => ++clock,
		createTransactionId: (): string => `repair-${String(++transaction).padStart(32, "0")}`,
	});
	const verify = async (): Promise<IntegrityCheckRun> => {
		if (fixture.run.discovery === null || fixture.run.remote === null) {
			throw new Error("Missing repair fixture evidence.");
		}
		const verification = await verifyPluginIntegrity(fixture.run.discovery, fixture.run.remote, { adapter });
		return { ...fixture.run, verification };
	};
	return { fixture, adapter, engine, journal, storage, saves, http, responseFor, verify };
}

function newerManifest(): ArrayBuffer {
	return textBytes(JSON.stringify({
		id: PLUGIN_ID,
		name: "Example Plugin",
		author: "Example",
		version: "1.2.4",
		minAppVersion: "1.7.2",
		description: "Remote manifest",
	}));
}

afterEach(() => vi.useRealTimers());

describe("repair safety regressions", () => {
	it.each(["after-check", "during-check", "during-download"])("preserves a newer manifest arriving %s", async timing => {
		const built = await setup();
		const update = (): void => built.adapter.seedFile(MANIFEST_PATH, newerManifest());
		let run = built.fixture.run;
		if (timing === "during-download") {
			built.http.mockImplementationOnce(request => {
				update();
				return Promise.resolve(built.responseFor(request.url));
			});
		} else {
			update();
			if (timing === "during-check") {
				run = await built.verify();
			}
		}

		const repaired = await built.engine.repair(run, PLUGIN_ID);

		expect(repaired.status).toBe("stale");
		expect(repaired.reason?.code).toBe("repair-manifest-identity-changed");
		expect(text(built.adapter.fileBytes(MANIFEST_PATH))).toBe(text(newerManifest()));
		expect(text(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`))).toBe("bad--main");
		expect(built.adapter.calls.some(call => call.startsWith("rename:"))).toBe(false);
		expect(built.journal.getSnapshot().blockingRecord).toBeNull();
	});

	it.each(["missing", "invalid-json", "changed-id"])("refuses a %s manifest before target mutation", async change => {
		const built = await setup();
		if (change === "missing") {
			built.adapter.entries.delete(MANIFEST_PATH);
		} else {
			built.adapter.seedFile(MANIFEST_PATH, change === "invalid-json"
				? textBytes("{")
				: textBytes(text(built.fixture.originalFiles["manifest.json"]).replace(PLUGIN_ID, "different-plugin")));
		}

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("stale");
		expect(built.adapter.calls.some(call => call.startsWith("rename:"))).toBe(false);
		expect(built.journal.getSnapshot().blockingRecord).toBeNull();
	});

	it.each(["main.js", "styles.css"])("rolls back safely if the manifest updates after installing %s", async assetName => {
		const built = await setup();
		built.adapter.afterRename = (from, to): void => {
			if (from.endsWith(`/staged/${assetName}`) && to === `${PLUGIN_PATH}/${assetName}`) {
				built.adapter.seedFile(MANIFEST_PATH, newerManifest());
			}
		};

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("rolled-back");
		expect(repaired.reason?.code).toBe("repair-manifest-identity-changed");
		expect(text(built.adapter.fileBytes(MANIFEST_PATH))).toBe(text(newerManifest()));
		expect(text(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`))).toBe("bad--main");
		expect(built.adapter.fileBytes(`${PLUGIN_PATH}/styles.css`)).toBeNull();
		expect(text(built.adapter.fileBytes(`${PLUGIN_PATH}/data.json`))).toBe("user settings");
	});

	it.each([false, true])("repairs a corrupt nosourcemap variant and preserves rollback evidence (rollback=%s)", async rollback => {
		const built = await setup();
		const original = `bad--main${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`;
		built.adapter.seedFile(`${PLUGIN_PATH}/main.js`, textBytes(original));
		const run = await built.verify();
		expect(run.verification?.records[0]?.status).toBe("repair-available");
		if (rollback) {
			built.adapter.failRename = (from): boolean => from.endsWith("/staged/styles.css");
		}

		const repaired = await built.engine.repair(run, PLUGIN_ID);

		expect(repaired.status).toBe(rollback ? "rolled-back" : "committed");
		expect(text(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`))).toBe(rollback ? original : "good-main");
		if (!rollback) {
			const backup = repaired.receipt?.artifacts.find(artifact => artifact.assetName === "main.js")?.backupPath;
			expect(backup).toBeDefined();
			expect(text(built.adapter.fileBytes(backup!))).toBe(original);
		}
	});

	it("still rejects a corrupt variant that changes after verification", async () => {
		const built = await setup();
		built.adapter.seedFile(`${PLUGIN_PATH}/main.js`, textBytes(`bad--main${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`));
		const run = await built.verify();
		built.adapter.seedFile(`${PLUGIN_PATH}/main.js`, textBytes(`evil-main${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`));

		const repaired = await built.engine.repair(run, PLUGIN_ID);

		expect(repaired.status).toBe("stale");
		expect(repaired.reason?.code).toBe("repair-evidence-stale");
		expect(built.adapter.calls.some(call => call.startsWith("rename:"))).toBe(false);
	});

	it("times out a hung download, ignores its late completion, and releases the persistent repair lock", async () => {
		const built = await setup();
		vi.useFakeTimers();
		let completeDownload!: (response: RemoteHttpResponse) => void;
		built.http.mockImplementationOnce(() => new Promise(resolve => { completeDownload = resolve; }));
		const running = built.engine.repair(built.fixture.run, PLUGIN_ID);
		await vi.waitFor(() => expect(built.http).toHaveBeenCalledOnce());
		expect(built.journal.getSnapshot().blockingRecord?.receipt.phase).toBe("authorized");

		await vi.advanceTimersByTimeAsync(REPAIR_DOWNLOAD_TIMEOUT_MS);
		const timedOut = await running;

		expect(timedOut.reason?.code).toBe("repair-download-timeout");
		expect(timedOut.receipt?.phase).toBe("rolled-back");
		expect(built.journal.getSnapshot().blockingRecord).toBeNull();
		expect(built.adapter.calls.some(call => call.startsWith("rename:"))).toBe(false);
		const calls = [...built.adapter.calls];
		const saves = built.saves.length;
		completeDownload(built.responseFor("/main.js"));
		await vi.runAllTimersAsync();
		expect(built.adapter.calls).toEqual(calls);
		expect(built.saves).toHaveLength(saves);
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
		expect((await built.engine.repair(built.fixture.run, PLUGIN_ID)).status).toBe("committed");
	});

	it.each([false, true])("requires an app restart across plugin reloads (manifest repair=%s)", async includeManifestRepair => {
		const built = await setup(includeManifestRepair);
		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);
		expect(repaired.status).toBe("committed");
		const run = await built.verify();
		const reloadedPersistence = new PersistentDataController(built.storage);
		await reloadedPersistence.load();
		const reloadedJournal = new PersistentRepairJournal(reloadedPersistence, NEXT_SESSION);

		const pending = await recordAllPostRestartHealthyProofs(reloadedJournal, run, {
			sessionId: NEXT_SESSION,
			startedAtMs: 1,
		}, 3000);

		expect(pending[0]?.result.status).toBe("same-session");
		expect(reloadedJournal.getSnapshot().records[0]?.healthyProof).toBeNull();
		expect((await deleteVerifiedBackups(reloadedJournal, repaired.transactionId!, built.adapter, `${OWN_PLUGIN_PATH}/.repair`, true)).status).toBe("blocked");
		const recorded = await recordAllPostRestartHealthyProofs(reloadedJournal, run, {
			sessionId: NEXT_SESSION,
			startedAtMs: 2000,
		}, 3000);
		expect(recorded[0]?.result.status).toBe("recorded");
		expect((await deleteVerifiedBackups(reloadedJournal, repaired.transactionId!, built.adapter, `${OWN_PLUGIN_PATH}/.repair`, true)).status).toBe("deleted");
		expect(reloadedJournal.getSnapshot().records).toEqual([]);
	});
});
