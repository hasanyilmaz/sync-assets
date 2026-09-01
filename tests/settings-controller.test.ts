import { describe, expect, it } from "vitest";

import {
	createMappingDrafts,
	SettingsController,
	type SettingsStorage,
	validateMappingDrafts,
} from "../src/settings-controller";
import type { SyncAssetsPersistedData } from "../src/persisted-state";
import type { SyncAssetsSettings } from "../src/settings";

const VALID_SETTINGS: SyncAssetsSettings = {
	schemaVersion: 2,
	startupCheckEnabled: true,
	repositories: [{
		pluginId: "operon",
		repository: { owner: "hasanyilmaz", repo: "operon" },
	}],
};

const VALID_DATA: SyncAssetsPersistedData = {
	...VALID_SETTINGS,
	revision: 4,
	repairRecords: [],
};

class FakeSettingsStorage implements SettingsStorage {
	readonly saved: SyncAssetsPersistedData[] = [];
	loadError: Error | null = null;
	saveError: Error | null = null;

	constructor(public raw: unknown) {}

	load(): Promise<unknown> {
		return this.loadError === null
			? Promise.resolve(this.raw)
			: Promise.reject(this.loadError);
	}

	save(settings: SyncAssetsPersistedData): Promise<void> {
		if (this.saveError !== null) {
			return Promise.reject(this.saveError);
		}
		this.saved.push(settings);
		this.raw = settings;
		return Promise.resolve();
	}
}

describe("settings controller", () => {
	it("loads valid settings without writing and produces editable owner/repo drafts", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		const controller = new SettingsController(storage);

		const state = await controller.load();

		expect(state.settings).toEqual(VALID_SETTINGS);
		expect(state.issues).toEqual([]);
		expect(storage.saved).toEqual([]);
		expect(createMappingDrafts(state.settings)).toEqual([{
			pluginId: "operon",
			repositorySlug: "hasanyilmaz/operon",
		}]);
	});

	it("treats absent first-run data as safe defaults without a warning or write", async () => {
		for (const raw of [null, undefined]) {
			const storage = new FakeSettingsStorage(raw);
			const state = await new SettingsController(storage).load();
			expect(state.settings.repositories).toEqual([]);
			expect(state.settings.startupCheckEnabled).toBe(true);
			expect(state.issues).toEqual([]);
			expect(storage.saved).toEqual([]);
		}
	});

	it("uses safe defaults for malformed or unreadable data without rewriting it", async () => {
		const malformedStorage = new FakeSettingsStorage({ schemaVersion: 99 });
		const malformed = await new SettingsController(malformedStorage).load();
		const failedStorage = new FakeSettingsStorage(null);
		failedStorage.loadError = new Error("read denied");
		const failed = await new SettingsController(failedStorage).load();

		expect(malformed.usedDefaults).toBe(true);
		expect(malformed.issues.length).toBeGreaterThan(0);
		expect(malformedStorage.saved).toEqual([]);
		expect(failed.issues[0]?.code).toBe("settings-load-error");
		expect(failedStorage.saved).toEqual([]);
	});

	it("saves a fully valid draft and preserves the inactive startup setting", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		const controller = new SettingsController(storage);
		await controller.load();

		const result = await controller.saveDrafts([
			{ pluginId: "dataview", repositorySlug: "blacksmithgu/obsidian-dataview" },
		]);

		expect(result.ok).toBe(true);
		expect(storage.saved).toEqual([{
			schemaVersion: 2,
			revision: 5,
			startupCheckEnabled: true,
			repositories: [{
				pluginId: "dataview",
				repository: { owner: "blacksmithgu", repo: "obsidian-dataview" },
			}],
			repairRecords: [],
		}]);
		expect(controller.getState().settings.startupCheckEnabled).toBe(true);
	});

	it("saves the startup toggle atomically with valid mappings", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		const controller = new SettingsController(storage);
		await controller.load();

		const result = await controller.saveDrafts([{
			pluginId: "dataview",
			repositorySlug: "blacksmithgu/obsidian-dataview",
		}], false);

		expect(result.ok).toBe(true);
		expect(storage.saved[0]?.startupCheckEnabled).toBe(false);
		expect(storage.saved[0]?.repositories[0]?.pluginId).toBe("dataview");
	});

	it("does not persist a startup toggle change when any mapping is invalid", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		const controller = new SettingsController(storage);
		await controller.load();

		const result = await controller.saveDrafts([{
			pluginId: "../unsafe",
			repositorySlug: "example/plugin",
		}], false);

		expect(result.ok).toBe(false);
		expect(storage.saved).toEqual([]);
		expect(controller.getState().settings.startupCheckEnabled).toBe(true);
	});

	it("persists consecutive add, remove, and toggle actions with increasing revisions", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		const controller = new SettingsController(storage);
		await controller.load();

		const added = await controller.saveDrafts([
			...createMappingDrafts(VALID_SETTINGS),
			{ pluginId: "dataview", repositorySlug: "blacksmithgu/obsidian-dataview" },
		], true);
		const removedAndDisabled = await controller.saveDrafts([
			{ pluginId: "dataview", repositorySlug: "blacksmithgu/obsidian-dataview" },
		], false);

		expect(added.ok).toBe(true);
		expect(removedAndDisabled.ok).toBe(true);
		expect(storage.saved.map(saved => saved.revision)).toEqual([5, 6]);
		expect(storage.saved[1]).toEqual(expect.objectContaining({
			startupCheckEnabled: false,
			repositories: [{
				pluginId: "dataview",
				repository: { owner: "blacksmithgu", repo: "obsidian-dataview" },
			}],
			repairRecords: [],
		}));
	});

	it("rejects duplicate IDs, unsafe IDs, URLs, and malformed repository slugs without writing", async () => {
		const invalidDrafts = [
			[
				{ pluginId: "operon", repositorySlug: "hasanyilmaz/operon" },
				{ pluginId: "operon", repositorySlug: "example/other" },
			],
			[{ pluginId: "../unsafe", repositorySlug: "example/repo" }],
			[{ pluginId: "operon", repositorySlug: "https://github.com/hasanyilmaz/operon" }],
			[{ pluginId: "operon", repositorySlug: "owner/repo/extra" }],
		] as const;

		for (const drafts of invalidDrafts) {
			const storage = new FakeSettingsStorage(VALID_DATA);
			const controller = new SettingsController(storage);
			await controller.load();
			const result = await controller.saveDrafts(drafts);
			expect(result.ok).toBe(false);
			expect(storage.saved).toEqual([]);
			expect(controller.getState().settings).toEqual(VALID_SETTINGS);
		}
	});

	it("preserves current settings when persistence fails", async () => {
		const storage = new FakeSettingsStorage(VALID_DATA);
		storage.saveError = new Error("write denied");
		const controller = new SettingsController(storage);
		await controller.load();

		const result = await controller.saveDrafts([{
			pluginId: "dataview",
			repositorySlug: "example/dataview",
		}]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues[0]?.code).toBe("settings-save-error");
		}
		expect(controller.getState().settings).toEqual(VALID_SETTINGS);
	});
});

describe("mapping draft validation", () => {
	it("accepts an empty mapping list and rejects .git repositories", () => {
		expect(validateMappingDrafts([], false).ok).toBe(true);
		expect(validateMappingDrafts([{
			pluginId: "operon",
			repositorySlug: "hasanyilmaz/operon.git",
		}], false).ok).toBe(false);
	});
});
