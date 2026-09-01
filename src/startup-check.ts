import {
	IntegrityCheckCoordinator,
	type IntegrityCheckRun,
} from "./check-coordinator";
import { buildCheckPresentation } from "./check-presentation";
import type { SettingsState } from "./settings-controller";

export type StartupCheckSkipReason =
	| "already-attempted"
	| "disabled"
	| "invalid-settings"
	| "no-repositories"
	| "manual-superseded";

export type StartupCheckOutcome =
	| { readonly status: "completed"; readonly run: IntegrityCheckRun }
	| { readonly status: "skipped"; readonly reason: StartupCheckSkipReason };

export interface StartupAttentionSummary {
	readonly failed: boolean;
	readonly repairAvailable: number;
	readonly needsAttention: number;
	readonly configuredMissing: number;
	readonly message: string;
}

export class StartupCheckController {
	private attempted = false;
	private manualIntent = false;

	constructor(
		private readonly coordinator: IntegrityCheckCoordinator,
		private readonly getSettingsState: () => SettingsState,
	) {}

	markManualIntent(): void {
		this.manualIntent = true;
	}

	hasAttempted(): boolean {
		return this.attempted;
	}

	runAfterLayoutReady(): Promise<StartupCheckOutcome> {
		if (this.attempted) {
			return Promise.resolve({ status: "skipped", reason: "already-attempted" });
		}
		this.attempted = true;
		const snapshot = this.coordinator.getSnapshot();
		if (this.manualIntent || snapshot.activeRunId !== null || snapshot.latestRun !== null) {
			return Promise.resolve({ status: "skipped", reason: "manual-superseded" });
		}
		const state = this.getSettingsState();
		if (state.issues.length > 0) {
			return Promise.resolve({ status: "skipped", reason: "invalid-settings" });
		}
		if (!state.settings.startupCheckEnabled) {
			return Promise.resolve({ status: "skipped", reason: "disabled" });
		}
		if (state.settings.repositories.length === 0) {
			return Promise.resolve({ status: "skipped", reason: "no-repositories" });
		}
		return this.coordinator.run(state.settings, state.issues, "startup").then(run => ({
			status: "completed" as const,
			run,
		}));
	}
}

export function buildStartupAttentionSummary(
	run: IntegrityCheckRun,
): StartupAttentionSummary | null {
	const presentation = buildCheckPresentation(run);
	const count = (id: "repair-available" | "needs-attention" | "configured-missing"): number => (
		presentation.groups.find(group => group.id === id)?.plugins.length ?? 0
	);
	const repairAvailable = count("repair-available");
	const needsAttention = count("needs-attention");
	const configuredMissing = count("configured-missing");
	const failed = run.status === "failed";
	if (!failed && repairAvailable === 0 && needsAttention === 0 && configuredMissing === 0) {
		return null;
	}
	const parts: string[] = [];
	if (failed) {
		parts.push("check failed");
	}
	if (repairAvailable > 0) {
		parts.push(`${repairAvailable} repair available`);
	}
	if (needsAttention > 0) {
		parts.push(`${needsAttention} need attention`);
	}
	if (configuredMissing > 0) {
		parts.push(`${configuredMissing} configured but missing`);
	}
	return {
		failed,
		repairAvailable,
		needsAttention,
		configuredMissing,
		message: `Sync Assets startup check: ${parts.join("; ")}.`,
	};
}
