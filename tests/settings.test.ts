import { describe, expect, it } from "vitest";

import {
	createDefaultSettings,
	parseSettings,
} from "../src/settings";

const VALID_SETTINGS = {
	schemaVersion: 2,
	startupCheckEnabled: false,
	repositories: [{
		pluginId: "operon",
		repository: {
			owner: "hasanyilmaz",
			repo: "operon",
		},
	}],
};

describe("settings defaults", () => {
	it("starts with no trusted repositories and startup checks enabled", () => {
		expect(createDefaultSettings()).toEqual({
			schemaVersion: 2,
			startupCheckEnabled: true,
			repositories: [],
		});
	});
});

describe("settings parsing", () => {
	it("accepts a valid plugin-to-repository mapping", () => {
		expect(parseSettings(VALID_SETTINGS)).toEqual({
			settings: VALID_SETTINGS,
			issues: [],
			usedDefaults: false,
		});
	});

	it("accepts and ignores the obsolete automatic cleanup field", () => {
		const result = parseSettings({ ...VALID_SETTINGS, autoDeleteVerifiedBackups: true });

		expect(result.usedDefaults).toBe(false);
		expect(result.settings).toEqual(VALID_SETTINGS);
	});

	it("rejects duplicate plugin IDs and falls back as one unit", () => {
		const result = parseSettings({
			...VALID_SETTINGS,
			repositories: [
				...VALID_SETTINGS.repositories,
				{
					pluginId: "operon",
					repository: { owner: "example", repo: "mirror" },
				},
			],
		});

		expect(result.usedDefaults).toBe(true);
		expect(result.settings).toEqual(createDefaultSettings());
		expect(result.issues.some(issue => issue.code === "duplicate-plugin-id")).toBe(true);
	});

	it.each([
		{
			name: "slash in plugin ID",
			value: {
				...VALID_SETTINGS,
				repositories: [{
					pluginId: "folder/operon",
					repository: { owner: "hasanyilmaz", repo: "operon" },
				}],
			},
		},
		{
			name: "repository URL",
			value: {
				...VALID_SETTINGS,
				repositories: [{
					pluginId: "operon",
					repository: "https://github.com/hasanyilmaz/operon",
				}],
			},
		},
		{
			name: "repository with .git suffix",
			value: {
				...VALID_SETTINGS,
				repositories: [{
					pluginId: "operon",
					repository: { owner: "hasanyilmaz", repo: "operon.git" },
				}],
			},
		},
		{
			name: "unknown secret field",
			value: { ...VALID_SETTINGS, token: "not-allowed" },
		},
	])("rejects $name", ({ value }) => {
		const result = parseSettings(value);
		expect(result.usedDefaults).toBe(true);
		expect(result.settings).toEqual(createDefaultSettings());
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it.each([
		null,
		[],
		{ ...VALID_SETTINGS, schemaVersion: 3 },
		{ ...VALID_SETTINGS, startupCheckEnabled: "false" },
		{ ...VALID_SETTINGS, autoDeleteVerifiedBackups: "true" },
		{ ...VALID_SETTINGS, repositories: "operon" },
	])("fails closed for malformed or unsupported settings", value => {
		const result = parseSettings(value);
		expect(result.usedDefaults).toBe(true);
		expect(result.settings).toEqual(createDefaultSettings());
		expect(result.issues.length).toBeGreaterThan(0);
	});
});
