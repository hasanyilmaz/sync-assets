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
	readonly status: "completed" | "failed";
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
}

export interface CheckPipelineDependencies {
	readonly discover: (settings: SyncAssetsSettings) => Promise<LocalDiscoveryResult>;
	readonly resolve: (discovery: LocalDiscoveryResult) => Promise<RemoteResolutionBatch>;
	readonly verify: (
		discovery: LocalDiscoveryResult,
		remote: RemoteResolutionBatch,
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
	private nextRunId = 1;
	private readonly listeners = new Set<CheckCoordinatorListener>();

	constructor(private readonly dependencies: CheckPipelineDependencies) {}

	getSnapshot(): CheckCoordinatorSnapshot {
		return {
			phase: this.phase,
			activeRunId: this.activeRunId,
			latestRun: this.latestRun,
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
		if (this.activePromise !== null) {
			return this.activePromise;
		}

		const runId = this.nextRunId;
		this.nextRunId += 1;
		this.activeRunId = runId;
		const promise = Promise.resolve().then(() => this.execute(
			runId,
			trigger,
			cloneSettings(settings),
			[...settingsIssues],
		));
		this.activePromise = promise;
		void promise.finally(() => {
			if (this.activePromise === promise) {
				this.activePromise = null;
				this.activeRunId = null;
				this.emit();
			}
		});
		return promise;
	}

	private async execute(
		runId: number,
		trigger: CheckTrigger,
		settings: SyncAssetsSettings,
		settingsIssues: readonly ValidationIssue[],
	): Promise<IntegrityCheckRun> {
		const now = this.dependencies.now ?? Date.now;
		const startedAtMs = now();
		let discovery: LocalDiscoveryResult | null = null;
		let remote: RemoteResolutionBatch | null = null;
		let verification: IntegrityVerificationBatch | null = null;

		try {
			this.setPhase("discovering");
			discovery = await this.dependencies.discover(settings);
			this.setPhase("resolving");
			remote = await this.dependencies.resolve(discovery);
			this.setPhase("verifying");
			verification = await this.dependencies.verify(discovery, remote);

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

	private setPhase(phase: CheckPhase): void {
		this.phase = phase;
		this.emit();
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
