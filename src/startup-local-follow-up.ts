import type { IntegrityCheckRun } from "./check-coordinator";
import type { SettingsState } from "./settings-controller";

export const STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS = [60_000, 120_000, 180_000] as const;
export const STARTUP_LOCAL_STABILITY_DELAY_MS = 5_000;

export type FollowUpSchedule = (
	callback: () => void,
	delayMs: number,
) => () => void;

export interface StartupLocalFollowUpDependencies {
	readonly getSettingsState: () => SettingsState;
	readonly probe: () => Promise<string | null>;
	readonly isBusy: () => boolean;
	readonly runFullCheck: () => Promise<IntegrityCheckRun | null>;
	readonly schedule: FollowUpSchedule;
}

function isEligible(state: SettingsState): boolean {
	return state.issues.length === 0
		&& state.settings.startupCheckEnabled
		&& state.settings.repositories.length > 0;
}

export class StartupLocalFollowUpController {
	private started = false;
	private stopped = false;
	private baseline: string | null = null;
	private readonly cancellations = new Set<() => void>();
	private stabilityCancellation: (() => void) | null = null;

	constructor(private readonly dependencies: StartupLocalFollowUpDependencies) {}

	start(): void {
		if (this.started || !isEligible(this.dependencies.getSettingsState())) {
			return;
		}
		this.started = true;
		void this.primeBaseline();
		for (const delayMs of STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS) {
			this.addSchedule(() => {
				void this.inspectAtDeadline();
			}, delayMs);
		}
	}

	stop(): void {
		this.stopped = true;
		this.stabilityCancellation?.();
		this.stabilityCancellation = null;
		for (const cancel of this.cancellations) {
			cancel();
		}
		this.cancellations.clear();
	}

	private addSchedule(callback: () => void, delayMs: number): void {
		let cancel = (): void => {};
		cancel = this.dependencies.schedule(() => {
			this.cancellations.delete(cancel);
			callback();
		}, delayMs);
		this.cancellations.add(cancel);
	}

	private async primeBaseline(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.baseline = await this.safeProbe();
	}

	private async inspectAtDeadline(): Promise<void> {
		if (
			this.stopped
			|| !isEligible(this.dependencies.getSettingsState())
			|| this.dependencies.isBusy()
		) {
			return;
		}
		const candidate = await this.safeProbe();
		if (this.stopped || candidate === null) {
			return;
		}
		if (this.baseline === null) {
			this.baseline = candidate;
			return;
		}
		if (candidate === this.baseline || this.stabilityCancellation !== null) {
			return;
		}
		this.stabilityCancellation = this.dependencies.schedule(() => {
			this.stabilityCancellation = null;
			void this.confirmStableChange(candidate);
		}, STARTUP_LOCAL_STABILITY_DELAY_MS);
	}

	private async confirmStableChange(candidate: string): Promise<void> {
		if (
			this.stopped
			|| !isEligible(this.dependencies.getSettingsState())
			|| this.dependencies.isBusy()
		) {
			return;
		}
		const confirmed = await this.safeProbe();
		if (
			this.stopped
			|| confirmed === null
			|| confirmed !== candidate
			|| confirmed === this.baseline
		) {
			return;
		}
		this.baseline = confirmed;
		try {
			await this.dependencies.runFullCheck();
		} catch {
			// Startup follow-ups are best-effort and must not create an unhandled task.
		}
	}

	private async safeProbe(): Promise<string | null> {
		try {
			return await this.dependencies.probe();
		} catch {
			return null;
		}
	}
}
