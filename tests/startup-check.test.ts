import { describe, expect, it } from "vitest";

import {
	IntegrityCheckCoordinator,
	type CheckPipelineDependencies,
	type IntegrityCheckRun,
} from "../src/check-coordinator";
import type { IntegrityVerificationBatch } from "../src/integrity-verification";
import type { LocalDiscoveryResult } from "../src/local-discovery";
import type { RemoteResolutionBatch } from "../src/remote-release";
import type { SettingsState } from "../src/settings-controller";
import {
	buildStartupAttentionSummary,
	StartupCheckController,
} from "../src/startup-check";
import { createRepairFixture } from "./repair-fixtures";

const DISCOVERY: LocalDiscoveryResult = {
	status: "completed",
	pluginRoot: ".obsidian/plugins",
	plugins: [],
	issues: [],
};

const REMOTE: RemoteResolutionBatch = {
	status: "completed",
	records: [],
	requestCount: 0,
	rateLimit: null,
	reason: null,
};

const VERIFICATION: IntegrityVerificationBatch = {
	status: "completed",
	records: [],
	reason: null,
};

function state(
	startupCheckEnabled: boolean,
	repositories = startupCheckEnabled
		? [{ pluginId: "example-plugin", repository: { owner: "example", repo: "plugin" } }]
		: [],
	issues: SettingsState["issues"] = [],
): SettingsState {
	return {
		settings: { schemaVersion: 2, startupCheckEnabled, repositories },
		issues,
		usedDefaults: false,
	};
}

function dependencies(calls: string[]): CheckPipelineDependencies {
	return {
		discover: (): Promise<LocalDiscoveryResult> => {
			calls.push("discover");
			return Promise.resolve(DISCOVERY);
		},
		resolve: (): Promise<RemoteResolutionBatch> => {
			calls.push("resolve");
			return Promise.resolve(REMOTE);
		},
		verify: (): Promise<IntegrityVerificationBatch> => {
			calls.push("verify");
			return Promise.resolve(VERIFICATION);
		},
	};
}

describe("startup integrity check", () => {
	it.each([
		["disabled", state(false), "disabled"],
		["invalid settings", state(true, undefined, [{ code: "invalid", path: "", message: "Invalid." }]), "invalid-settings"],
		["no mappings", state(true, []), "no-repositories"],
	] as const)("does no pipeline work for %s", async (_label, settings, expectedReason) => {
		const calls: string[] = [];
		const controller = new StartupCheckController(
			new IntegrityCheckCoordinator(dependencies(calls)),
			() => settings,
		);
		const outcome = await controller.runAfterLayoutReady();
		expect(outcome).toEqual({ status: "skipped", reason: expectedReason });
		expect(calls).toEqual([]);
	});

	it("runs the complete pipeline once with a startup trigger", async () => {
		const calls: string[] = [];
		const coordinator = new IntegrityCheckCoordinator(dependencies(calls));
		const controller = new StartupCheckController(coordinator, () => state(true));

		const first = await controller.runAfterLayoutReady();
		const second = await controller.runAfterLayoutReady();

		expect(first.status).toBe("completed");
		if (first.status === "completed") {
			expect(first.run.trigger).toBe("startup");
		}
		expect(second).toEqual({ status: "skipped", reason: "already-attempted" });
		expect(calls).toEqual(["discover", "resolve", "verify"]);
	});

	it("lets a manual intent before layout suppress startup", async () => {
		const calls: string[] = [];
		const controller = new StartupCheckController(
			new IntegrityCheckCoordinator(dependencies(calls)),
			() => state(true),
		);
		controller.markManualIntent();
		expect(await controller.runAfterLayoutReady()).toEqual({
			status: "skipped",
			reason: "manual-superseded",
		});
		expect(calls).toEqual([]);
	});

	it("keeps the startup identity when a manual request joins its active single flight", async () => {
		let finishDiscovery!: (value: LocalDiscoveryResult) => void;
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => new Promise(resolve => {
				finishDiscovery = resolve;
			}),
			resolve: (): Promise<RemoteResolutionBatch> => Promise.resolve(REMOTE),
			verify: (): Promise<IntegrityVerificationBatch> => Promise.resolve(VERIFICATION),
		});
		const controller = new StartupCheckController(coordinator, () => state(true));
		const startup = controller.runAfterLayoutReady();
		await Promise.resolve();
		const joined = coordinator.run(state(true).settings, [], "manual");
		finishDiscovery(DISCOVERY);
		const [startupOutcome, joinedRun] = await Promise.all([startup, joined]);
		expect(startupOutcome.status).toBe("completed");
		expect(joinedRun.trigger).toBe("startup");
		expect(joinedRun.runId).toBe(1);
	});

	it("stays silent for healthy or empty results and summarizes actionable startup findings", async () => {
		const emptyRun: IntegrityCheckRun = {
			runId: 1,
			trigger: "startup",
			status: "completed",
			startedAtMs: 1,
			finishedAtMs: 2,
			settingsIssues: [],
			discovery: DISCOVERY,
			remote: REMOTE,
			verification: VERIFICATION,
			reason: null,
		};
		expect(buildStartupAttentionSummary(emptyRun)).toBeNull();

		const fixture = await createRepairFixture();
		const repairRun: IntegrityCheckRun = { ...fixture.run, trigger: "startup" };
		expect(buildStartupAttentionSummary(repairRun)).toEqual(expect.objectContaining({
			failed: false,
			repairAvailable: 1,
			needsAttention: 0,
			configuredMissing: 0,
		}));
		const failed = buildStartupAttentionSummary({
			...emptyRun,
			status: "failed",
			reason: { code: "failed", message: "Failed." },
		});
		expect(failed?.failed).toBe(true);
		expect(failed?.message).toContain("check failed");
	});

	it("ignores unmapped plugins but reports deferrals and configured-missing targets", async () => {
		const fixture = await createRepairFixture();
		const local = fixture.run.discovery?.plugins[0];
		if (local?.status !== "discovered") {
			throw new Error("Discovery fixture missing.");
		}
		const repositoryNotConfigured = {
			code: "repository-not-configured",
			message: "Repository is not configured.",
		};
		const unmapped: IntegrityCheckRun = {
			...fixture.run,
			trigger: "startup",
			discovery: {
				...fixture.run.discovery!,
				plugins: [{ ...local, repository: null }],
			},
			remote: {
				status: "completed",
				records: [{
					status: "skipped",
					pluginId: local.pluginId,
					repository: null,
					manifestVersion: local.manifest.version,
					requestCount: 0,
					rateLimit: null,
					release: null,
					reason: repositoryNotConfigured,
					retryAtMs: null,
				}],
				requestCount: 0,
				rateLimit: null,
				reason: null,
			},
			verification: {
				status: "completed",
				records: [{
					outcome: "blocked",
					pluginId: local.pluginId,
					repository: null,
					manifestVersion: local.manifest.version,
					status: "unsupported",
					sourceRemoteStatus: "skipped",
					result: null,
					reason: repositoryNotConfigured,
					retryAtMs: null,
				}],
				reason: null,
			},
		};
		expect(buildStartupAttentionSummary(unmapped)).toBeNull();

		const rateLimitReason = { code: "github-rate-limit-exhausted", message: "Deferred." };
		const deferred: IntegrityCheckRun = {
			...fixture.run,
			trigger: "startup",
			remote: {
				status: "partial",
				records: [{
					status: "deferred",
					pluginId: local.pluginId,
					repository: local.repository!,
					manifestVersion: local.manifest.version,
					requestCount: 0,
					rateLimit: { limit: 60, remaining: 0, resetAtMs: 2_000_000, retryAtMs: 2_000_000 },
					release: null,
					reason: rateLimitReason,
					retryAtMs: 2_000_000,
				}],
				requestCount: 0,
				rateLimit: { limit: 60, remaining: 0, resetAtMs: 2_000_000, retryAtMs: 2_000_000 },
				reason: null,
			},
			verification: {
				status: "partial",
				records: [{
					outcome: "blocked",
					pluginId: local.pluginId,
					repository: local.repository!,
					manifestVersion: local.manifest.version,
					status: "unverifiable",
					sourceRemoteStatus: "deferred",
					result: null,
					reason: rateLimitReason,
					retryAtMs: 2_000_000,
				}],
				reason: null,
			},
		};
		expect(buildStartupAttentionSummary(deferred)?.needsAttention).toBe(1);

		const missingReason = { code: "configured-plugin-missing", message: "Missing." };
		const configuredMissing: IntegrityCheckRun = {
			...fixture.run,
			trigger: "startup",
			discovery: {
				...fixture.run.discovery!,
				plugins: [{
					status: "configured-missing",
					pluginId: local.pluginId,
					pluginPath: local.pluginPath,
					repository: local.repository!,
					manifest: null,
					artifacts: [],
					reason: missingReason,
				}],
			},
			remote: {
				status: "completed",
				records: [{
					status: "skipped",
					pluginId: local.pluginId,
					repository: local.repository!,
					manifestVersion: null,
					requestCount: 0,
					rateLimit: null,
					release: null,
					reason: missingReason,
					retryAtMs: null,
				}],
				requestCount: 0,
				rateLimit: null,
				reason: null,
			},
			verification: {
				status: "completed",
				records: [{
					outcome: "blocked",
					pluginId: local.pluginId,
					repository: local.repository!,
					manifestVersion: null,
					status: "unverifiable",
					sourceRemoteStatus: "skipped",
					result: null,
					reason: missingReason,
					retryAtMs: null,
				}],
				reason: null,
			},
		};
		expect(buildStartupAttentionSummary(configuredMissing)?.configuredMissing).toBe(1);
	});
});
