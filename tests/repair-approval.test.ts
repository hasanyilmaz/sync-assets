import { describe, expect, it } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import {
	InlineRepairApprovalProvider,
	runAuthorizedRepairBatch,
} from "../src/repair-approval";
import type {
	RepairApprovalRequest,
	RepairTransactionResult,
} from "../src/repair-transaction";

const DIGEST = `sha256:${"a".repeat(64)}`;

function request(
	pluginId = "example-plugin",
	assetNames: readonly ("main.js" | "manifest.json" | "styles.css")[] = ["main.js"],
): RepairApprovalRequest {
	return {
		transactionId: `repair-${"1".repeat(32)}`,
		planFingerprint: "repair-plan-v1\nexample",
		pluginId,
		pluginName: "Example Plugin",
		repository: { owner: "example", repo: "plugin" },
		manifestVersion: "1.2.3",
		releaseId: 1,
		releaseTag: "1.2.3",
		artifacts: assetNames.map(assetName => ({
			assetName,
			expected: { sizeBytes: 10, sha256: DIGEST },
		})),
		restartRequired: true,
	};
}

describe("inline repair approval", () => {
	it("turns the next matching result action into exact one-shot authorization", async () => {
		const provider = new InlineRepairApprovalProvider();
		const approvalRequest = request();
		provider.authorizeNext(approvalRequest.pluginId, false);

		expect(await provider.requestApproval(approvalRequest)).toEqual({
			transactionId: approvalRequest.transactionId,
			planFingerprint: approvalRequest.planFingerprint,
			approvedAssetNames: ["main.js"],
			reloadAfterCommit: false,
		});
		expect(await provider.requestApproval(approvalRequest)).toBeNull();
	});

	it("rejects a different plugin and clears the pending intent", async () => {
		const provider = new InlineRepairApprovalProvider();
		provider.authorizeNext("other-plugin", false);

		expect(await provider.requestApproval(request())).toBeNull();
		expect(await provider.requestApproval(request("other-plugin"))).toBeNull();
	});

	it("permits reload intent only for plans that do not repair manifest.json", async () => {
		const provider = new InlineRepairApprovalProvider();
		provider.authorizeNext("example-plugin", true);
		expect((await provider.requestApproval(request()))?.reloadAfterCommit).toBe(true);

		provider.authorizeNext("example-plugin", true);
		expect(await provider.requestApproval(request("example-plugin", ["main.js", "manifest.json"]))).toBeNull();
	});

	it("clears a prepared action explicitly", async () => {
		const provider = new InlineRepairApprovalProvider();
		provider.authorizeNext("example-plugin", false);
		provider.clear();

		expect(await provider.requestApproval(request())).toBeNull();
	});

	it("authorizes and commits every listed plugin in deterministic sequence", async () => {
		const provider = new InlineRepairApprovalProvider();
		const calls: string[] = [];
		const result = await runAuthorizedRepairBatch(
			{} as IntegrityCheckRun,
			["alpha-plugin", "beta-plugin"],
			provider,
			{
				repair: async (_run, pluginId): Promise<RepairTransactionResult> => {
					calls.push(pluginId);
					const authorization = await provider.requestApproval(request(pluginId));
					expect(authorization?.approvedAssetNames).toEqual(["main.js"]);
					return {
						status: "committed",
						transactionId: authorization?.transactionId ?? null,
						pluginId,
						receipt: null,
						reason: null,
					};
				},
			},
		);

		expect(result.status).toBe("committed");
		expect(calls).toEqual(["alpha-plugin", "beta-plugin"]);
	});

	it("stops the batch at the first failed transaction", async () => {
		const provider = new InlineRepairApprovalProvider();
		const calls: string[] = [];
		const result = await runAuthorizedRepairBatch(
			{} as IntegrityCheckRun,
			["alpha-plugin", "beta-plugin", "gamma-plugin"],
			provider,
			{
				repair: (_run, pluginId): Promise<RepairTransactionResult> => {
					calls.push(pluginId);
					return Promise.resolve({
						status: pluginId === "beta-plugin" ? "error" : "committed",
						transactionId: null,
						pluginId,
						receipt: null,
						reason: pluginId === "beta-plugin"
							? { code: "repair-error", message: "failed" }
							: null,
					});
				},
			},
		);

		expect(result).toEqual(expect.objectContaining({
			status: "stopped",
			failedPluginId: "beta-plugin",
		}));
		expect(calls).toEqual(["alpha-plugin", "beta-plugin"]);
	});
});
