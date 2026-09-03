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

export type StartupRunDisposition =
	| { readonly disposition: "none" }
	| { readonly disposition: "notice"; readonly message: string }
	| {
		readonly disposition: "modal";
		readonly summary: StartupAttentionSummary;
	};

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

function buildStartupAttentionSummary(
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

export function buildStartupRunDisposition(
	run: IntegrityCheckRun,
): StartupRunDisposition {
	if (run.status === "cancelled") {
		return { disposition: "none" };
	}
	const presentation = buildCheckPresentation(run);
	const actionablePlugins = presentation.groups.flatMap(group => (
		["repair-available", "needs-attention", "configured-missing"].includes(group.id)
			? group.plugins
			: []
	));
	const availabilityOnly = run.status !== "failed"
		&& presentation.reasonCode === null
		&& presentation.settingsWarnings.length === 0
		&& actionablePlugins.length > 0
		&& actionablePlugins.every(plugin => (
			plugin.remoteFailureKind !== null
			&& ["connection", "timeout", "temporary-server", "rate-limit"]
				.includes(plugin.remoteFailureKind)
		));
	if (availabilityOnly) {
		return {
			disposition: "notice",
			message: "Sync Assets couldn't check monitored plugins because GitHub is unavailable. Check your connection and try again later.",
		};
	}

	const summary = buildStartupAttentionSummary(run);
	return summary === null
		? { disposition: "none" }
		: { disposition: "modal", summary };
}
