import type { Stat } from "obsidian";
import { describe, expect, it } from "vitest";

import {
	readInstalledPluginDisplayName,
	type PluginDisplayNameAdapter,
} from "../src/plugin-display-name";

class Adapter implements PluginDisplayNameAdapter {
	statValue: Stat | null = { type: "file", ctime: 1, mtime: 1, size: 100 };
	content = JSON.stringify({ id: "templater-obsidian", name: "Templater" });

	stat(): Promise<Stat | null> {
		return Promise.resolve(this.statValue);
	}

	read(): Promise<string> {
		return Promise.resolve(this.content);
	}
}

describe("installed plugin display name", () => {
	it("reads a friendly exact-ID name from the bounded local manifest", async () => {
		const adapter = new Adapter();
		await expect(readInstalledPluginDisplayName("templater-obsidian", {
			adapter,
			configDir: ".custom",
			normalizePath: path => path,
		})).resolves.toBe("Templater");
	});

	it("fails closed for unsafe IDs, mismatched manifests, and invalid files", async () => {
		const adapter = new Adapter();
		const context = { adapter, configDir: ".custom", normalizePath: (path: string): string => path };
		await expect(readInstalledPluginDisplayName("../unsafe", context)).resolves.toBeNull();
		adapter.content = JSON.stringify({ id: "other-plugin", name: "Other" });
		await expect(readInstalledPluginDisplayName("templater-obsidian", context)).resolves.toBeNull();
		adapter.statValue = { type: "folder", ctime: 1, mtime: 1, size: 0 };
		await expect(readInstalledPluginDisplayName("templater-obsidian", context)).resolves.toBeNull();
	});
});
