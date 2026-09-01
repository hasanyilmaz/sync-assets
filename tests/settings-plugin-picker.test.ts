import { describe, expect, it } from "vitest";

import { parseCommunityPluginCatalog } from "../src/community-catalog";
import type {
	DiscoveredPluginRecord,
	LocalDiscoveryResult,
	UnverifiablePluginRecord,
} from "../src/local-discovery";
import {
	buildSettingsPluginPickerModel,
	createMappingDraftForOption,
} from "../src/settings-plugin-picker";

function discovered(
	pluginId: string,
	pluginName: string,
	version = "1.2.3",
): DiscoveredPluginRecord {
	return {
		status: "discovered",
		pluginId,
		pluginPath: `.obsidian/plugins/${pluginId}`,
		repository: null,
		manifest: {
			id: pluginId,
			name: pluginName,
			author: "Example",
			version,
			minAppVersion: "1.7.2",
			description: "Example plugin",
			isDesktopOnly: false,
		},
		artifacts: [],
		reason: null,
	};
}

function unverifiable(pluginId: string): UnverifiablePluginRecord {
	return {
		status: "unverifiable",
		pluginId,
		pluginPath: `.obsidian/plugins/${pluginId}`,
		repository: null,
		manifest: null,
		artifacts: [],
		reason: { code: "manifest-invalid", message: "Invalid manifest." },
	};
}

function discovery(
	plugins: LocalDiscoveryResult["plugins"],
): LocalDiscoveryResult {
	return {
		status: "completed",
		pluginRoot: ".obsidian/plugins",
		plugins,
		issues: [],
	};
}

describe("settings installed plugin picker", () => {
	it("sorts valid installed plugins by name then ID and excludes mapped or unverifiable plugins", () => {
		const catalog = parseCommunityPluginCatalog([
			{ id: "zeta", repo: "example/zeta" },
			{ id: "alpha-two", repo: "example/alpha-two" },
		]);
		const model = buildSettingsPluginPickerModel(discovery([
			discovered("zeta", "Zeta", "2.0.0"),
			discovered("alpha-two", "Alpha"),
			discovered("alpha-one", "Alpha"),
			unverifiable("broken"),
		]), [{ pluginId: "alpha-one", repositorySlug: "example/alpha-one" }], catalog);

		expect(model.options.map(option => option.pluginId)).toEqual(["alpha-two", "zeta"]);
		expect(model.options[0]?.label).toBe("Alpha");
		expect(model.options[0]?.repositorySlug).toBe("example/alpha-two");
		expect(model.mappings).toEqual([{
			pluginId: "alpha-one",
			pluginName: "Alpha",
			version: "1.2.3",
			repositorySlug: "example/alpha-one",
			installed: true,
		}]);
	});

	it("uses plugin IDs only to disambiguate duplicate installed names", () => {
		const model = buildSettingsPluginPickerModel(
			discovery([
				discovered("alpha-one", "Alpha"),
				discovered("alpha-two", "Alpha"),
			]),
			[],
			parseCommunityPluginCatalog([]),
		);

		expect(model.options.map(option => option.label)).toEqual([
			"Alpha (alpha-one)",
			"Alpha (alpha-two)",
		]);
	});

	it("presents missing configured mappings without inventing local metadata", () => {
		const model = buildSettingsPluginPickerModel(
			discovery([]),
			[{ pluginId: "missing", repositorySlug: "example/missing" }],
			parseCommunityPluginCatalog([]),
		);
		expect(model.mappings).toEqual([{
			pluginId: "missing",
			pluginName: "missing",
			version: null,
			repositorySlug: "example/missing",
			installed: false,
		}]);
	});

	it("creates official mappings without manual input and validates only owner/repo for unlisted plugins", () => {
		const catalog = parseCommunityPluginCatalog([
			{ id: "official", repo: "owner/official-repo" },
		]);
		const model = buildSettingsPluginPickerModel(
			discovery([
				discovered("official", "Official"),
				discovered("brat-plugin", "BRAT Plugin"),
			]),
			[],
			catalog,
		);
		const official = model.options.find(option => option.pluginId === "official")!;
		const custom = model.options.find(option => option.pluginId === "brat-plugin")!;

		expect(createMappingDraftForOption(official, "")).toEqual({
			ok: true,
			draft: { pluginId: "official", repositorySlug: "owner/official-repo" },
		});
		expect(custom.repositoryReason?.code).toBe("community-catalog-plugin-not-found");
		expect(createMappingDraftForOption(custom, "https://github.com/owner/repo").ok).toBe(false);
		expect(createMappingDraftForOption(custom, "owner/custom-repo")).toEqual({
			ok: true,
			draft: { pluginId: "brat-plugin", repositorySlug: "owner/custom-repo" },
		});
	});

	it("keeps installed plugins selectable with manual fallback when the catalog is unavailable", () => {
		const catalog = {
			status: "error" as const,
			reason: { code: "catalog-offline", message: "Catalog is offline." },
		};
		const model = buildSettingsPluginPickerModel(
			discovery([discovered("offline-plugin", "Offline Plugin")]),
			[],
			catalog,
		);
		expect(model.options).toEqual([expect.objectContaining({
			pluginId: "offline-plugin",
			repositorySlug: null,
			repositorySource: null,
			repositoryReason: catalog.reason,
		})]);
		expect(createMappingDraftForOption(model.options[0]!, "owner/offline-plugin").ok).toBe(true);
	});
});
