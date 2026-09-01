import { describe, expect, it } from "vitest";

import {
	buildReleaseTagCandidates,
	isReleaseAssetName,
	parseGitHubRepositorySlug,
	validatePluginId,
} from "../src/security";

describe("repository trust input", () => {
	it("accepts an exact owner/repo slug", () => {
		expect(parseGitHubRepositorySlug("hasanyilmaz/operon")).toEqual({
			ok: true,
			value: { owner: "hasanyilmaz", repo: "operon" },
		});
	});

	it.each([
		"https://github.com/hasanyilmaz/operon",
		"github.com/hasanyilmaz/operon",
		"hasanyilmaz/operon/releases",
		"hasanyilmaz/operon.git",
		"hasanyilmaz",
	])("rejects a non-canonical repository input: %s", value => {
		expect(parseGitHubRepositorySlug(value).ok).toBe(false);
	});
});

describe("plugin ID safety", () => {
	it("accepts a path-safe community plugin ID", () => {
		expect(validatePluginId("sync-assets")).toEqual({
			ok: true,
			value: "sync-assets",
		});
	});

	it.each(["../operon", "folder/operon", "folder\\operon", "Operon", " operon"])(
		"rejects an unsafe plugin ID: %s",
		value => {
			expect(validatePluginId(value).ok).toBe(false);
		},
	);
});

describe("release tag policy", () => {
	it("returns only the exact version and its v-prefixed fallback", () => {
		expect(buildReleaseTagCandidates("1.2.3")).toEqual({
			ok: true,
			value: ["1.2.3", "v1.2.3"],
		});
	});

	it.each(["latest", "v1.2.3", "1.2", "1.2.3/release", " 1.2.3"])(
		"rejects a non-exact manifest version: %s",
		value => {
			expect(buildReleaseTagCandidates(value).ok).toBe(false);
		},
	);
});

describe("release asset allowlist", () => {
	it.each(["main.js", "manifest.json", "styles.css"])(
		"accepts %s",
		assetName => {
			expect(isReleaseAssetName(assetName)).toBe(true);
		},
	);

	it.each(["data.json", "state.json", "plugin.zip", "main.js.map"])(
		"rejects %s",
		assetName => {
			expect(isReleaseAssetName(assetName)).toBe(false);
		},
	);
});
