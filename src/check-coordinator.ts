import type { IntegrityReason } from "./domain";
import type { IntegrityVerificationBatch } from "./integrity-verification";
import type { LocalDiscoveryResult } from "./local-discovery";
import type { RemoteResolutionBatch } from "./remote-release";
import type { ValidationIssue } from "./security";
import type { SyncAssetsSettings } from "./settings";

export const CHECK_PHASES = [
	"idle",
	"discovering",
	"resolving",
	"verifying",
	"completed",
	"failed",
] as const;

export type CheckPhase = (typeof CHECK_PHASES)[number];

export const CHECK_TRIGGERS = ["manual", "startup"] as const;
export type CheckTrigger = (typeof CHECK_TRIGGERS)[number];

export interface IntegrityCheckRun {
	readonly runId: number;
	readonly trigger: CheckTrigger;
	readonly status: "completed" | "failed" | "cancelled";
	readonly startedAtMs: number;
	readonly finishedAtMs: number;
	readonly settingsIssues: readonly ValidationIssue[];
	readonly discovery: LocalDiscoveryResult | null;
	readonly remote: RemoteResolutionBatch | null;
	readonly verification: IntegrityVerificationBatch | null;
	readonly reason: IntegrityReason | null;
}

export interface CheckCoordinatorSnapshot {
	readonly phase: CheckPhase;
	readonly activeRunId: number | null;
	readonly latestRun: IntegrityCheckRun | null;
	readonly progressLabel: string | null;
}

export interface CheckPipelineDependencies {
	readonly discover: (settings: SyncAssetsSettings) => Promise<LocalDiscoveryResult>;
	readonly resolve: (discovery: LocalDiscoveryResult) => Promise<RemoteResolutionBatch>;
	readonly verify: (
		discovery: LocalDiscoveryResult,
		remote: RemoteResolutionBatch,
		reportProgress: (label: string) => void,
	) => Promise<IntegrityVerificationBatch>;
	readonly now?: () => number;
}

export type CheckCoordinatorListener = (
	snapshot: CheckCoordinatorSnapshot,
) => void;

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown integrity check error.";
}

function cloneSettings(settings: SyncAssetsSettings): SyncAssetsSettings {
	return {
		schemaVersion: settings.schemaVersion,
		startupCheckEnabled: settings.startupCheckEnabled,
		repositories: settings.repositories.map(mapping => ({
			pluginId: mapping.pluginId,
			repository: { ...mapping.repository },
		})),
	};
}

export class IntegrityCheckCoordinator {
	private phase: CheckPhase = "idle";
	private activePromise: Promise<IntegrityCheckRun> | null = null;
	private activeRunId: number | null = null;
	private latestRun: IntegrityCheckRun | null = null;
	private progressLabel: string | null = null;
	private nextRunId = 1;
	private lifecycleGeneration = 0;
	private disposed = false;
	private readonly listeners = new Set<CheckCoordinatorListener>();

	constructor(private readonly dependencies: CheckPipelineDependencies) {}

	getSnapshot(): CheckCoordinatorSnapshot {
		return {
			phase: this.phase,
			activeRunId: this.activeRunId,
			latestRun: this.latestRun,
			progressLabel: this.progressLabel,
		};
	}

	subscribe(listener: CheckCoordinatorListener): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	run(
		settings: SyncAssetsSettings,
		settingsIssues: readonly ValidationIssue[] = [],
		trigger: CheckTrigger = "manual",
	): Promise<IntegrityCheckRun> {
		if (this.disposed) {
			return Promise.resolve(this.cancelledRun(
				this.nextRunId,
				trigger,
				[...settingsIssues],
			));
		}
		if (this.activePromise !== null) {
			return this.activePromise;
		}

		const runId = this.nextRunId;
		this.nextRunId += 1;
		this.activeRunId = runId;
		const lifecycleGeneration = this.lifecycleGeneration;
		const promise = Promise.resolve().then(() => this.execute(
			runId,
			trigger,
			cloneSettings(settings),
			[...settingsIssues],
			lifecycleGeneration,
		));
		this.activePromise = promise;
		void promise.finally(() => {
			if (
				this.activePromise === promise
				&& this.isCurrent(lifecycleGeneration)
			) {
				this.activePromise = null;
				this.activeRunId = null;
				this.emit();
			}
		});
		return promise;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.lifecycleGeneration += 1;
		this.activePromise = null;
		this.activeRunId = null;
		this.phase = "idle";
		this.progressLabel = null;
		this.listeners.clear();
	}

	private async execute(
		runId: number,
		trigger: CheckTrigger,
		settings: SyncAssetsSettings,
		settingsIssues: readonly ValidationIssue[],
		lifecycleGeneration: number,
	): Promise<IntegrityCheckRun> {
		const now = this.dependencies.now ?? Date.now;
		const startedAtMs = now();
		let discovery: LocalDiscoveryResult | null = null;
		let remote: RemoteResolutionBatch | null = null;
		let verification: IntegrityVerificationBatch | null = null;

		try {
			this.setPhase("discovering");
			discovery = await this.dependencies.discover(settings);
			if (!this.isCurrent(lifecycleGeneration)) {
				return this.cancelledRun(runId, trigger, settingsIssues, startedAtMs, discovery);
			}
			this.setPhase("resolving");
			remote = await this.dependencies.resolve(discovery);
			if (!this.isCurrent(lifecycleGeneration)) {
				return this.cancelledRun(runId, trigger, settingsIssues, startedAtMs, discovery, remote);
			}
			this.setPhase("verifying");
			verification = await this.dependencies.verify(
				discovery,
				remote,
				label => {
					if (this.isCurrent(lifecycleGeneration) && this.phase === "verifying") {
						this.progressLabel = label;
						this.emit();
					}
				},
			);
			if (!this.isCurrent(lifecycleGeneration)) {
				return this.cancelledRun(runId, trigger, settingsIssues, startedAtMs, discovery, remote, verification);
			}

			const failed = verification.status === "error";
			const run: IntegrityCheckRun = {
				runId,
				trigger,
				status: failed ? "failed" : "completed",
				startedAtMs,
				finishedAtMs: now(),
				settingsIssues,
				discovery,
				remote,
				verification,
				reason: failed
					? verification.reason ?? reason(
						"integrity-check-failed",
						"Integrity verification failed without a structured reason.",
					)
					: null,
			};
			this.latestRun = run;
			this.setPhase(failed ? "failed" : "completed");
			return run;
		} catch (error) {
			if (!this.isCurrent(lifecycleGeneration)) {
				return this.cancelledRun(runId, trigger, settingsIssues, startedAtMs, discovery, remote, verification);
			}
			const run: IntegrityCheckRun = {
				runId,
				trigger,
				status: "failed",
				startedAtMs,
				finishedAtMs: now(),
				settingsIssues,
				discovery,
				remote,
				verification,
				reason: reason(
					"integrity-check-error",
					`Integrity check failed unexpectedly: ${getErrorMessage(error)}`,
				),
			};
			this.latestRun = run;
			this.setPhase("failed");
			return run;
		}
	}

	private isCurrent(lifecycleGeneration: number): boolean {
		return !this.disposed && lifecycleGeneration === this.lifecycleGeneration;
	}

	private cancelledRun(
		runId: number,
		trigger: CheckTrigger,
		settingsIssues: readonly ValidationIssue[],
		startedAtMs = (this.dependencies.now ?? Date.now)(),
		discovery: LocalDiscoveryResult | null = null,
		remote: RemoteResolutionBatch | null = null,
		verification: IntegrityVerificationBatch | null = null,
	): IntegrityCheckRun {
		return {
			runId,
			trigger,
			status: "cancelled",
			startedAtMs,
			finishedAtMs: (this.dependencies.now ?? Date.now)(),
			settingsIssues,
			discovery,
			remote,
			verification,
			reason: reason(
				"integrity-check-cancelled",
				"Integrity check was cancelled because the plugin lifecycle ended.",
			),
		};
	}

	private setPhase(phase: CheckPhase): void {
		this.phase = phase;
		this.progressLabel = null;
		this.emit();
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
