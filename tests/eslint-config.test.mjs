import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function configFor(relativePath) {
	const eslint = new ESLint({ cwd: repositoryRoot });
	const config = await eslint.calculateConfigForFile(relativePath);
	if (config === undefined) {
		throw new Error(`No ESLint configuration resolved for ${relativePath}.`);
	}
	return config;
}

describe("ESLint quality gate configuration", () => {
	it("enables critical Obsidian rules as production errors", async () => {
		const config = await configFor("src/plugin-ui.ts");
		expect(config.rules["obsidianmd/no-plugin-as-component"]).toEqual([2]);
		expect(config.rules["obsidianmd/no-unsupported-api"]).toEqual([2]);
		expect(config.rules["obsidianmd/no-view-references-in-plugin"]).toEqual([2]);
	});

	it("keeps sentence-case diagnostics visible to StrictLint", async () => {
		const config = await configFor("main.ts");
		expect(config.rules["obsidianmd/ui/sentence-case"]?.[0]).toBe(1);
	});

	it("enforces popout-compatible global access in Web Crypto services", async () => {
		const cryptoConfig = await configFor("src/integrity-verification.ts");
		expect(cryptoConfig.rules["obsidianmd/no-global-this"]?.[0]).not.toBe(0);
	});

	it("validates the Obsidian manifest as an error", async () => {
		const config = await configFor("manifest.json");
		expect(config.rules["obsidianmd/validate-manifest"]).toEqual([2]);
	});

	it("validates the MIT license as an error", async () => {
		const config = await configFor("LICENSE");
		expect(config.rules["obsidianmd/validate-license"]).toEqual([2]);
	});
});
