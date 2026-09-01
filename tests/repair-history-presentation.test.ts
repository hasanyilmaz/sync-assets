import { describe, expect, it } from "vitest";

import type { PersistedRepairRecord } from "../src/persisted-state";
import { buildRepairHistoryPresentations } from "../src/repair-history-presentation";
import type { RepairReceipt } from "../src/repair-transaction";

const TRANSACTION_ID = `repair-${"a".repeat(32)}`;
const SESSION_ID = `session-${"b".repeat(32)}`;

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
		artifacts: [],
		completedSteps: [],
		reason: null,
		...overrides,
	};
}

function record(
	receiptOverrides: Partial<RepairReceipt> = {},
	overrides: Partial<PersistedRepairRecord> = {},
): PersistedRepairRecord {
	return {
		receipt: receipt(receiptOverrides),
		originSessionId: SESSION_ID,
		healthyProof: null,
		backupCleanup: { status: "retained", deletedAssetNames: [], reason: null },
		...overrides,
	};
}

describe("repair history presentation", () => {
	it("hides committed records and uses simple messages for restored and attention states", () => {
		const presentations = buildRepairHistoryPresentations([
			record(),
			record({ transactionId: `repair-${"c".repeat(32)}`, phase: "rolled-back" }),
			record({ transactionId: `repair-${"d".repeat(32)}`, phase: "needs-attention" }),
			record({ transactionId: `repair-${"e".repeat(32)}`, phase: "applying" }),
		]);

		expect(presentations.map(item => [item.kind, item.message, item.warning])).toEqual([
			["restored", "Repair failed — changes were restored.", false],
			["needs-attention", "Repair needs attention.", true],
			["needs-attention", "Repair needs attention.", true],
		]);
	});

	it("does not show a committed manifest repair awaiting restart proof", () => {
		const manifestArtifact = {
			assetName: "manifest.json" as const,
			targetPath: ".obsidian/plugins/example-plugin/manifest.json",
			stagedPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/staged/manifest.json`,
			backupPath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}/backup/manifest.json`,
			expected: { sizeBytes: 10, sha256: `sha256:${"c".repeat(64)}` },
			original: { exists: false as const },
			state: "verified" as const,
			backupRetained: false,
		};
		const presentations = buildRepairHistoryPresentations([
			record({ artifacts: [manifestArtifact] }),
		]);

		expect(presentations).toEqual([]);
	});

	it("still shows committed cleanup failures that need user attention", () => {
		const presentations = buildRepairHistoryPresentations([
			record({}, {
				backupCleanup: {
					status: "needs-attention",
					deletedAssetNames: [],
					reason: { code: "cleanup-failed", message: "Cleanup failed." },
				},
			}),
		]);

		expect(presentations.map(item => [item.kind, item.message, item.warning])).toEqual([
			["needs-attention", "Repair needs attention.", true],
		]);
	});

	it("does not show a verified successful repair", () => {
		const presentations = buildRepairHistoryPresentations([
			record({}, {
				healthyProof: {
					sessionId: `session-${"f".repeat(32)}`,
					runId: 4,
					verifiedAtMs: 30,
					releaseId: 44,
					releaseTag: "1.2.3",
				},
				backupCleanup: { status: "cleanup-eligible", deletedAssetNames: [], reason: null },
			}),
		]);

		expect(presentations).toEqual([]);
	});
});
