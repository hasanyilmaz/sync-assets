import { describe, expect, it } from "vitest";

import type { GitHubRepository } from "../src/domain";
import type {
	ConfiguredMissingPluginRecord,
	DiscoveredPluginRecord,
	LocalDiscoveryResult,
	UnverifiablePluginRecord,
} from "../src/local-discovery";
import {
	GITHUB_API_VERSION,
	MAX_RELEASE_RESPONSE_BYTES,
	REMOTE_REQUEST_ATTEMPT_TIMEOUT_MS,
	RemoteRequestTimeoutError,
	resolveRemoteReleases,
	type RemoteHttpRequest,
	type RemoteHttpResponse,
	type RemoteResolverContext,
} from "../src/remote-release";

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const DEFAULT_REPOSITORY = { owner: "example", repo: "plugin-repo" };

type QueuedResponse = RemoteHttpResponse | Error;

class FakeRemoteHttp {
	readonly calls: RemoteHttpRequest[] = [];
	readonly queued = new Map<string, QueuedResponse[]>();

	enqueue(url: string, ...responses: QueuedResponse[]): void {
		this.queued.set(url, [...(this.queued.get(url) ?? []), ...responses]);
	}

	send(request: RemoteHttpRequest): Promise<RemoteHttpResponse> {
		this.calls.push(request);
		const queue = this.queued.get(request.url);
		const next = queue?.shift();
		if (next === undefined) {
			return Promise.reject(new Error(`No fake response for ${request.url}`));
		}
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	}
}

function toArrayBuffer(value: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(value);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}

function textResponse(
	status: number,
	text: string,
	headers: Record<string, string> = {},
	arrayBuffer = toArrayBuffer(text),
): RemoteHttpResponse {
	return { status, text, headers, arrayBuffer };
}

function jsonResponse(
	status: number,
	value: unknown,
	headers: Record<string, string> = {},
	arrayBuffer?: ArrayBuffer,
): RemoteHttpResponse {
	const text = JSON.stringify(value);
	return textResponse(status, text, headers, arrayBuffer ?? toArrayBuffer(text));
}

function apiUrl(
	repository: GitHubRepository,
	tagName: string,
): string {
	return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases/tags/${encodeURIComponent(tagName)}`;
}

function downloadUrl(
	repository: GitHubRepository,
	tagName: string,
	assetName: string,
): string {
	return `https://github.com/${repository.owner}/${repository.repo}/releases/download/${tagName}/${assetName}`;
}

function remoteManifestJson(
	pluginId: string,
	version: string,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id: pluginId,
		name: `Plugin ${pluginId}`,
		author: "Example Author",
		version,
		minAppVersion: "1.7.2",
		description: "Example plugin",
		isDesktopOnly: false,
		...overrides,
	});
}

interface ReleaseFixture {
	readonly payload: Record<string, unknown>;
	readonly manifestText: string;
	readonly manifestUrl: string;
}

function createReleaseFixture(
	pluginId: string,
	version: string,
	tagName = version,
	repository: GitHubRepository = DEFAULT_REPOSITORY,
	manifestText = remoteManifestJson(pluginId, version),
): ReleaseFixture {
	const manifestUrl = downloadUrl(repository, tagName, "manifest.json");
	return {
		manifestText,
		manifestUrl,
		payload: {
			id: 100,
			tag_name: tagName,
			draft: false,
			prerelease: false,
			published_at: "2026-08-30T12:00:00Z",
			assets: [
				{
					id: 1,
					name: "main.js",
					state: "uploaded",
					size: 5_250_000,
					digest: VALID_DIGEST,
					browser_download_url: downloadUrl(repository, tagName, "main.js"),
				},
				{
					id: 2,
					name: "manifest.json",
					state: "uploaded",
					size: toArrayBuffer(manifestText).byteLength,
					digest: VALID_DIGEST,
					browser_download_url: manifestUrl,
				},
			],
		},
	};
}

function releaseAssets(payload: Record<string, unknown>): Array<Record<string, unknown>> {
	const assets = payload.assets;
	if (!Array.isArray(assets)) {
		throw new Error("Expected release fixture assets.");
	}
	return assets as Array<Record<string, unknown>>;
}

function releaseAsset(
	payload: Record<string, unknown>,
	assetName: string,
): Record<string, unknown> {
	const asset = releaseAssets(payload).find(candidate => candidate.name === assetName);
	if (asset === undefined) {
		throw new Error(`Missing fixture asset ${assetName}.`);
	}
	return asset;
}

function discoveredPlugin(
	pluginId: string,
	repository: GitHubRepository | null = DEFAULT_REPOSITORY,
	version = "1.2.3",
): DiscoveredPluginRecord {
	return {
		status: "discovered",
		pluginId,
		pluginPath: `.custom/plugins/${pluginId}`,
		repository,
		manifest: {
			id: pluginId,
			name: `Plugin ${pluginId}`,
			author: "Example Author",
			version,
			minAppVersion: "1.7.2",
			description: "Example plugin",
			isDesktopOnly: false,
		},
		artifacts: [],
		reason: null,
	};
}

function discoveryResult(
	plugins: LocalDiscoveryResult["plugins"],
	status: LocalDiscoveryResult["status"] = "completed",
): LocalDiscoveryResult {
	return {
		status,
		pluginRoot: ".custom/plugins",
		plugins,
		issues: [],
	};
}

function context(http: FakeRemoteHttp, now = 1_000_000): RemoteResolverContext {
	return {
		http: request => http.send(request),
		now: () => now,
		sleep: () => Promise.resolve(),
		runWithTimeout: operation => operation(),
	};
}

function enqueueResolved(
	http: FakeRemoteHttp,
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	fixture: ReleaseFixture,
	tagName = plugin.manifest.version,
	headers: Record<string, string> = {
		"x-ratelimit-limit": "60",
		"x-ratelimit-remaining": "59",
		"x-ratelimit-reset": "2000000000",
	},
): void {
	http.enqueue(apiUrl(plugin.repository, tagName), jsonResponse(200, fixture.payload, headers));
	http.enqueue(
		fixture.manifestUrl,
		textResponse(200, fixture.manifestText, {}, toArrayBuffer(fixture.manifestText)),
	);
}

describe("remote target selection", () => {
	it("requests only discovered plugins with trusted repository mappings", async () => {
		const http = new FakeRemoteHttp();
		const mapped = discoveredPlugin("zeta");
		const fixture = createReleaseFixture("zeta", "1.2.3");
		enqueueResolved(http, mapped as DiscoveredPluginRecord & { repository: GitHubRepository }, fixture);
		const broken: UnverifiablePluginRecord = {
			status: "unverifiable",
			pluginId: "broken",
			pluginPath: ".custom/plugins/broken",
			repository: DEFAULT_REPOSITORY,
			manifest: null,
			artifacts: [],
			reason: { code: "manifest-missing", message: "Missing." },
		};
		const absent: ConfiguredMissingPluginRecord = {
			status: "configured-missing",
			pluginId: "absent",
			pluginPath: ".custom/plugins/absent",
			repository: DEFAULT_REPOSITORY,
			manifest: null,
			artifacts: [],
			reason: { code: "configured-plugin-missing", message: "Missing." },
		};

		const result = await resolveRemoteReleases(
			discoveryResult([mapped, discoveredPlugin("alpha", null), broken, absent]),
			context(http),
		);

		expect(result.status).toBe("completed");
		expect(result.records.map(record => [record.pluginId, record.status])).toEqual([
			["absent", "skipped"],
			["alpha", "skipped"],
			["broken", "skipped"],
			["zeta", "resolved"],
		]);
		expect(result.requestCount).toBe(2);
		expect(http.calls.map(call => call.url)).toEqual([
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			fixture.manifestUrl,
		]);
		expect(http.calls.some(call => call.url.endsWith("/main.js"))).toBe(false);
		expect(http.calls.some(call => call.url.endsWith("/styles.css"))).toBe(false);
	});

	it("returns a batch error without network requests after global local-discovery failure", async () => {
		const http = new FakeRemoteHttp();
		const result = await resolveRemoteReleases(
			discoveryResult([], "error"),
			context(http),
		);

		expect(result.status).toBe("error");
		expect(result.reason?.code).toBe("local-discovery-error");
		expect(http.calls).toEqual([]);
	});
});

describe("exact release selection", () => {
	it("resolves the exact tag and validates the remote manifest", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3");
		enqueueResolved(http, plugin, fixture);

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));
		const record = result.records[0];

		expect(record?.status).toBe("resolved");
		if (record?.status === "resolved") {
			expect(record.release.tagName).toBe("1.2.3");
			expect(record.release.manifest.id).toBe("operon");
			expect(new TextDecoder().decode(record.release.manifestBytes)).toBe(fixture.manifestText);
			expect(record.release.assets.map(asset => asset.assetName)).toEqual([
				"main.js",
				"manifest.json",
			]);
		}
		expect(record?.requestCount).toBe(2);
	});

	it("falls back to the v-prefixed tag only after an exact 404", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3", "v1.2.3");
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), textResponse(404, "{}"));
		enqueueResolved(http, plugin, fixture, "v1.2.3");

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.status).toBe("resolved");
		expect(result.requestCount).toBe(3);
		expect(http.calls.map(call => call.url)).toEqual([
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			apiUrl(DEFAULT_REPOSITORY, "v1.2.3"),
			fixture.manifestUrl,
		]);
	});

	it("reports unsupported after both exact tags return 404", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon");
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), textResponse(404, "{}"));
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "v1.2.3"), textResponse(404, "{}"));

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.status).toBe("unsupported");
		expect(result.records[0]?.requestCount).toBe(2);
		expect(result.records[0]?.reason?.code).toBe("exact-release-not-found");
	});

	it.each([
		{ field: "draft", value: true, code: "draft-release-unsupported" },
		{ field: "prerelease", value: true, code: "prerelease-unsupported" },
		{ field: "tag_name", value: "another-tag", code: "release-tag-mismatch" },
	])("does not fall back after a 200 response with invalid $field", async ({ field, value, code }) => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon");
		const fixture = createReleaseFixture("operon", "1.2.3");
		fixture.payload[field] = value;
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, fixture.payload));

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.reason?.code).toBe(code);
		expect(http.calls).toHaveLength(1);
	});

	it("encodes semantic-version path segments and sends fixed API headers", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon", DEFAULT_REPOSITORY, "1.2.3+build.1") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3+build.1");
		enqueueResolved(http, plugin, fixture);

		await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(http.calls[0]?.url).toContain("1.2.3%2Bbuild.1");
		expect(http.calls[0]?.method).toBe("GET");
		expect(http.calls[0]?.throw).toBe(false);
		expect(http.calls[0]?.headers.Accept).toBe("application/vnd.github+json");
		expect(http.calls[0]?.headers["X-GitHub-Api-Version"]).toBe(GITHUB_API_VERSION);
	});
});

describe("release response and asset trust", () => {
	it.each([
		{ name: "invalid release ID", mutate: (payload: Record<string, unknown>): void => { payload.id = 0; }, code: "invalid-release-id" },
		{ name: "invalid publication time", mutate: (payload: Record<string, unknown>): void => { payload.published_at = "not-a-date"; }, code: "invalid-release-published-at" },
		{ name: "invalid asset collection", mutate: (payload: Record<string, unknown>): void => { payload.assets = {}; }, code: "invalid-release-assets" },
	])("rejects $name", async ({ mutate, code }) => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon");
		const fixture = createReleaseFixture("operon", "1.2.3");
		mutate(fixture.payload);
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, fixture.payload));

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.status).toBe("unverifiable");
		expect(result.records[0]?.reason?.code).toBe(code);
	});

	it("rejects invalid JSON and oversized API responses", async () => {
		const invalidJsonHttp = new FakeRemoteHttp();
		invalidJsonHttp.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), textResponse(200, "{"));
		const invalidResult = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(invalidJsonHttp),
		);

		const oversizedHttp = new FakeRemoteHttp();
		oversizedHttp.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			textResponse(200, "{}", {}, new ArrayBuffer(MAX_RELEASE_RESPONSE_BYTES + 1)),
		);
		const oversizedResult = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(oversizedHttp),
		);

		expect(invalidResult.records[0]?.reason?.code).toBe("response-invalid-json");
		expect(oversizedResult.records[0]?.reason?.code).toBe("response-too-large");
	});

	it("allows optional styles and ignores unrelated assets", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3");
		releaseAssets(fixture.payload).push({
			id: 99,
			name: "plugin.zip",
			state: "starter",
			size: -1,
			digest: null,
			browser_download_url: "https://evil.example/plugin.zip",
		});
		enqueueResolved(http, plugin, fixture);

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.status).toBe("resolved");
	});

	it("rejects missing and duplicate required assets", async () => {
		const missingHttp = new FakeRemoteHttp();
		const missingFixture = createReleaseFixture("operon", "1.2.3");
		missingFixture.payload.assets = releaseAssets(missingFixture.payload)
			.filter(asset => asset.name !== "main.js");
		missingHttp.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, missingFixture.payload));
		const missingResult = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(missingHttp),
		);

		const duplicateHttp = new FakeRemoteHttp();
		const duplicateFixture = createReleaseFixture("operon", "1.2.3");
		releaseAssets(duplicateFixture.payload).push({
			...releaseAsset(duplicateFixture.payload, "main.js"),
			id: 44,
		});
		duplicateHttp.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, duplicateFixture.payload));
		const duplicateResult = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(duplicateHttp),
		);

		expect(missingResult.records[0]?.status).toBe("unsupported");
		expect(missingResult.records[0]?.reason?.code).toBe("required-release-asset-missing");
		expect(duplicateResult.records[0]?.status).toBe("unverifiable");
		expect(duplicateResult.records[0]?.reason?.code).toBe("duplicate-release-asset");
	});

	it.each([
		{ name: "starter state", field: "state", value: "starter", code: "asset-not-uploaded" },
		{ name: "negative size", field: "size", value: -1, code: "invalid-asset-size" },
		{ name: "missing digest", field: "digest", value: null, code: "invalid-asset-digest" },
		{ name: "wrong digest", field: "digest", value: "sha256:abc", code: "invalid-asset-digest" },
		{ name: "foreign URL", field: "browser_download_url", value: "https://evil.example/main.js", code: "invalid-asset-download-url" },
	])("rejects an asset with $name", async ({ field, value, code }) => {
		const http = new FakeRemoteHttp();
		const fixture = createReleaseFixture("operon", "1.2.3");
		releaseAsset(fixture.payload, "main.js")[field] = value;
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, fixture.payload));

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http),
		);

		expect(result.records[0]?.status).toBe("unverifiable");
		expect(result.records[0]?.reason?.code).toBe(code);
		expect(http.calls).toHaveLength(1);
	});
});

describe("remote manifest trust", () => {
	it("rejects a manifest whose metadata size exceeds the safety limit without downloading it", async () => {
		const http = new FakeRemoteHttp();
		const fixture = createReleaseFixture("operon", "1.2.3");
		releaseAsset(fixture.payload, "manifest.json").size = 65_537;
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, fixture.payload));

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http),
		);

		expect(result.records[0]?.reason?.code).toBe("remote-manifest-size-out-of-range");
		expect(http.calls).toHaveLength(1);
	});

	it.each([
		{
			name: "invalid JSON",
			manifestText: "{",
			expectedCode: "remote-manifest-invalid-json",
		},
		{
			name: "wrong plugin ID",
			manifestText: remoteManifestJson("another-plugin", "1.2.3"),
			expectedCode: "remote-manifest-id-mismatch",
		},
		{
			name: "wrong version",
			manifestText: remoteManifestJson("operon", "9.9.9"),
			expectedCode: "remote-manifest-version-mismatch",
		},
	])("rejects a remote manifest with $name", async ({ manifestText, expectedCode }) => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3", "1.2.3", DEFAULT_REPOSITORY, manifestText);
		enqueueResolved(http, plugin, fixture);

		const result = await resolveRemoteReleases(discoveryResult([plugin]), context(http));

		expect(result.records[0]?.status).toBe("unverifiable");
		expect(result.records[0]?.reason?.code).toBe(expectedCode);
	});

	it("rejects manifest HTTP, byte-length, and UTF-8 failures", async () => {
		const plugin = discoveredPlugin("operon");

		const httpError = new FakeRemoteHttp();
		const httpFixture = createReleaseFixture("operon", "1.2.3");
		httpError.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, httpFixture.payload));
		httpError.enqueue(
			httpFixture.manifestUrl,
			textResponse(503, ""),
			textResponse(503, ""),
			textResponse(503, ""),
		);
		const httpResult = await resolveRemoteReleases(discoveryResult([plugin]), context(httpError));

		const sizeError = new FakeRemoteHttp();
		const sizeFixture = createReleaseFixture("operon", "1.2.3");
		sizeError.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, sizeFixture.payload));
		sizeError.enqueue(sizeFixture.manifestUrl, textResponse(200, "{}"));
		const sizeResult = await resolveRemoteReleases(discoveryResult([plugin]), context(sizeError));

		const utf8Error = new FakeRemoteHttp();
		const utf8Fixture = createReleaseFixture("operon", "1.2.3", "1.2.3", DEFAULT_REPOSITORY, "x");
		utf8Error.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), jsonResponse(200, utf8Fixture.payload));
		utf8Error.enqueue(
			utf8Fixture.manifestUrl,
			textResponse(200, "", {}, new Uint8Array([0xff]).buffer),
		);
		const utf8Result = await resolveRemoteReleases(discoveryResult([plugin]), context(utf8Error));

		expect(httpResult.records[0]?.reason?.code).toBe("github-temporary-server-error");
		const httpRecord = httpResult.records[0];
		if (httpRecord?.status === "error") {
			expect(httpRecord.failureKind).toBe("temporary-server");
		}
		expect(sizeResult.records[0]?.reason?.code).toBe("remote-manifest-size-mismatch");
		expect(utf8Result.records[0]?.reason?.code).toBe("remote-manifest-invalid-utf8");
	});
});

describe("rate limits, failures, and sequential ordering", () => {
	it("finishes the current manifest and defers later targets when remaining reaches zero", async () => {
		const http = new FakeRemoteHttp();
		const alpha = discoveredPlugin("alpha") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const zeta = discoveredPlugin("zeta");
		const fixture = createReleaseFixture("alpha", "1.2.3");
		enqueueResolved(http, alpha, fixture, "1.2.3", {
			"x-ratelimit-limit": "60",
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": "2000000000",
		});

		const result = await resolveRemoteReleases(
			discoveryResult([zeta, alpha]),
			context(http),
		);

		expect(result.status).toBe("partial");
		expect(result.records.map(record => [record.pluginId, record.status, record.requestCount])).toEqual([
			["alpha", "resolved", 2],
			["zeta", "deferred", 0],
		]);
		expect(result.requestCount).toBe(2);
		expect(result.rateLimit?.remaining).toBe(0);
	});

	it("defers the current and remaining targets on a rate-limited 403", async () => {
		const http = new FakeRemoteHttp();
		http.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			textResponse(403, "{}", {
				"X-RateLimit-Remaining": "0",
				"X-RateLimit-Reset": "2000000000",
			}),
		);

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("alpha"), discoveredPlugin("zeta")]),
			context(http),
		);

		expect(result.records.map(record => record.status)).toEqual(["deferred", "deferred"]);
		expect(result.records[0]?.retryAtMs).toBe(2_000_000_000_000);
		expect(result.records[1]?.requestCount).toBe(0);
		expect(http.calls).toHaveLength(1);
	});

	it("uses Retry-After for a 429 without scheduling a retry", async () => {
		const http = new FakeRemoteHttp();
		http.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			textResponse(429, "{}", { "Retry-After": "30" }),
		);

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http, 1_000_000),
		);

		expect(result.records[0]?.status).toBe("deferred");
		expect(result.records[0]?.retryAtMs).toBe(1_030_000);
		expect(http.calls).toHaveLength(1);
	});

	it("uses Retry-After for a rate-limited 403 without scheduling a retry", async () => {
		const http = new FakeRemoteHttp();
		http.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			textResponse(403, "{}", { "Retry-After": "45" }),
		);

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http, 1_000_000),
		);

		expect(result.records[0]?.status).toBe("deferred");
		expect(result.records[0]?.retryAtMs).toBe(1_045_000);
		expect(http.calls).toHaveLength(1);
	});

	it.each([400, 401, 418, 422])("does not retry HTTP %i", async status => {
		const http = new FakeRemoteHttp();
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), textResponse(status, "{}"));

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http),
		);

		expect(result.records[0]?.status).toBe("error");
		expect(http.calls).toHaveLength(1);
	});

	it("does not retry a normal 403 and continues with the next target", async () => {
		const http = new FakeRemoteHttp();
		const alpha = discoveredPlugin("alpha");
		const zeta = discoveredPlugin("zeta") as DiscoveredPluginRecord & { repository: GitHubRepository };
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), textResponse(403, "{}"));
		const fixture = createReleaseFixture("zeta", "1.2.3");
		enqueueResolved(http, zeta, fixture);

		const result = await resolveRemoteReleases(
			discoveryResult([zeta, alpha]),
			context(http),
		);

		expect(result.status).toBe("partial");
		expect(result.records.map(record => [record.pluginId, record.status])).toEqual([
			["alpha", "error"],
			["zeta", "resolved"],
		]);
		expect(result.records[0]?.reason?.code).toBe("github-http-error");
		expect(http.calls).toHaveLength(3);
	});

	it.each([
		{
			name: "server failure",
			responses: [textResponse(503, "{}"), textResponse(503, "{}"), textResponse(503, "{}")],
			code: "github-temporary-server-error",
			kind: "temporary-server",
		},
		{
			name: "transport failure",
			responses: [new Error("offline"), new Error("offline"), new Error("offline")],
			code: "github-connection-unavailable",
			kind: "connection",
		},
	])("opens the batch circuit breaker after exhausted $name retries", async ({ responses, code, kind }) => {
		const http = new FakeRemoteHttp();
		http.enqueue(apiUrl(DEFAULT_REPOSITORY, "1.2.3"), ...responses);

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("zeta"), discoveredPlugin("alpha")]),
			context(http),
		);

		expect(result.status).toBe("partial");
		expect(result.records.map(record => [record.pluginId, record.status, record.requestCount])).toEqual([
			["alpha", "error", 3],
			["zeta", "deferred", 0],
		]);
		expect(result.records[0]?.reason?.code).toBe(code);
		for (const record of result.records) {
			if (record.status === "error" || record.status === "deferred") {
				expect(record.failureKind).toBe(kind);
			}
		}
		expect(http.calls).toHaveLength(3);
	});

	it.each([
		"UnknownHostException: Unable to resolve host api.github.com",
		"NSURLErrorDomain Code=-1009 The Internet connection appears to be offline.",
	])("keeps platform transport text technical while returning a friendly reason", async platformMessage => {
		const http = new FakeRemoteHttp();
		http.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			new Error(platformMessage),
			new Error(platformMessage),
			new Error(platformMessage),
		);

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			context(http),
		);
		const record = result.records[0];
		if (record?.status !== "error") {
			throw new Error("Expected a remote error record.");
		}

		expect(record.reason.message).toContain("couldn't reach GitHub");
		expect(record.reason.message).not.toContain(platformMessage);
		expect(record.technicalMessage).toBe(platformMessage);
		expect(record.failureKind).toBe("connection");
	});

	it.each([408, 425, 500, 502, 503, 504])(
		"retries HTTP %i and succeeds on the second attempt",
		async status => {
			const http = new FakeRemoteHttp();
			const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
			const fixture = createReleaseFixture("operon", "1.2.3");
			http.enqueue(
				apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
				textResponse(status, "{}"),
				jsonResponse(200, fixture.payload),
			);
			http.enqueue(
				fixture.manifestUrl,
				textResponse(200, fixture.manifestText, {}, toArrayBuffer(fixture.manifestText)),
			);
			const delays: number[] = [];

			const result = await resolveRemoteReleases(discoveryResult([plugin]), {
				...context(http),
				sleep: delayMs => {
					delays.push(delayMs);
					return Promise.resolve();
				},
			});

			expect(result.records[0]?.status).toBe("resolved");
			expect(delays).toEqual([3_000]);
			expect(http.calls).toHaveLength(3);
		},
	);

	it("uses the third attempt after the 3 and 8 second retry delays", async () => {
		const http = new FakeRemoteHttp();
		const plugin = discoveredPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const fixture = createReleaseFixture("operon", "1.2.3");
		http.enqueue(
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			new Error("offline"),
			new Error("offline"),
			jsonResponse(200, fixture.payload),
		);
		http.enqueue(
			fixture.manifestUrl,
			textResponse(200, fixture.manifestText, {}, toArrayBuffer(fixture.manifestText)),
		);
		const delays: number[] = [];

		const result = await resolveRemoteReleases(discoveryResult([plugin]), {
			...context(http),
			sleep: delayMs => {
				delays.push(delayMs);
				return Promise.resolve();
			},
		});

		expect(result.records[0]?.status).toBe("resolved");
		expect(delays).toEqual([3_000, 8_000]);
	});

	it("caps each attempt at eight seconds and the logical GET at thirty seconds", async () => {
		const http = new FakeRemoteHttp();
		let nowMs = 1_000_000;
		const timeouts: number[] = [];
		const delays: number[] = [];

		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			{
				http: request => http.send(request),
				now: () => nowMs,
				sleep: delayMs => {
					delays.push(delayMs);
					nowMs += delayMs;
					return Promise.resolve();
				},
				runWithTimeout: <T>(_operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
					timeouts.push(timeoutMs);
					nowMs += timeoutMs;
					return Promise.reject(new RemoteRequestTimeoutError());
				},
			},
		);

		expect(timeouts).toEqual([
			REMOTE_REQUEST_ATTEMPT_TIMEOUT_MS,
			REMOTE_REQUEST_ATTEMPT_TIMEOUT_MS,
			3_000,
		]);
		expect(delays).toEqual([3_000, 8_000]);
		expect(nowMs).toBe(1_030_000);
		const record = result.records[0];
		if (record?.status === "error") {
			expect(record.failureKind).toBe("timeout");
		}
		expect(result.records[0]?.reason?.code).toBe("github-request-timeout");
	});

	it("ignores native HTTP completions that arrive after all attempt timeouts", async () => {
		const completions: Array<(response: RemoteHttpResponse) => void> = [];
		const result = await resolveRemoteReleases(
			discoveryResult([discoveredPlugin("operon")]),
			{
				http: () => new Promise(resolve => {
					completions.push(resolve);
				}),
				now: () => 1_000_000,
				sleep: () => Promise.resolve(),
				runWithTimeout: <T>(operation: () => Promise<T>): Promise<T> => {
					void operation();
					return Promise.reject(new RemoteRequestTimeoutError());
				},
			},
		);
		const completedSnapshot = JSON.stringify(result);

		expect(completions).toHaveLength(3);
		expect(result.records[0]?.reason?.code).toBe("github-request-timeout");
		for (const complete of completions) {
			complete(textResponse(200, "{}"));
		}
		await flushPromises();
		expect(JSON.stringify(result)).toBe(completedSnapshot);
	});

	it("performs target requests sequentially in plugin-ID order", async () => {
		const http = new FakeRemoteHttp();
		const alpha = discoveredPlugin("alpha") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const zeta = discoveredPlugin("zeta") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const alphaFixture = createReleaseFixture("alpha", "1.2.3");
		const zetaFixture = createReleaseFixture("zeta", "1.2.3");
		enqueueResolved(http, alpha, alphaFixture);
		enqueueResolved(http, zeta, zetaFixture);

		const result = await resolveRemoteReleases(
			discoveryResult([zeta, alpha]),
			context(http),
		);

		expect(result.records.map(record => record.pluginId)).toEqual(["alpha", "zeta"]);
		expect(http.calls.map(call => call.url)).toEqual([
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			alphaFixture.manifestUrl,
			apiUrl(DEFAULT_REPOSITORY, "1.2.3"),
			zetaFixture.manifestUrl,
		]);
	});
});

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
