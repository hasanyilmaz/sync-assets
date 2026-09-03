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
	private settingsWindowOpen = false;
	private settingsFollowUpCompleted = false;
	private observedSettingsSignature: string | null = null;
	private baseline: string | null = null;
	private readonly cancellations = new Set<() => void>();
	private stabilityCancellation: (() => void) | null = null;
	private settingsStabilityCancellation: (() => void) | null = null;

	constructor(private readonly dependencies: StartupLocalFollowUpDependencies) {}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.settingsWindowOpen = true;
		const state = this.dependencies.getSettingsState();
		this.observedSettingsSignature = settingsSignature(state);
		if (isEligible(state)) {
			void this.primeBaseline();
		}
		for (const delayMs of STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS) {
			this.addSchedule(() => {
				void this.inspectAtDeadline().finally(() => {
					if (delayMs === STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS.at(-1)) {
						this.settingsWindowOpen = false;
					}
				});
			}, delayMs);
		}
	}

	notifySettingsChanged(): void {
		if (
			!this.started
			|| this.stopped
			|| !this.settingsWindowOpen
			|| this.settingsFollowUpCompleted
		) {
			return;
		}
		const state = this.dependencies.getSettingsState();
		const candidate = settingsSignature(state);
		if (candidate === this.observedSettingsSignature) {
			return;
		}
		this.observedSettingsSignature = candidate;
		this.settingsStabilityCancellation?.();
		this.settingsStabilityCancellation = null;
		if (!isEligible(state)) {
			this.baseline = null;
			return;
		}
		this.scheduleSettingsConfirmation(candidate);
	}

	stop(): void {
		this.stopped = true;
		this.stabilityCancellation?.();
		this.stabilityCancellation = null;
		this.settingsStabilityCancellation?.();
		this.settingsStabilityCancellation = null;
		for (const cancel of this.cancellations) {
			cancel();
		}
		this.cancellations.clear();
	}

	private scheduleSettingsConfirmation(candidate: string): void {
		this.settingsStabilityCancellation = this.dependencies.schedule(() => {
			this.settingsStabilityCancellation = null;
			void this.confirmStableSettings(candidate);
		}, STARTUP_LOCAL_STABILITY_DELAY_MS);
	}

	private async confirmStableSettings(candidate: string): Promise<void> {
		if (this.stopped || this.settingsFollowUpCompleted) {
			return;
		}
		const state = this.dependencies.getSettingsState();
		if (!isEligible(state) || settingsSignature(state) !== candidate) {
			return;
		}
		if (this.dependencies.isBusy()) {
			this.scheduleSettingsConfirmation(candidate);
			return;
		}
		try {
			const run = await this.dependencies.runFullCheck();
			if (!this.stopped && run !== null) {
				this.settingsFollowUpCompleted = true;
				this.baseline = await this.safeProbe();
			} else if (!this.stopped) {
				const current = this.dependencies.getSettingsState();
				if (isEligible(current) && settingsSignature(current) === candidate) {
					this.scheduleSettingsConfirmation(candidate);
				}
			}
		} catch {
			// Startup follow-ups are best-effort and must not create an unhandled task.
		}
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

function settingsSignature(state: SettingsState): string {
	return JSON.stringify({
		valid: state.issues.length === 0,
		startupCheckEnabled: state.settings.startupCheckEnabled,
		repositories: state.settings.repositories.map(mapping => ({
			pluginId: mapping.pluginId,
			owner: mapping.repository.owner,
			repo: mapping.repository.repo,
		})),
	});
}
