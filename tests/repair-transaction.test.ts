import { describe, expect, it } from "vitest";

import type { RemoteHttpClient } from "../src/remote-release";
import {
	REPAIR_JOURNAL_PHASES,
	REPAIR_RESULT_STATUSES,
	RepairTransactionEngine,
	type RepairApprovalProvider,
	type RepairApprovalRequest,
	type RepairAuthorization,
	type RepairJournalPhase,
	type RepairReceipt,
	type RepairResultStatus,
} from "../src/repair-transaction";
import {
	createRepairFixture,
	FakeRepairAdapter,
	MemoryRepairJournal,
	OWN_PLUGIN_PATH,
	PLUGIN_ID,
	PLUGIN_PATH,
	textBytes,
	TRANSACTION_ID,
	type RepairFixture,
} from "./repair-fixtures";

function bytesEqual(left: ArrayBuffer | null, right: ArrayBuffer): boolean {
	return left !== null
		&& [...new Uint8Array(left)].join(",") === [...new Uint8Array(right)].join(",");
}

function authorizationFor(request: RepairApprovalRequest): RepairAuthorization {
	return {
		transactionId: request.transactionId,
		planFingerprint: request.planFingerprint,
		approvedAssetNames: request.artifacts.map(artifact => artifact.assetName),
	};
}

interface SetupResult {
	readonly fixture: RepairFixture;
	readonly adapter: FakeRepairAdapter;
	readonly journal: MemoryRepairJournal;
	readonly requests: string[];
	readonly engine: RepairTransactionEngine;
}

async function setup(
	approval: RepairApprovalProvider | null = null,
	includeManifestRepair = true,
): Promise<SetupResult> {
	const fixture = await createRepairFixture(includeManifestRepair);
	const adapter = new FakeRepairAdapter();
	adapter.seedFolder(".obsidian/plugins");
	adapter.seedFolder(OWN_PLUGIN_PATH);
	adapter.seedFolder(PLUGIN_PATH);
	adapter.seedFile(`${PLUGIN_PATH}/main.js`, fixture.originalFiles["main.js"]);
	adapter.seedFile(`${PLUGIN_PATH}/manifest.json`, fixture.originalFiles["manifest.json"]);
	const journal = new MemoryRepairJournal();
	const requests: string[] = [];
	const downloads = new Map<string, ArrayBuffer>([
		["https://github.com/example/plugin/releases/download/1.2.3/main.js", fixture.expectedFiles["main.js"]],
		["https://github.com/example/plugin/releases/download/1.2.3/styles.css", fixture.expectedFiles["styles.css"]],
	]);
	const http: RemoteHttpClient = request => {
		requests.push(request.url);
		const body = downloads.get(request.url);
		if (body === undefined) {
			return Promise.resolve({ status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "" });
		}
		return Promise.resolve({ status: 200, headers: {}, arrayBuffer: body.slice(0), text: "" });
	};
	let clock = 1000;
	const engine = new RepairTransactionEngine({
		adapter,
		http,
		journal,
		approval: approval ?? {
			requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve(authorizationFor(request)),
		},
		ownPluginId: "sync-assets",
		normalizePath: (path): string => path.replaceAll("//", "/"),
		now: (): number => ++clock,
		createTransactionId: (): string => TRANSACTION_ID,
	});
	return { fixture, adapter, journal, requests, engine };
}

describe("repair transaction engine", () => {
	it("keeps journal phases and transaction outcomes exhaustive", () => {
		const phases: Readonly<Record<RepairJournalPhase, true>> = {
			planned: true,
			authorized: true,
			staged: true,
			applying: true,
			committed: true,
			"rolling-back": true,
			"rolled-back": true,
			"needs-attention": true,
		};
		const statuses: Readonly<Record<RepairResultStatus, true>> = {
			committed: true,
			cancelled: true,
			blocked: true,
			stale: true,
			"rolled-back": true,
			"needs-attention": true,
			error: true,
		};
		expect(REPAIR_JOURNAL_PHASES.every(phase => phases[phase])).toBe(true);
		expect(REPAIR_RESULT_STATUSES.every(status => statuses[status])).toBe(true);
	});

	it("does no network or filesystem work when explicit approval is declined", async () => {
		const built = await setup({ requestApproval: (): Promise<null> => Promise.resolve(null) });

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("cancelled");
		expect(built.requests).toEqual([]);
		expect(built.adapter.calls).toEqual([]);
		expect(built.journal.created).toEqual([]);
		expect(built.journal.updated).toEqual([]);
	});

	it("passes the verified local plugin name for display without changing authorization identity", async () => {
		let captured: RepairApprovalRequest | null = null;
		const built = await setup({
			requestApproval: (request): Promise<null> => {
				captured = request;
				return Promise.resolve(null);
			},
		});

		await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(captured).toEqual(expect.objectContaining({
			pluginId: PLUGIN_ID,
			pluginName: "Example Plugin",
		}));
	});

	it("allows startup evidence only through the same explicit approval contract", async () => {
		let approvalRequests = 0;
		const built = await setup({
			requestApproval: (request): Promise<RepairAuthorization> => {
				approvalRequests += 1;
				return Promise.resolve(authorizationFor(request));
			},
		});

		const repaired = await built.engine.repair(
			{ ...built.fixture.run, trigger: "startup" },
			PLUGIN_ID,
		);

		expect(repaired.status).toBe("committed");
		expect(approvalRequests).toBe(1);
		expect(repaired.receipt?.restartRequired).toBe(true);
	});

	it("returns a reload completion action only after a non-manifest repair commits", async () => {
		const built = await setup({
			requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve({
				...authorizationFor(request),
				reloadAfterCommit: true,
			}),
		}, false);

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("committed");
		expect(repaired.completionAction).toBe("reload-app");
	});

	it("rejects reload authorization when manifest.json is part of the repair", async () => {
		const built = await setup({
			requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve({
				...authorizationFor(request),
				reloadAfterCommit: true,
			}),
		}, true);

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("blocked");
		expect(repaired.reason?.code).toBe("repair-authorization-mismatch");
		expect(built.requests).toEqual([]);
		expect(built.adapter.calls).toEqual([]);
	});

	it("stages every artifact before replacing targets and commits in safe order", async () => {
		const built = await setup();

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("committed");
		expect(repaired.receipt).toEqual(expect.objectContaining({
			phase: "committed",
			restartRequired: true,
			pluginId: PLUGIN_ID,
		}));
		expect(built.requests).toEqual([
			"https://github.com/example/plugin/releases/download/1.2.3/main.js",
			"https://github.com/example/plugin/releases/download/1.2.3/styles.css",
		]);
		for (const assetName of ["main.js", "styles.css", "manifest.json"] as const) {
			expect(bytesEqual(
				built.adapter.fileBytes(`${PLUGIN_PATH}/${assetName}`),
				built.fixture.expectedFiles[assetName],
			)).toBe(true);
		}
		expect(bytesEqual(
			built.adapter.fileBytes(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/main.js`),
			built.fixture.originalFiles["main.js"],
		)).toBe(true);
		expect(bytesEqual(
			built.adapter.fileBytes(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/manifest.json`),
			built.fixture.originalFiles["manifest.json"],
		)).toBe(true);
		expect(built.adapter.fileBytes(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/styles.css`)).toBeNull();

		const writes = built.adapter.calls
			.map((call, index) => ({ call, index }))
			.filter(entry => entry.call.startsWith("writeBinary:"));
		const firstTargetRename = built.adapter.calls.findIndex(call => (
			call === `rename:${PLUGIN_PATH}/main.js->${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/main.js`
		));
		expect(writes).toHaveLength(3);
		expect(Math.max(...writes.map(entry => entry.index))).toBeLessThan(firstTargetRename);
		const targetInstallOrder = built.adapter.calls.filter(call => call.startsWith("rename:") && call.endsWith(`->${PLUGIN_PATH}/main.js`) || call.endsWith(`->${PLUGIN_PATH}/styles.css`) || call.endsWith(`->${PLUGIN_PATH}/manifest.json`));
		expect(targetInstallOrder).toEqual([
			`rename:${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/staged/main.js->${PLUGIN_PATH}/main.js`,
			`rename:${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/staged/styles.css->${PLUGIN_PATH}/styles.css`,
			`rename:${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/staged/manifest.json->${PLUGIN_PATH}/manifest.json`,
		]);
		expect(built.journal.created[0]?.phase).toBe("authorized");
		expect(built.journal.updated.map(receipt => receipt.phase)).toEqual(expect.arrayContaining([
			"staged",
			"applying",
			"committed",
		]));
		const serializedReceipt = JSON.stringify(repaired.receipt);
		expect(serializedReceipt).not.toContain("downloadUrl");
		expect(serializedReceipt).not.toContain("github.com");
		expect(serializedReceipt).not.toContain("token");
	});

	it("rejects invalid download bytes before any target mutation", async () => {
		const built = await setup();
		const remote = built.fixture.run.remote?.records[0];
		expect(remote?.status).toBe("resolved");
		if (remote?.status !== "resolved") {
			return;
		}
		const brokenHttp: RemoteHttpClient = request => Promise.resolve({
			status: 200,
			headers: {},
			arrayBuffer: request.url.endsWith("main.js") ? textBytes("evil-main") : built.fixture.expectedFiles["styles.css"],
			text: "",
		});
		const engine = new RepairTransactionEngine({
			adapter: built.adapter,
			http: brokenHttp,
			journal: built.journal,
			approval: { requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve(authorizationFor(request)) },
			ownPluginId: "sync-assets",
			normalizePath: (path): string => path,
			createTransactionId: (): string => TRANSACTION_ID,
		});

		const repaired = await engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("error");
		expect(repaired.reason?.code).toBe("repair-download-digest-mismatch");
		expect(built.adapter.calls.some(call => call.startsWith(`rename:${PLUGIN_PATH}/`))).toBe(false);
		expect(bytesEqual(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`), built.fixture.originalFiles["main.js"])).toBe(true);
		expect(await built.adapter.stat(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}`)).toBeNull();
	});

	it.each([
		{ label: "HTTP failure", status: 503, body: textBytes("good-main"), code: "repair-download-http-error" },
		{ label: "byte-length mismatch", status: 200, body: textBytes("short"), code: "repair-download-size-mismatch" },
	])("rejects $label before target mutation", async ({ status, body, code }) => {
		const built = await setup();
		const http: RemoteHttpClient = request => Promise.resolve({
			status: request.url.endsWith("main.js") ? status : 200,
			headers: {},
			arrayBuffer: request.url.endsWith("main.js") ? body : built.fixture.expectedFiles["styles.css"],
			text: "",
		});
		const engine = new RepairTransactionEngine({
			adapter: built.adapter,
			http,
			journal: built.journal,
			approval: { requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve(authorizationFor(request)) },
			ownPluginId: "sync-assets",
			normalizePath: (path): string => path,
			createTransactionId: (): string => TRANSACTION_ID,
		});

		const repaired = await engine.repair(built.fixture.run, PLUGIN_ID);
		expect(repaired.status).toBe("error");
		expect(repaired.reason?.code).toBe(code);
		expect(built.adapter.calls.some(call => call.startsWith(`rename:${PLUGIN_PATH}/`))).toBe(false);
	});

	it("stops as stale when local evidence changes after the check", async () => {
		const built = await setup();
		built.adapter.seedFile(`${PLUGIN_PATH}/main.js`, textBytes("evil-main"));

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("stale");
		expect(repaired.reason?.code).toBe("repair-evidence-stale");
		expect(built.adapter.calls.some(call => call.startsWith(`rename:${PLUGIN_PATH}/`))).toBe(false);
		expect(repaired.receipt?.phase).toBe("rolled-back");
	});

	it("rolls every changed artifact back in reverse order after an apply failure", async () => {
		const built = await setup();
		built.adapter.failRename = (from, to): boolean => (
			from.endsWith(`/staged/styles.css`) && to === `${PLUGIN_PATH}/styles.css`
		);

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("rolled-back");
		expect(repaired.receipt?.phase).toBe("rolled-back");
		expect(bytesEqual(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`), built.fixture.originalFiles["main.js"])).toBe(true);
		expect(built.adapter.fileBytes(`${PLUGIN_PATH}/styles.css`)).toBeNull();
		expect(bytesEqual(built.adapter.fileBytes(`${PLUGIN_PATH}/manifest.json`), built.fixture.originalFiles["manifest.json"])).toBe(true);
		expect(built.adapter.fileBytes(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/main.js`)).toBeNull();
		expect(await built.adapter.stat(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}`)).toBeNull();
	});

	it("does not delete a target that changed after installation and reports needs-attention", async () => {
		const built = await setup();
		const external = textBytes("evil-main");
		built.adapter.afterRename = (from, to, adapter): void => {
			if (from.endsWith("/staged/main.js") && to === `${PLUGIN_PATH}/main.js`) {
				adapter.seedFile(to, external);
			}
		};

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("needs-attention");
		expect(repaired.reason?.code).toBe("repair-rollback-target-changed");
		expect(bytesEqual(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`), external)).toBe(true);
		expect(bytesEqual(
			built.adapter.fileBytes(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup/main.js`),
			built.fixture.originalFiles["main.js"],
		)).toBe(true);
		expect(repaired.receipt?.phase).toBe("needs-attention");
	});

	it("blocks an open journal, mismatched authorization, and a concurrent repair", async () => {
		const mismatched = await setup({
			requestApproval: (request): Promise<RepairAuthorization> => Promise.resolve({
				...authorizationFor(request),
				planFingerprint: "wrong-plan",
			}),
		});
		const mismatchedResult = await mismatched.engine.repair(mismatched.fixture.run, PLUGIN_ID);
		expect(mismatchedResult.status).toBe("blocked");
		expect(mismatchedResult.reason?.code).toBe("repair-authorization-mismatch");
		expect(mismatched.requests).toEqual([]);
		expect(mismatched.adapter.calls).toEqual([]);

		const built = await setup();
		built.journal.open = { transactionId: "repair-open" } as RepairReceipt;
		const blocked = await built.engine.repair(built.fixture.run, PLUGIN_ID);
		expect(blocked.status).toBe("blocked");
		expect(blocked.reason?.code).toBe("repair-journal-open");
		expect(built.requests).toEqual([]);
		expect(built.adapter.calls).toEqual([]);

		const approvalResolvers: Array<(authorization: RepairAuthorization | null) => void> = [];
		const approval: RepairApprovalProvider = {
			requestApproval: (request): Promise<RepairAuthorization | null> => new Promise(resolve => {
				approvalResolvers.push(resolve);
				void request;
			}),
		};
		const concurrent = await setup(approval, false);
		const first = concurrent.engine.repair(concurrent.fixture.run, PLUGIN_ID);
		await Promise.resolve();
		const second = await concurrent.engine.repair(concurrent.fixture.run, PLUGIN_ID);
		expect(second.status).toBe("blocked");
		expect(second.reason?.code).toBe("repair-in-progress");
		const resolveApproval = approvalResolvers[0];
		if (resolveApproval === undefined) {
			throw new Error("Approval was not requested.");
		}
		resolveApproval(null);
		expect((await first).status).toBe("cancelled");
	});

	it("fails closed when durable journal creation is unavailable", async () => {
		const built = await setup();
		built.journal.failCreate = true;

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("error");
		expect(repaired.reason?.code).toBe("repair-journal-create-error");
		expect(built.requests).toEqual([]);
		expect(built.adapter.calls).toEqual([]);
	});

	it("does not mutate targets when journal progress cannot be persisted", async () => {
		const built = await setup();
		built.journal.failUpdate = true;

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("needs-attention");
		expect(repaired.reason?.code).toBe("repair-journal-finalize-error");
		expect(built.adapter.calls.some(call => call.startsWith(`rename:${PLUGIN_PATH}/`))).toBe(false);
		expect(bytesEqual(built.adapter.fileBytes(`${PLUGIN_PATH}/main.js`), built.fixture.originalFiles["main.js"])).toBe(true);
	});

	it("does not clean files from a colliding workspace it did not create", async () => {
		const built = await setup();
		const repairRoot = `${OWN_PLUGIN_PATH}/.repair`;
		const workspace = `${repairRoot}/${TRANSACTION_ID}`;
		const stagedDirectory = `${workspace}/staged`;
		const foreignBytes = textBytes("foreign-staged-data");
		built.adapter.seedFolder(repairRoot);
		built.adapter.seedFolder(workspace);
		built.adapter.seedFolder(stagedDirectory);
		built.adapter.seedFile(`${stagedDirectory}/main.js`, foreignBytes);

		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("error");
		expect(repaired.reason?.code).toBe("repair-workspace-collision");
		expect(bytesEqual(built.adapter.fileBytes(`${stagedDirectory}/main.js`), foreignBytes)).toBe(true);
		expect(built.adapter.calls.some(call => call === `remove:${stagedDirectory}/main.js`)).toBe(false);
	});

	it("limits mutation paths to the own workspace and allowlisted target artifacts", async () => {
		const built = await setup();
		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);
		expect(repaired.status).toBe("committed");

		const mutationCalls = built.adapter.calls.filter(call => (
			call.startsWith("mkdir:")
			|| call.startsWith("writeBinary:")
			|| call.startsWith("rename:")
			|| call.startsWith("remove:")
		));
		for (const call of mutationCalls) {
			expect(call.includes(`${OWN_PLUGIN_PATH}/.repair`) || (
				call.startsWith("rename:")
				&& ["main.js", "manifest.json", "styles.css"].some(assetName => call.includes(`${PLUGIN_PATH}/${assetName}`))
			)).toBe(true);
			expect(call).not.toContain("data.json");
			expect(call).not.toContain("state");
		}
	});

	it("removes the empty staged directory after a successful commit", async () => {
		const built = await setup();
		const repaired = await built.engine.repair(built.fixture.run, PLUGIN_ID);

		expect(repaired.status).toBe("committed");
		expect(await built.adapter.stat(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/staged`)).toBeNull();
		expect(await built.adapter.stat(`${OWN_PLUGIN_PATH}/.repair/${TRANSACTION_ID}/backup`)).not.toBeNull();
	});
});
