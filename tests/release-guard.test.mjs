import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRelease } from "../scripts/release-guard-core.mjs";

const fixtureRoots = [];
const releaseGuardPath = fileURLToPath(new URL("../scripts/release-guard.mjs", import.meta.url));

const requiredIgnoreEntries = [
	"node_modules/",
	"main.js",
	"main.js.map",
	"dist/",
	"build/",
	"coverage/",
	"data.json",
	"data.json.*",
	".repair/",
	"*.bak",
	"*.backup",
	"*.orig",
	"*.rej",
	"*.tmp",
	"*.zip",
	"*.tar",
	"*.tar.gz",
	"*.tgz",
	"*.gz",
	"*.7z",
	"*.rar",
	"*.swp",
	".DS_Store",
];

const packageJson = {
	name: "sync-assets",
	version: "0.1.0",
	description: "fixture",
	type: "module",
	private: true,
	license: "MIT",
	scripts: {
		build: "tsc --noEmit && node esbuild.config.mjs production",
		lint: "eslint . --quiet",
		"lint:report": "eslint .",
		"lint:strict": "eslint . --max-warnings 0",
		test: "vitest run",
		"release:guard": "node scripts/release-guard.mjs",
		check: "npm run lint:strict && npm run build && npm run test && npm run release:guard",
	},
};

const manifest = {
	id: "sync-assets",
	name: "Sync Assets",
	version: "0.1.0",
	minAppVersion: "1.7.2",
	description: "fixture",
	author: "Fixture",
	isDesktopOnly: false,
};

const license = `MIT License

Copyright (c) 2026 Fixture

Permission is hereby granted, free of charge, to any person obtaining a copy.

THE SOFTWARE IS PROVIDED "AS IS".
`;

async function writeFixtureFile(root, relativePath, content) {
	const absolutePath = join(root, relativePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "sync-assets-release-guard-"));
	fixtureRoots.push(root);
	await Promise.all([
		writeFixtureFile(root, "package.json", JSON.stringify(packageJson, null, 2)),
		writeFixtureFile(root, "package-lock.json", JSON.stringify({
			name: "sync-assets",
			version: "0.1.0",
			lockfileVersion: 3,
			packages: { "": { name: "sync-assets", version: "0.1.0" } },
		}, null, 2)),
		writeFixtureFile(root, "manifest.json", JSON.stringify(manifest, null, 2)),
		writeFixtureFile(root, "versions.json", JSON.stringify({ "0.1.0": "1.7.2" }, null, 2)),
		writeFixtureFile(root, "LICENSE", license),
		writeFixtureFile(root, ".gitignore", `${requiredIgnoreEntries.join("\n")}\n`),
		writeFixtureFile(root, "main.js", "(() => { \"use strict\"; })();\n"),
		writeFixtureFile(root, "styles.css", ".sync-assets { display: block; }\n"),
	]);
	return root;
}

async function updateJson(root, relativePath, update) {
	const absolutePath = join(root, relativePath);
	const parsed = JSON.parse(await readFile(absolutePath, "utf8"));
	update(parsed);
	await writeFile(absolutePath, JSON.stringify(parsed, null, 2), "utf8");
}

afterEach(async () => {
	await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Sync Assets Release Guard", () => {
	it("accepts a complete release fixture", async () => {
		const root = await createFixture();
		await expect(inspectRelease(root)).resolves.toEqual({ ok: true, errors: [] });
	});

	it.each([
		["package version", "package.json", value => { value.version = "0.2.0"; }, "version"],
		["plugin identity", "manifest.json", value => { value.id = "other-plugin"; }, "manifest.json id"],
		["minimum app version", "versions.json", value => { value["0.1.0"] = "1.8.0"; }, "minAppVersion"],
		["lockfile identity", "package-lock.json", value => { value.packages[""].name = "other-plugin"; }, "root name"],
	])("rejects inconsistent %s", async (_label, relativePath, update, expectedMessage) => {
		const root = await createFixture();
		await updateJson(root, relativePath, update);
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain(expectedMessage);
	});

	it.each(["main.js", "manifest.json", "styles.css"])("rejects a missing %s artifact", async relativePath => {
		const root = await createFixture();
		await unlink(join(root, relativePath));
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain(relativePath);
	});

	it.each([
		["data.json", "{}"],
		["data.json.backup", "{}"],
		[".repair/transaction/backup/main.js", "backup"],
		["plugin-conflicted copy.js", "conflict"],
		["release.zip", "archive"],
		["draft.tmp", "temporary"],
		["release.7z", "archive"],
		["cache/result.json", "cache"],
	])("rejects forbidden workspace path %s", async (relativePath, content) => {
		const root = await createFixture();
		await writeFixtureFile(root, relativePath, content);
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain(relativePath.split("/")[0]);
	});

	it.each([
		["source map", "//# sourceMappingURL=main.js.map"],
		["personal path", "const path = '/Users/example/vault';"],
		["private key", "-----BEGIN PRIVATE KEY-----"],
		["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
		["npm token", "npm_abcdefghijklmnopqrstuvwxyz1234567890"],
		["debugger", "debugger;"],
		["development address", "https://localhost:3000"],
	])("rejects %s in the production bundle", async (_label, content) => {
		const root = await createFixture();
		await writeFixtureFile(root, "main.js", content);
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("main.js");
	});

	it("rejects invalid MIT metadata and license text", async () => {
		const root = await createFixture();
		await updateJson(root, "package.json", value => { value.license = "GPL-3.0-or-later"; });
		await writeFixtureFile(root, "LICENSE", "Incomplete license\n");
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("package.json license");
		expect(result.errors.join("\n")).toContain("LICENSE");
	});

	it("rejects an incomplete ignore policy", async () => {
		const root = await createFixture();
		await writeFixtureFile(root, ".gitignore", "node_modules/\nmain.js\n");
		const result = await inspectRelease(root);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain(".repair/");
		expect(result.errors.join("\n")).toContain("data.json");
	});

	it("returns a non-zero CLI status and prints every violation", async () => {
		const root = await createFixture();
		await unlink(join(root, "styles.css"));
		await updateJson(root, "manifest.json", value => { value.id = "other-plugin"; });
		const result = spawnSync(process.execPath, [releaseGuardPath], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("manifest.json id");
		expect(result.stderr).toContain("styles.css");
	});
});
