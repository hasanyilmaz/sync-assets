import type { IntegrityCheckRun } from "./check-coordinator";
import type { IntegrityReason } from "./domain";
import {
	deleteVerifiedBackups,
	type BackupCleanupAdapter,
	type BackupCleanupResult,
	PersistentRepairJournal,
} from "./repair-lifecycle";
import {
	type RepairTransactionResult,
} from "./repair-transaction";

export interface RepairRunner {
	readonly repair: (run: IntegrityCheckRun, pluginId: string) => Promise<RepairTransactionResult>;
}

export type RepairUiOperation = "idle" | "repairing" | "cleaning-up";

export interface RepairUiSnapshot {
	readonly operation: RepairUiOperation;
	readonly activePluginId: string | null;
	readonly latestRepair: RepairTransactionResult | null;
	readonly latestCleanup: BackupCleanupResult | null;
	readonly invalidatedEvidence: Readonly<Record<string, number>>;
}

export class RepairUiCoordinator {
	private operation: RepairUiOperation = "idle";
	private activePluginId: string | null = null;
	private latestRepair: RepairTransactionResult | null = null;
	private latestCleanup: BackupCleanupResult | null = null;
	private activePromise: Promise<unknown> | null = null;
	private readonly invalidatedEvidence = new Map<string, number>();
	private readonly listeners = new Set<(snapshot: RepairUiSnapshot) => void>();

	constructor(
		private readonly engine: RepairRunner,
		private readonly journal: PersistentRepairJournal,
		private readonly cleanupAdapter: BackupCleanupAdapter,
		private readonly repairRootPath: string,
		private readonly isCheckRunning: () => boolean,
	) {
		journal.subscribe(() => this.emit());
	}

	getSnapshot(): RepairUiSnapshot {
		return {
			operation: this.operation,
			activePluginId: this.activePluginId,
			latestRepair: this.latestRepair,
			latestCleanup: this.latestCleanup,
			invalidatedEvidence: Object.fromEntries(this.invalidatedEvidence),
		};
	}

	subscribe(listener: (snapshot: RepairUiSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => this.listeners.delete(listener);
	}

	isBusy(): boolean {
		return this.operation !== "idle";
	}

	canUseEvidence(pluginId: string, runId: number): boolean {
		return this.invalidatedEvidence.get(pluginId) !== runId;
	}

	repair(run: IntegrityCheckRun, pluginId: string): Promise<RepairTransactionResult> {
		if (this.activePromise !== null || this.isCheckRunning()) {
			return Promise.resolve({
				status: "blocked",
				transactionId: null,
				pluginId,
				receipt: null,
				reason: reason("operation-in-progress", "Integrity check, repair, or cleanup is already active."),
			});
		}
		if (!this.canUseEvidence(pluginId, run.runId)) {
			return Promise.resolve({
				status: "blocked",
				transactionId: null,
				pluginId,
				receipt: null,
				reason: reason("fresh-check-required", "Run a new full integrity check before repairing this plugin again."),
			});
		}
		this.operation = "repairing";
		this.activePluginId = pluginId;
		this.emit();
		const promise = this.engine.repair(run, pluginId).then(result => {
			this.latestRepair = result;
			if (["stale", "error", "rolled-back", "needs-attention"].includes(result.status)) {
				this.invalidatedEvidence.set(pluginId, run.runId);
			}
			return result;
		}).finally(() => {
			this.operation = "idle";
			this.activePluginId = null;
			this.activePromise = null;
			this.emit();
		});
		this.activePromise = promise;
		return promise;
	}

	cleanup(transactionId: string, approved: boolean): Promise<BackupCleanupResult> {
		if (this.activePromise !== null || this.isCheckRunning()) {
			return Promise.resolve({ status: "blocked", reason: reason("operation-in-progress", "Integrity check, repair, or cleanup is already active.") });
		}
		this.operation = "cleaning-up";
		this.emit();
		const promise = deleteVerifiedBackups(
			this.journal,
			transactionId,
			this.cleanupAdapter,
			this.repairRootPath,
			approved,
		).then(result => {
			this.latestCleanup = result;
			return result;
		}).finally(() => {
			this.operation = "idle";
			this.activePromise = null;
			this.emit();
		});
		this.activePromise = promise;
		return promise;
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}
