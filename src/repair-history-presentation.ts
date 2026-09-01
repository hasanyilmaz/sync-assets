import type { PersistedRepairRecord } from "./persisted-state";

export type RepairHistoryPresentationKind = "restored" | "needs-attention";

export interface RepairHistoryPresentation {
	readonly transactionId: string;
	readonly pluginId: string;
	readonly kind: RepairHistoryPresentationKind;
	readonly message: string;
	readonly warning: boolean;
}

export function buildRepairHistoryPresentations(
	records: readonly PersistedRepairRecord[],
): readonly RepairHistoryPresentation[] {
	return records.flatMap((record): readonly RepairHistoryPresentation[] => {
		if (
			record.receipt.phase === "committed"
			&& !["deleting", "needs-attention"].includes(record.backupCleanup.status)
		) {
			return [];
		}
		if (record.receipt.phase === "rolled-back") {
			return [{
				transactionId: record.receipt.transactionId,
				pluginId: record.receipt.pluginId,
				kind: "restored",
				message: "Repair failed — changes were restored.",
				warning: false,
			}];
		}
		return [{
			transactionId: record.receipt.transactionId,
			pluginId: record.receipt.pluginId,
			kind: "needs-attention",
			message: "Repair needs attention.",
			warning: true,
		}];
	});
}
