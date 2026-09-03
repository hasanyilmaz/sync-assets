import { describe, expect, it } from "vitest";

import {
	IntegrityCheckCoordinator,
	type CheckPipelineDependencies,
} from "../src/check-coordinator";
import type { IntegrityVerificationBatch } from "../src/integrity-verification";
import type { LocalDiscoveryResult } from "../src/local-discovery";
import type { RemoteResolutionBatch } from "../src/remote-release";
import { createDefaultSettings } from "../src/settings";

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

function dependencies(calls: string[]): CheckPipelineDependencies {
	let now = 100;
	return {
		discover: (settings): Promise<LocalDiscoveryResult> => {
			calls.push(`discover:${settings.repositories.length}`);
			return Promise.resolve(DISCOVERY);
		},
		resolve: (discovery): Promise<RemoteResolutionBatch> => {
			calls.push(`resolve:${discovery.status}`);
			return Promise.resolve(REMOTE);
		},
		verify: (discovery, remote): Promise<IntegrityVerificationBatch> => {
			calls.push(`verify:${discovery.status}:${remote.status}`);
			return Promise.resolve(VERIFICATION);
		},
		now: (): number => {
			now += 1;
			return now;
		},
	};
}

describe("integrity check coordinator", () => {
	it("does no work before an explicit run and executes each stage in order", async () => {
		const calls: string[] = [];
		const coordinator = new IntegrityCheckCoordinator(dependencies(calls));
		const phases: string[] = [];
		coordinator.subscribe(snapshot => {
			phases.push(snapshot.phase);
		});

		expect(calls).toEqual([]);
		expect(coordinator.getSnapshot().phase).toBe("idle");

		const run = await coordinator.run(createDefaultSettings());

		expect(calls).toEqual([
			"discover:0",
			"resolve:completed",
			"verify:completed:completed",
		]);
		expect(phases).toEqual(expect.arrayContaining([
			"idle",
			"discovering",
			"resolving",
			"verifying",
			"completed",
		]));
		expect(run).toEqual(expect.objectContaining({
			runId: 1,
			trigger: "manual",
			status: "completed",
			discovery: DISCOVERY,
			remote: REMOTE,
			verification: VERIFICATION,
		}));
	});

	it("returns the same active promise and permits a new run after completion", async () => {
		let releaseDiscovery = (value: LocalDiscoveryResult): void => {
			void value;
			throw new Error("Discovery promise was not created.");
		};
		let discoveryCalls = 0;
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => {
				discoveryCalls += 1;
				return new Promise(resolve => {
					releaseDiscovery = resolve;
				});
			},
			resolve: (): Promise<RemoteResolutionBatch> => Promise.resolve(REMOTE),
			verify: (): Promise<IntegrityVerificationBatch> => Promise.resolve(VERIFICATION),
		});

		const first = coordinator.run(createDefaultSettings());
		const second = coordinator.run(createDefaultSettings());
		expect(second).toBe(first);
		await Promise.resolve();
		expect(discoveryCalls).toBe(1);
		releaseDiscovery(DISCOVERY);
		await first;
		await Promise.resolve();

		const third = coordinator.run(createDefaultSettings());
		expect(third).not.toBe(first);
		await Promise.resolve();
		expect(discoveryCalls).toBe(2);
		releaseDiscovery(DISCOVERY);
		await third;
	});

	it("captures unexpected stage failures without continuing the pipeline", async () => {
		const calls: string[] = [];
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => Promise.reject(new Error("adapter failed")),
			resolve: (): Promise<RemoteResolutionBatch> => {
				calls.push("resolve");
				return Promise.resolve(REMOTE);
			},
			verify: (): Promise<IntegrityVerificationBatch> => {
				calls.push("verify");
				return Promise.resolve(VERIFICATION);
			},
		});

		const run = await coordinator.run(createDefaultSettings(), [{
			code: "settings-warning",
			path: "",
			message: "Safe defaults active.",
		}]);

		expect(run.status).toBe("failed");
		expect(run.reason?.code).toBe("integrity-check-error");
		expect(run.settingsIssues[0]?.message).toBe("Safe defaults active.");
		expect(calls).toEqual([]);
		expect(coordinator.getSnapshot().phase).toBe("failed");
	});

	it("treats a structured verification batch error as a failed run", async () => {
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => Promise.resolve(DISCOVERY),
			resolve: (): Promise<RemoteResolutionBatch> => Promise.resolve(REMOTE),
			verify: (): Promise<IntegrityVerificationBatch> => Promise.resolve({
				status: "error",
				records: [],
				reason: { code: "correlation-error", message: "Records differ." },
			}),
		});

		const run = await coordinator.run(createDefaultSettings());

		expect(run.status).toBe("failed");
		expect(run.reason?.code).toBe("correlation-error");
	});

	it("discards a late stage completion after disposal without publishing state", async () => {
		let finishDiscovery!: (value: LocalDiscoveryResult) => void;
		let resolveCalls = 0;
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => new Promise(resolve => {
				finishDiscovery = resolve;
			}),
			resolve: (): Promise<RemoteResolutionBatch> => {
				resolveCalls += 1;
				return Promise.resolve(REMOTE);
			},
			verify: (): Promise<IntegrityVerificationBatch> => Promise.resolve(VERIFICATION),
		});
		const snapshots: string[] = [];
		coordinator.subscribe(snapshot => {
			snapshots.push(`${snapshot.phase}:${snapshot.latestRun?.status ?? "none"}`);
		});

		const pending = coordinator.run(createDefaultSettings());
		await Promise.resolve();
		coordinator.dispose();
		finishDiscovery(DISCOVERY);
		const run = await pending;

		expect(run.status).toBe("cancelled");
		expect(run.reason?.code).toBe("integrity-check-cancelled");
		expect(resolveCalls).toBe(0);
		expect(coordinator.getSnapshot()).toEqual({
			phase: "idle",
			activeRunId: null,
			latestRun: null,
			progressLabel: null,
		});
		expect(snapshots.at(-1)).toBe("discovering:none");
	});

	it("publishes active plugin and file progress only during verification", async () => {
		const labels: Array<string | null> = [];
		const coordinator = new IntegrityCheckCoordinator({
			discover: (): Promise<LocalDiscoveryResult> => Promise.resolve(DISCOVERY),
			resolve: (): Promise<RemoteResolutionBatch> => Promise.resolve(REMOTE),
			verify: (_discovery, _remote, reportProgress): Promise<IntegrityVerificationBatch> => {
				reportProgress("Verifying operon: main.js…");
				reportProgress("Verifying operon: manifest.json…");
				return Promise.resolve(VERIFICATION);
			},
		});
		coordinator.subscribe(snapshot => {
			labels.push(snapshot.progressLabel);
		});

		await coordinator.run(createDefaultSettings());

		expect(labels).toContain("Verifying operon: main.js…");
		expect(labels).toContain("Verifying operon: manifest.json…");
		expect(coordinator.getSnapshot().progressLabel).toBeNull();
	});
});
