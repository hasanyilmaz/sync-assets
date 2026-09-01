import { describe, expect, it } from "vitest";

import {
	PersistentDataController,
	createDefaultPersistedData,
	parsePersistedData,
	type SyncAssetsPersistedData,
} from "../src/persisted-state";
import type { RepairReceipt } from "../src/repair-transaction";

const TRANSACTION_ID = `repair-${"a".repeat(32)}`;
const SESSION_ID = `session-${"b".repeat(32)}`;
const DIGEST = `sha256:${"c".repeat(64)}`;

function receipt(overrides: Partial<RepairReceipt> = {}): RepairReceipt {
	return {
		transactionId: TRANSACTION_ID,
		planFingerprint: "repair-plan-v1\ntrusted",
		runId: 3,
		pluginId: "example-plugin",
		repository: { owner: "example", repo: "plugin" },
		manifestVersion: "1.2.3",
		releaseId: 44,
		releaseTag: "1.2.3",
		phase: "committed",
		startedAtMs: 10,
		updatedAtMs: 20,
		finishedAtMs: 20,
		restartRequired: true,
		artifacts: [{
			assetName: "main.js",
			targetPath: ".obsidian/plugins/example-plugin/main.js",
			stagedPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/staged/main.js`,
			backupPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/backup/main.js`,
			expected: { sizeBytes: 10, sha256: DIGEST },
			original: { exists: true, sizeBytes: 8, mtimeMs: 9, sha256: `sha256:${"d".repeat(64)}` },
			state: "verified",
			backupRetained: true,
		}],
		completedSteps: ["transaction-committed"],
		reason: null,
		...overrides,
	};
}

function data(): SyncAssetsPersistedData {
	return {
		schemaVersion: 2,
		revision: 7,
		startupCheckEnabled: false,
		repositories: [{ pluginId: "example-plugin", repository: { owner: "example", repo: "plugin" } }],
		repairRecords: [{
			receipt: receipt(),
			originSessionId: SESSION_ID,
			healthyProof: null,
			backupCleanup: { status: "retained", deletedAssetNames: [], reason: null },
		}],
	};
}

class Storage {
	readonly saves: SyncAssetsPersistedData[] = [];
	failSave = false;

	constructor(public raw: unknown) {}

	load(): Promise<unknown> {
		return Promise.resolve(structuredClone(this.raw));
	}

	save(next: SyncAssetsPersistedData): Promise<void> {
		if (this.failSave) {
			return Promise.reject(new Error("write denied"));
		}
		this.raw = structuredClone(next);
		this.saves.push(structuredClone(next));
		return Promise.resolve();
	}
}

describe("persisted data schema v2", () => {
	it("migrates valid v1 in memory without writing and persists v2 on the first explicit mutation", async () => {
		const storage = new Storage({
			schemaVersion: 1,
			startupCheckEnabled: true,
			repositories: [{ pluginId: "example-plugin", repository: { owner: "example", repo: "plugin" } }],
		});
		const controller = new PersistentDataController(storage);

		const loaded = await controller.load();
		expect(loaded.migrationNeeded).toBe(true);
		expect(loaded.data.schemaVersion).toBe(2);
		expect(loaded.data.repositories).toHaveLength(1);
		expect(storage.saves).toEqual([]);

		const changed = await controller.mutate(current => ({ ...current, startupCheckEnabled: current.startupCheckEnabled }));
		expect(changed.ok).toBe(true);
		expect(storage.saves).toEqual([expect.objectContaining({
			schemaVersion: 2,
			revision: 1,
			startupCheckEnabled: true,
			repairRecords: [],
		})]);
	});

	it("round-trips strict v2 state", () => {
		const parsed = parsePersistedData(data());
		expect(parsed.issues).toEqual([]);
		expect(parsed.journalUsable).toBe(true);
		expect(parsed.data).toEqual(data());
	});

	it.each([
		["unknown receipt phase", (): unknown => ({ ...data(), repairRecords: [{ ...data().repairRecords[0], receipt: { ...receipt(), phase: "resuming" } }] })],
		["unsafe backup path", (): unknown => ({ ...data(), repairRecords: [{ ...data().repairRecords[0], receipt: { ...receipt(), artifacts: [{ ...receipt().artifacts[0], backupPath: ".obsidian/plugins/example-plugin/main.js" }] } }] })],
		["invalid digest", (): unknown => ({ ...data(), repairRecords: [{ ...data().repairRecords[0], receipt: { ...receipt(), artifacts: [{ ...receipt().artifacts[0], expected: { sizeBytes: 10, sha256: "sha256:bad" } }] } }] })],
		["duplicate transaction", (): unknown => ({ ...data(), repairRecords: [data().repairRecords[0], data().repairRecords[0]] })],
	])("locks repair for %s rather than treating the journal as empty", (_name, factory) => {
		const parsed = parsePersistedData(factory());
		expect(parsed.journalUsable).toBe(false);
		expect(parsed.usedDefaults).toBe(true);
		expect(parsed.issues.length).toBeGreaterThan(0);
		expect(parsed.data.repairRecords).toEqual([]);
	});

	it("preserves journal records during settings mutation", async () => {
		const storage = new Storage(data());
		const controller = new PersistentDataController(storage);
		await controller.load();
		const result = await controller.mutate(current => ({
			...current,
			repositories: [{ pluginId: "other-plugin", repository: { owner: "example", repo: "other" } }],
		}));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.repairRecords).toEqual(data().repairRecords);
			expect(result.data.revision).toBe(8);
		}
	});

	it("rejects an external content change even when the revision is unchanged", async () => {
		const storage = new Storage(data());
		const controller = new PersistentDataController(storage);
		await controller.load();
		storage.raw = { ...data(), startupCheckEnabled: true };
		const result = await controller.mutate(current => ({ ...current, repositories: [] }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issue.code).toBe("persisted-data-conflict");
		}
		expect(storage.saves).toEqual([]);
	});

	it("does not overwrite malformed v2 data through a later settings-style mutation", async () => {
		const malformed = { ...data(), repairRecords: [{ ...data().repairRecords[0], unexpected: true }] };
		const storage = new Storage(malformed);
		const controller = new PersistentDataController(storage);
		const loaded = await controller.load();
		expect(loaded.journalUsable).toBe(false);
		const result = await controller.mutate(current => ({ ...current, repositories: [] }));
		expect(result.ok).toBe(false);
		expect(storage.raw).toEqual(malformed);
		expect(storage.saves).toEqual([]);
	});

	it("creates safe first-run v2 defaults", () => {
		expect(createDefaultPersistedData()).toEqual({
			schemaVersion: 2,
			revision: 0,
			startupCheckEnabled: true,
			repositories: [],
			repairRecords: [],
		});
	});
});
