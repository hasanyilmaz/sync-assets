import type { ListedFiles, Stat } from "obsidian";
import { describe, expect, it } from "vitest";

import {
	discoverLocalPlugins,
	discoverMonitoredPlugins,
	MAX_MANIFEST_BYTES,
	type DiscoveryAdapter,
	type LocalDiscoveryContext,
} from "../src/local-discovery";
import type { SyncAssetsSettings } from "../src/settings";

interface FakeFile {
	readonly stat: Stat;
	readonly content?: string;
}

class FakeDiscoveryAdapter implements DiscoveryAdapter {
	readonly calls: string[] = [];
	readonly nodes = new Map<string, FakeFile>();
	readonly listings = new Map<string, ListedFiles>();
	readonly statErrors = new Map<string, Error>();
	readonly listErrors = new Map<string, Error>();
	readonly readErrors = new Map<string, Error>();

	setFolder(path: string): void {
		this.nodes.set(path, {
			stat: { type: "folder", ctime: 1, mtime: 1, size: 0 },
		});
	}

	setFile(path: string, content: string, size = content.length): void {
		this.nodes.set(path, {
			stat: { type: "file", ctime: 1, mtime: 1, size },
			content,
		});
	}

	setListing(path: string, folders: string[], files: string[] = []): void {
		this.listings.set(path, { folders, files });
	}

	stat(path: string): Promise<Stat | null> {
		this.calls.push(`stat:${path}`);
		const error = this.statErrors.get(path);
		if (error !== undefined) {
			return Promise.reject(error);
		}
		return Promise.resolve(this.nodes.get(path)?.stat ?? null);
	}

	list(path: string): Promise<ListedFiles> {
		this.calls.push(`list:${path}`);
		const error = this.listErrors.get(path);
		if (error !== undefined) {
			return Promise.reject(error);
		}
		return Promise.resolve(this.listings.get(path) ?? { files: [], folders: [] });
	}

	read(path: string): Promise<string> {
		this.calls.push(`read:${path}`);
		const error = this.readErrors.get(path);
		if (error !== undefined) {
			return Promise.reject(error);
		}
		const file = this.nodes.get(path);
		if (file?.content === undefined) {
			return Promise.reject(new Error("Missing fake file content."));
		}
		return Promise.resolve(file.content);
	}
}

function normalizeTestPath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function createContext(
	adapter: FakeDiscoveryAdapter,
	configDir = ".custom-config",
): LocalDiscoveryContext {
	return {
		adapter,
		configDir,
		ownPluginId: "sync-assets",
		normalizePath: normalizeTestPath,
	};
}

function createSettings(
	mappings: Array<{ pluginId: string; owner: string; repo: string }> = [],
): SyncAssetsSettings {
	return {
	schemaVersion: 2,
		startupCheckEnabled: false,
		repositories: mappings.map(mapping => ({
			pluginId: mapping.pluginId,
			repository: { owner: mapping.owner, repo: mapping.repo },
		})),
	};
}

function manifestJson(
	id: string,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id,
		name: `Plugin ${id}`,
		author: "Example Author",
		version: "1.2.3",
		minAppVersion: "1.7.2",
		description: "Example plugin",
		isDesktopOnly: false,
		...overrides,
	});
}

function installPlugin(
	adapter: FakeDiscoveryAdapter,
	pluginRoot: string,
	pluginId: string,
	overrides: Record<string, unknown> = {},
): void {
	const pluginPath = `${pluginRoot}/${pluginId}`;
	adapter.setFolder(pluginPath);
	adapter.setFile(`${pluginPath}/manifest.json`, manifestJson(pluginId, overrides));
	adapter.setFile(`${pluginPath}/main.js`, "main bundle");
}

function setupPluginRoot(
	adapter: FakeDiscoveryAdapter,
	pluginRoot: string,
	pluginIds: string[],
): void {
	adapter.setFolder(pluginRoot);
	adapter.setListing(
		pluginRoot,
		pluginIds.map(pluginId => `${pluginRoot}/${pluginId}`),
	);
}

describe("local plugin discovery", () => {
	it("limits integrity discovery to monitored plugins without reading unmonitored manifests", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["broken-unmonitored", "operon"]);
		installPlugin(adapter, pluginRoot, "broken-unmonitored");
		installPlugin(adapter, pluginRoot, "operon");
		adapter.nodes.delete(`${pluginRoot}/broken-unmonitored/manifest.json`);

		const result = await discoverMonitoredPlugins(
			createSettings([{ pluginId: "operon", owner: "hasanyilmaz", repo: "operon" }]),
			createContext(adapter),
		);

		expect(result.status).toBe("completed");
		expect(result.plugins.map(plugin => plugin.pluginId)).toEqual(["operon"]);
		expect(adapter.calls).not.toContain(`list:${pluginRoot}`);
		expect(adapter.calls.some(call => call.includes("broken-unmonitored"))).toBe(false);
	});

	it("reports a monitored plugin whose direct folder is missing", async () => {
		const adapter = new FakeDiscoveryAdapter();
		setupPluginRoot(adapter, ".custom-config/plugins", ["unmonitored"]);
		installPlugin(adapter, ".custom-config/plugins", "unmonitored");

		const result = await discoverMonitoredPlugins(
			createSettings([{ pluginId: "operon", owner: "hasanyilmaz", repo: "operon" }]),
			createContext(adapter),
		);

		expect(result.plugins).toEqual([expect.objectContaining({
			status: "configured-missing",
			pluginId: "operon",
		})]);
		expect(adapter.calls.some(call => call.includes("unmonitored/manifest.json"))).toBe(false);
	});

	it("uses the supplied config directory, discovers all plugins, and sorts them", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["zeta", "sync-assets", "alpha"]);
		installPlugin(adapter, pluginRoot, "alpha");
		installPlugin(adapter, pluginRoot, "zeta");
		installPlugin(adapter, pluginRoot, "sync-assets");

		const result = await discoverLocalPlugins(
			createSettings([{ pluginId: "zeta", owner: "example", repo: "zeta" }]),
			createContext(adapter),
		);

		expect(result.status).toBe("completed");
		expect(result.pluginRoot).toBe(pluginRoot);
		expect(result.plugins.map(plugin => plugin.pluginId)).toEqual(["alpha", "zeta"]);
		expect(result.plugins[0]?.repository).toBeNull();
		expect(result.plugins[1]?.repository).toEqual({ owner: "example", repo: "zeta" });
		expect(adapter.calls.every(call => !call.includes(".obsidian"))).toBe(true);
		expect(adapter.calls.some(call => call.includes("sync-assets/manifest.json"))).toBe(false);
	});

	it("reports configured mappings whose plugin folder is absent", async () => {
		const adapter = new FakeDiscoveryAdapter();
		setupPluginRoot(adapter, ".custom-config/plugins", []);

		const result = await discoverLocalPlugins(
			createSettings([{ pluginId: "operon", owner: "hasanyilmaz", repo: "operon" }]),
			createContext(adapter),
		);

		expect(result.plugins).toEqual([expect.objectContaining({
			status: "configured-missing",
			pluginId: "operon",
			repository: { owner: "hasanyilmaz", repo: "operon" },
			manifest: null,
			artifacts: [],
		})]);
	});

	it("treats a missing plugin root as an empty installation, not an adapter error", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const result = await discoverLocalPlugins(
			createSettings([
				{ pluginId: "zeta", owner: "example", repo: "zeta" },
				{ pluginId: "operon", owner: "hasanyilmaz", repo: "operon" },
			]),
			createContext(adapter),
		);

		expect(result.status).toBe("completed");
		expect(result.issues).toEqual([]);
		expect(result.plugins.map(plugin => plugin.pluginId)).toEqual(["operon", "zeta"]);
		expect(result.plugins.every(plugin => plugin.status === "configured-missing")).toBe(true);
		expect(adapter.calls).toEqual(["stat:.custom-config/plugins"]);
	});

	it("distinguishes plugin-root stat and list failures from absence", async () => {
		const statAdapter = new FakeDiscoveryAdapter();
		statAdapter.statErrors.set(".custom-config/plugins", new Error("stat denied"));
		const statResult = await discoverLocalPlugins(createSettings(), createContext(statAdapter));

		const listAdapter = new FakeDiscoveryAdapter();
		listAdapter.setFolder(".custom-config/plugins");
		listAdapter.listErrors.set(".custom-config/plugins", new Error("list denied"));
		const listResult = await discoverLocalPlugins(createSettings(), createContext(listAdapter));

		expect(statResult).toEqual(expect.objectContaining({ status: "error", plugins: [] }));
		expect(statResult.issues[0]?.code).toBe("plugin-root-stat-error");
		expect(listResult).toEqual(expect.objectContaining({ status: "error", plugins: [] }));
		expect(listResult.issues[0]?.code).toBe("plugin-root-list-error");
	});

	it("rejects a plugin root that is not a folder", async () => {
		const adapter = new FakeDiscoveryAdapter();
		adapter.setFile(".custom-config/plugins", "not a folder");

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(result.status).toBe("error");
		expect(result.issues[0]?.code).toBe("plugin-root-not-folder");
	});

	it("skips unsafe and non-direct folder entries with structured issues", async () => {
		const adapter = new FakeDiscoveryAdapter();
		adapter.setFolder(".custom-config/plugins");
		adapter.setListing(".custom-config/plugins", [
			".custom-config/plugins/Bad Plugin",
			".custom-config/plugins/nested/plugin",
			"outside/plugin",
		]);

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(result.plugins).toEqual([]);
		expect(result.issues.map(foundIssue => foundIssue.code)).toEqual([
			"unsafe-plugin-folder",
			"non-direct-plugin-folder",
			"non-direct-plugin-folder",
		]);
	});

	it("accepts unknown manifest fields while normalizing optional defaults", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["operon"]);
		installPlugin(adapter, pluginRoot, "operon", {
			isDesktopOnly: undefined,
			customFutureField: { enabled: true },
		});

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));
		const plugin = result.plugins[0];

		expect(plugin?.status).toBe("discovered");
		if (plugin?.status === "discovered") {
			expect(plugin.manifest.isDesktopOnly).toBe(false);
		}
	});

	it.each([
		{
			name: "missing manifest",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.nodes.delete(path);
			},
			expectedCode: "manifest-missing",
		},
		{
			name: "empty manifest",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.setFile(path, "", 0);
			},
			expectedCode: "manifest-size-out-of-range",
		},
		{
			name: "oversized manifest",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.setFile(path, "{}", MAX_MANIFEST_BYTES + 1);
			},
			expectedCode: "manifest-size-out-of-range",
		},
		{
			name: "manifest folder",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.setFolder(path);
			},
			expectedCode: "manifest-not-file",
		},
		{
			name: "invalid JSON",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.setFile(path, "{");
			},
			expectedCode: "manifest-invalid-json",
		},
		{
			name: "non-object JSON",
			prepare: (adapter: FakeDiscoveryAdapter, path: string): void => {
				adapter.setFile(path, "[]");
			},
			expectedCode: "manifest-not-object",
		},
	])("isolates $name as unverifiable", async ({ prepare, expectedCode }) => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["broken"]);
		installPlugin(adapter, pluginRoot, "broken");
		prepare(adapter, `${pluginRoot}/broken/manifest.json`);

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(result.status).toBe("completed");
		expect(result.plugins[0]).toEqual(expect.objectContaining({
			status: "unverifiable",
			pluginId: "broken",
			artifacts: [],
		}));
		expect(result.issues[0]?.code).toBe(expectedCode);
	});

	it.each([
		{ name: "missing name", overrides: { name: undefined } },
		{ name: "folder mismatch", overrides: { id: "another-plugin" } },
		{ name: "unsafe manifest ID", overrides: { id: "../broken" } },
		{ name: "invalid semver", overrides: { version: "latest" } },
		{ name: "invalid authorUrl", overrides: { authorUrl: 42 } },
		{ name: "invalid isDesktopOnly", overrides: { isDesktopOnly: "false" } },
	])("rejects a manifest with $name", async ({ overrides }) => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["broken"]);
		installPlugin(adapter, pluginRoot, "broken", overrides);

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(result.plugins[0]?.status).toBe("unverifiable");
		expect(result.issues[0]?.scope).toBe("plugin");
	});

	it("isolates a manifest adapter error and continues with other plugins", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["broken", "healthy"]);
		installPlugin(adapter, pluginRoot, "broken");
		installPlugin(adapter, pluginRoot, "healthy");
		adapter.readErrors.set(`${pluginRoot}/broken/manifest.json`, new Error("read denied"));

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(result.status).toBe("completed");
		expect(result.plugins.map(plugin => plugin.status)).toEqual(["error", "discovered"]);
		expect(result.issues[0]?.code).toBe("manifest-read-error");
	});

	it("records file, missing, invalid, and adapter-error artifact states", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["alpha", "beta"]);
		installPlugin(adapter, pluginRoot, "alpha");
		installPlugin(adapter, pluginRoot, "beta");
		adapter.setFolder(`${pluginRoot}/alpha/styles.css`);
		adapter.statErrors.set(`${pluginRoot}/beta/main.js`, new Error("stat denied"));

		const result = await discoverLocalPlugins(createSettings(), createContext(adapter));
		const alpha = result.plugins[0];
		const beta = result.plugins[1];

		if (alpha?.status !== "discovered" || beta?.status !== "discovered") {
			throw new Error("Expected discovered plugins.");
		}
		expect(alpha.artifacts.map(artifact => [artifact.assetName, artifact.state])).toEqual([
			["main.js", "file"],
			["manifest.json", "file"],
			["styles.css", "invalid"],
		]);
		expect(alpha.artifacts[0]?.sizeBytes).toBe("main bundle".length);
		expect(beta.artifacts.map(artifact => [artifact.assetName, artifact.state])).toEqual([
			["main.js", "error"],
			["manifest.json", "file"],
			["styles.css", "missing"],
		]);
		expect(result.issues.map(foundIssue => foundIssue.code)).toEqual([
			"artifact-not-file",
			"artifact-stat-error",
		]);
	});

	it("uses only the adapter's stat, list, and read surface", async () => {
		const adapter = new FakeDiscoveryAdapter();
		const pluginRoot = ".custom-config/plugins";
		setupPluginRoot(adapter, pluginRoot, ["operon"]);
		installPlugin(adapter, pluginRoot, "operon");

		await discoverLocalPlugins(createSettings(), createContext(adapter));

		expect(adapter.calls.length).toBeGreaterThan(0);
		expect(adapter.calls.every(call => /^(stat|list|read):/.test(call))).toBe(true);
	});
});
