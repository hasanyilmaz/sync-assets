import { describe, expect, it } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import type { SettingsState } from "../src/settings-controller";
import {
	STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS,
	STARTUP_LOCAL_STABILITY_DELAY_MS,
	StartupLocalFollowUpController,
	type FollowUpSchedule,
} from "../src/startup-local-follow-up";

interface ScheduledTask {
	readonly callback: () => void;
	readonly delayMs: number;
	cancelled: boolean;
}

function settingsState(overrides: Partial<SettingsState> = {}): SettingsState {
	return {
		settings: {
			schemaVersion: 2,
			startupCheckEnabled: true,
			repositories: [{
				pluginId: "example-plugin",
				repository: { owner: "example", repo: "plugin" },
			}],
		},
		issues: [],
		usedDefaults: false,
		...overrides,
	};
}

function createScheduler(): {
	readonly tasks: ScheduledTask[];
	readonly schedule: FollowUpSchedule;
	runNext(delayMs: number): void;
} {
	const tasks: ScheduledTask[] = [];
	return {
		tasks,
		schedule(callback, delayMs) {
			const task = { callback, delayMs, cancelled: false };
			tasks.push(task);
			return () => {
				task.cancelled = true;
			};
		},
		runNext(delayMs): void {
			const task = tasks.find(candidate => (
				!candidate.cancelled && candidate.delayMs === delayMs
			));
			if (task === undefined) {
				throw new Error(`No pending ${delayMs} ms task.`);
			}
			task.cancelled = true;
			task.callback();
		},
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("startup local follow-up controller", () => {
	it("schedules local checks at minutes one, two, and three", async () => {
		const scheduler = createScheduler();
		let fullChecks = 0;
		const controller = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => settingsState(),
			probe: (): Promise<string | null> => Promise.resolve("same"),
			isBusy: (): boolean => false,
			runFullCheck: (): Promise<IntegrityCheckRun | null> => {
				fullChecks += 1;
				return Promise.resolve(null);
			},
			schedule: scheduler.schedule,
		});

		controller.start();
		await flush();

		expect(scheduler.tasks.map(task => task.delayMs)).toEqual(
			STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS,
		);
		for (const delayMs of STARTUP_LOCAL_FOLLOW_UP_DELAYS_MS) {
			scheduler.runNext(delayMs);
			await flush();
		}
		expect(fullChecks).toBe(0);
	});

	it("runs a full check only after a changed snapshot remains stable", async () => {
		const scheduler = createScheduler();
		const snapshots = ["initial", "changed", "changed"];
		let fullChecks = 0;
		const controller = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => settingsState(),
			probe: (): Promise<string | null> => Promise.resolve(snapshots.shift() ?? "changed"),
			isBusy: (): boolean => false,
			runFullCheck: (): Promise<IntegrityCheckRun | null> => {
				fullChecks += 1;
				return Promise.resolve(null);
			},
			schedule: scheduler.schedule,
		});

		controller.start();
		await flush();
		scheduler.runNext(60_000);
		await flush();
		expect(fullChecks).toBe(0);
		expect(scheduler.tasks.some(task => (
			!task.cancelled && task.delayMs === STARTUP_LOCAL_STABILITY_DELAY_MS
		))).toBe(true);

		scheduler.runNext(STARTUP_LOCAL_STABILITY_DELAY_MS);
		await flush();
		expect(fullChecks).toBe(1);
	});

	it("waits for a later deadline when files are still changing", async () => {
		const scheduler = createScheduler();
		const snapshots = ["initial", "first-change", "second-change", "stable", "stable"];
		let fullChecks = 0;
		const controller = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => settingsState(),
			probe: (): Promise<string | null> => Promise.resolve(snapshots.shift() ?? "stable"),
			isBusy: (): boolean => false,
			runFullCheck: (): Promise<IntegrityCheckRun | null> => {
				fullChecks += 1;
				return Promise.resolve(null);
			},
			schedule: scheduler.schedule,
		});

		controller.start();
		await flush();
		scheduler.runNext(60_000);
		await flush();
		scheduler.runNext(STARTUP_LOCAL_STABILITY_DELAY_MS);
		await flush();
		expect(fullChecks).toBe(0);

		scheduler.runNext(120_000);
		await flush();
		scheduler.runNext(STARTUP_LOCAL_STABILITY_DELAY_MS);
		await flush();
		expect(fullChecks).toBe(1);
	});

	it("does nothing when disabled, invalid, or unconfigured", () => {
		for (const state of [
			settingsState({ settings: { ...settingsState().settings, startupCheckEnabled: false } }),
			settingsState({ issues: [{ code: "invalid", path: "", message: "Invalid." }] }),
			settingsState({ settings: { ...settingsState().settings, repositories: [] } }),
		]) {
			const scheduler = createScheduler();
			let probes = 0;
			new StartupLocalFollowUpController({
				getSettingsState: (): SettingsState => state,
				probe: (): Promise<string | null> => {
					probes += 1;
					return Promise.resolve("snapshot");
				},
				isBusy: (): boolean => false,
				runFullCheck: (): Promise<IntegrityCheckRun | null> => Promise.resolve(null),
				schedule: scheduler.schedule,
			}).start();
			expect(probes).toBe(0);
			expect(scheduler.tasks).toEqual([]);
		}
	});

	it("skips a busy deadline and cancels pending work on unload", async () => {
		const scheduler = createScheduler();
		let busy = true;
		let probes = 0;
		const controller = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => settingsState(),
			probe: (): Promise<string | null> => {
				probes += 1;
				return Promise.resolve(probes === 1 ? "initial" : "changed");
			},
			isBusy: (): boolean => busy,
			runFullCheck: (): Promise<IntegrityCheckRun | null> => Promise.resolve(null),
			schedule: scheduler.schedule,
		});

		controller.start();
		await flush();
		scheduler.runNext(60_000);
		await flush();
		expect(probes).toBe(1);

		busy = false;
		scheduler.runNext(120_000);
		await flush();
		controller.stop();
		expect(scheduler.tasks.filter(task => !task.cancelled)).toEqual([]);
	});

	it("fails closed when a probe or full check rejects", async () => {
		const scheduler = createScheduler();
		let call = 0;
		const controller = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => settingsState(),
			probe: (): Promise<string | null> => {
				call += 1;
				if (call === 1) {
					return Promise.resolve("initial");
				}
				if (call === 2) {
					return Promise.reject(new Error("probe failed"));
				}
				return Promise.resolve("changed");
			},
			isBusy: (): boolean => false,
			runFullCheck: (): Promise<IntegrityCheckRun | null> => Promise.reject(new Error("check failed")),
			schedule: scheduler.schedule,
		});

		controller.start();
		await flush();
		scheduler.runNext(60_000);
		await flush();
		scheduler.runNext(120_000);
		await flush();
		scheduler.runNext(STARTUP_LOCAL_STABILITY_DELAY_MS);
		await flush();
		expect(call).toBe(4);
	});
});
