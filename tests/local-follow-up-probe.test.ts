import type { Stat } from "obsidian";
import { describe, expect, it } from "vitest";

import {
	probeMonitoredLocalAssets,
	type LocalFollowUpProbeAdapter,
} from "../src/local-follow-up-probe";
import type { SyncAssetsSettings } from "../src/settings";

function fileStat(size: number, mtime: number): Stat {
	return { type: "file", ctime: 1, mtime, size };
}

function settings(): SyncAssetsSettings {
	return {
		schemaVersion: 2,
		startupCheckEnabled: true,
		repositories: [
			{ pluginId: "zeta-plugin", repository: { owner: "zeta", repo: "plugin" } },
			{ pluginId: "alpha-plugin", repository: { owner: "alpha", repo: "plugin" } },
		],
	};
}

function createAdapter(
	stats: Map<string, Stat | null>,
	reads: Map<string, string>,
	calls: string[],
): LocalFollowUpProbeAdapter {
	return {
		stat(path): Promise<Stat | null> {
			calls.push(`stat:${path}`);
			return Promise.resolve(stats.get(path) ?? null);
		},
		read(path): Promise<string> {
			calls.push(`read:${path}`);
			const value = reads.get(path);
			if (value === undefined) {
				return Promise.reject(new Error("Missing read fixture."));
			}
			return Promise.resolve(value);
		},
	};
}

describe("local startup follow-up probe", () => {
	it("reads only mapped release assets in deterministic plugin order", async () => {
		const calls: string[] = [];
		const stats = new Map<string, Stat | null>();
		const reads = new Map<string, string>();
		for (const pluginId of ["alpha-plugin", "zeta-plugin"]) {
			for (const [assetName, size] of [["main.js", 100], ["manifest.json", 50], ["styles.css", 25]] as const) {
				const path = `.obsidian/plugins/${pluginId}/${assetName}`;
				stats.set(path, fileStat(size, 10));
				if (assetName === "manifest.json") {
					reads.set(path, JSON.stringify({ id: pluginId, version: "1.0.0" }));
				}
			}
		}

		const fingerprint = await probeMonitoredLocalAssets(settings(), {
			adapter: createAdapter(stats, reads, calls),
			configDir: ".obsidian",
			normalizePath: path => path,
		});

		expect(fingerprint).not.toBeNull();
		expect(calls[0]).toBe("stat:.obsidian/plugins/alpha-plugin/main.js");
		expect(calls).toHaveLength(8);
		expect(calls.every(call => call.startsWith("stat:") || call.startsWith("read:"))).toBe(true);
	});

	it("detects size, modification time, presence, and manifest-content changes", async () => {
		const pluginSettings: SyncAssetsSettings = {
			...settings(),
			repositories: [settings().repositories[0]!],
		};
		const manifestPath = ".obsidian/plugins/zeta-plugin/manifest.json";
		const stats = new Map<string, Stat | null>([
			[".obsidian/plugins/zeta-plugin/main.js", fileStat(100, 10)],
			[manifestPath, fileStat(50, 10)],
			[".obsidian/plugins/zeta-plugin/styles.css", null],
		]);
		const reads = new Map([[manifestPath, "first"]]);
		const first = await probeMonitoredLocalAssets(pluginSettings, {
			adapter: createAdapter(stats, reads, []),
			configDir: ".obsidian",
			normalizePath: path => path,
		});

		stats.set(".obsidian/plugins/zeta-plugin/main.js", fileStat(101, 11));
		reads.set(manifestPath, "second");
		stats.set(".obsidian/plugins/zeta-plugin/styles.css", fileStat(1, 11));
		const second = await probeMonitoredLocalAssets(pluginSettings, {
			adapter: createAdapter(stats, reads, []),
			configDir: ".obsidian",
			normalizePath: path => path,
		});

		expect(second).not.toBe(first);
	});

	it("fails closed on unsafe IDs and adapter errors", async () => {
		const unsafe: SyncAssetsSettings = {
			...settings(),
			repositories: [{
				pluginId: "../unsafe",
				repository: { owner: "example", repo: "plugin" },
			}],
		};
		expect(await probeMonitoredLocalAssets(unsafe, {
			adapter: createAdapter(new Map(), new Map(), []),
			configDir: ".obsidian",
			normalizePath: path => path,
		})).toBeNull();

		const failingAdapter: LocalFollowUpProbeAdapter = {
			stat: () => Promise.reject(new Error("stat failed")),
			read: () => Promise.reject(new Error("read failed")),
		};
		expect(await probeMonitoredLocalAssets({
			...settings(),
			repositories: [settings().repositories[0]!],
		}, {
			adapter: failingAdapter,
			configDir: ".obsidian",
			normalizePath: path => path,
		})).toBeNull();
	});
});
