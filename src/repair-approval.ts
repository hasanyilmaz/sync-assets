import type {
	RepairTransactionResult,
	RepairApprovalProvider,
	RepairApprovalRequest,
	RepairAuthorization,
} from "./repair-transaction";
import type { IntegrityCheckRun } from "./check-coordinator";

export interface RepairBatchRunner {
	readonly repair: (run: IntegrityCheckRun, pluginId: string) => Promise<RepairTransactionResult>;
}

export type RepairBatchResult =
	| { readonly status: "committed"; readonly results: readonly RepairTransactionResult[] }
	| { readonly status: "stopped"; readonly failedPluginId: string; readonly results: readonly RepairTransactionResult[] };

export class InlineRepairApprovalProvider implements RepairApprovalProvider {
	private pending: { readonly pluginId: string; readonly reloadAfterCommit: boolean } | null = null;

	authorizeNext(pluginId: string, reloadAfterCommit: boolean): void {
		this.pending = { pluginId, reloadAfterCommit };
	}

	clear(): void {
		this.pending = null;
	}

	requestApproval(request: RepairApprovalRequest): Promise<RepairAuthorization | null> {
		const pending = this.pending;
		this.pending = null;
		if (
			pending === null
			|| pending.pluginId !== request.pluginId
			|| (
				pending.reloadAfterCommit
				&& request.artifacts.some(artifact => artifact.assetName === "manifest.json")
			)
		) {
			return Promise.resolve(null);
		}
		return Promise.resolve({
			transactionId: request.transactionId,
			planFingerprint: request.planFingerprint,
			approvedAssetNames: request.artifacts.map(artifact => artifact.assetName),
			reloadAfterCommit: pending.reloadAfterCommit,
		});
	}
}

export async function runAuthorizedRepairBatch(
	run: IntegrityCheckRun,
	pluginIds: readonly string[],
	approval: InlineRepairApprovalProvider,
	runner: RepairBatchRunner,
): Promise<RepairBatchResult> {
	const results: RepairTransactionResult[] = [];
	for (const pluginId of pluginIds) {
		approval.authorizeNext(pluginId, false);
		let result: RepairTransactionResult;
		try {
			result = await runner.repair(run, pluginId);
		} finally {
			approval.clear();
		}
		results.push(result);
		if (result.status !== "committed") {
			return { status: "stopped", failedPluginId: pluginId, results };
		}
	}
	return { status: "committed", results };
}
