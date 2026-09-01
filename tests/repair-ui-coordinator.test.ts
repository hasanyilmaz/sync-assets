import { describe, expect, it } from "vitest";

import {
	PersistentDataController,
	type SyncAssetsPersistedData,
} from "../src/persisted-state";
import { PersistentRepairJournal } from "../src/repair-lifecycle";
import {
	RepairUiCoordinator,
	type RepairRunner,
} from "../src/repair-ui-coordinator";
import type { RepairTransactionResult } from "../src/repair-transaction";
import {
	createRepairFixture,
	FakeRepairAdapter,
	PLUGIN_ID,
} from "./repair-fixtures";

class Storage {
	raw: unknown = null;

	load(): Promise<unknown> {
		return Promise.resolve(this.raw);
	}

	save(data: SyncAssetsPersistedData): Promise<void> {
		this.raw = structuredClone(data);
		return Promise.resolve();
	}
}

function result(status: RepairTransactionResult["status"]): RepairTransactionResult {
	return {
		status,
		transactionId: null,
		pluginId: PLUGIN_ID,
		receipt: null,
		reason: status === "committed" ? null : { code: `repair-${status}`, message: status },
	};
}

async function setup(runner: RepairRunner, checkRunning: () => boolean): Promise<RepairUiCoordinator> {
	const persistence = new PersistentDataController(new Storage());
	await persistence.load();
	const journal = new PersistentRepairJournal(persistence, `session-${"1".repeat(32)}`);
	return new RepairUiCoordinator(
		runner,
		journal,
		new FakeRepairAdapter(),
		".obsidian/plugins/sync-assets/.repair",
		checkRunning,
	);
}

describe("repair UI coordinator", () => {
	it("passes complete startup evidence to the explicit repair engine", async () => {
		const fixture = await createRepairFixture();
		let calls = 0;
		const coordinator = await setup({
			repair: (): Promise<RepairTransactionResult> => {
				calls += 1;
				return Promise.resolve(result("committed"));
			},
		}, () => false);
		const repaired = await coordinator.repair({ ...fixture.run, trigger: "startup" }, PLUGIN_ID);
		expect(repaired.status).toBe("committed");
		expect(calls).toBe(1);
	});

	it("allows only one repair operation and permits a new one after completion", async () => {
		const fixture = await createRepairFixture();
		let finish!: (value: RepairTransactionResult) => void;
		let calls = 0;
		const runner: RepairRunner = {
			repair: () => {
				calls += 1;
				return new Promise(resolve => {
					finish = resolve;
				});
			},
		};
		const coordinator = await setup(runner, () => false);
		const first = coordinator.repair(fixture.run, PLUGIN_ID);
		const second = await coordinator.repair(fixture.run, PLUGIN_ID);
		expect(second.reason?.code).toBe("operation-in-progress");
		expect(calls).toBe(1);
		finish(result("committed"));
		await first;
		const third = coordinator.repair({ ...fixture.run, runId: 10 }, PLUGIN_ID);
		expect(calls).toBe(2);
		finish(result("committed"));
		await third;
	});

	it("blocks repair while a check is active", async () => {
		const fixture = await createRepairFixture();
		let calls = 0;
		const coordinator = await setup({
			repair: () => {
				calls += 1;
				return Promise.resolve(result("committed"));
			},
		}, () => true);
		const blocked = await coordinator.repair(fixture.run, PLUGIN_ID);
		expect(blocked.reason?.code).toBe("operation-in-progress");
		expect(calls).toBe(0);
	});

	it("invalidates stale evidence but accepts a later full check run", async () => {
		const fixture = await createRepairFixture();
		let nextStatus: RepairTransactionResult["status"] = "stale";
		const coordinator = await setup({
			repair: () => Promise.resolve(result(nextStatus)),
		}, () => false);
		expect((await coordinator.repair(fixture.run, PLUGIN_ID)).status).toBe("stale");
		expect((await coordinator.repair(fixture.run, PLUGIN_ID)).reason?.code).toBe("fresh-check-required");
		nextStatus = "committed";
		expect((await coordinator.repair({ ...fixture.run, runId: 10 }, PLUGIN_ID)).status).toBe("committed");
	});
});
