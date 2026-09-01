import { describe, expect, it } from "vitest";

import {
	COMMUNITY_PLUGIN_CATALOG_URL,
	CommunityPluginCatalogSession,
	fetchCommunityPluginCatalog,
	lookupCommunityRepository,
	MAX_COMMUNITY_CATALOG_BYTES,
	parseCommunityPluginCatalog,
} from "../src/community-catalog";
import type {
	RemoteHttpClient,
	RemoteHttpRequest,
	RemoteHttpResponse,
} from "../src/remote-release";

function toArrayBuffer(value: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(value);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}

function response(
	status: number,
	value: unknown,
	arrayBuffer = toArrayBuffer(JSON.stringify(value)),
): RemoteHttpResponse {
	return {
		status,
		headers: {},
		arrayBuffer,
		text: JSON.stringify(value),
	};
}

class FakeHttp {
	readonly calls: RemoteHttpRequest[] = [];
	queued: Array<RemoteHttpResponse | Error> = [];

	send: RemoteHttpClient = request => {
		this.calls.push(request);
		const next = this.queued.shift();
		if (next === undefined) {
			return Promise.reject(new Error("No queued response."));
		}
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	};
}

describe("official community plugin catalog", () => {
	it("parses exact plugin ID to validated owner/repo mappings", () => {
		const result = parseCommunityPluginCatalog([
			{ id: "dataview", name: "Dataview", repo: "blacksmithgu/obsidian-dataview", extra: true },
		]);

		expect(result.status).toBe("loaded");
		expect(lookupCommunityRepository(result, "dataview")).toEqual({
			status: "resolved",
			repository: { owner: "blacksmithgu", repo: "obsidian-dataview" },
			reason: null,
		});
		expect(lookupCommunityRepository(result, "data").status).toBe("unlisted");
	});

	it("fails closed for duplicate IDs and malformed repositories without affecting other entries", () => {
		const result = parseCommunityPluginCatalog([
			{ id: "duplicate", repo: "example/one" },
			{ id: "duplicate", repo: "example/two" },
			{ id: "bad-repo", repo: "https://github.com/example/repo" },
			{ id: "healthy", repo: "example/healthy" },
			null,
		]);

		expect(lookupCommunityRepository(result, "duplicate")).toEqual(expect.objectContaining({
			status: "unavailable",
			repository: null,
		}));
		expect(lookupCommunityRepository(result, "bad-repo")).toEqual(expect.objectContaining({
			status: "unavailable",
			repository: null,
		}));
		expect(lookupCommunityRepository(result, "healthy").status).toBe("resolved");
	});

	it("uses only the fixed URL and validates HTTP, size, UTF-8, and JSON", async () => {
		const success = new FakeHttp();
		success.queued.push(response(200, [{ id: "example", repo: "owner/repo" }]));
		expect((await fetchCommunityPluginCatalog(success.send)).status).toBe("loaded");
		expect(success.calls).toEqual([{
			url: COMMUNITY_PLUGIN_CATALOG_URL,
			method: "GET",
			headers: { Accept: "application/json" },
			throw: false,
		}]);

		const cases: Array<[RemoteHttpResponse, string]> = [
			[response(503, []), "community-catalog-http-error"],
			[response(200, [], new ArrayBuffer(0)), "community-catalog-size-out-of-range"],
			[response(200, [], new ArrayBuffer(MAX_COMMUNITY_CATALOG_BYTES + 1)), "community-catalog-size-out-of-range"],
			[response(200, [], new Uint8Array([0xc3, 0x28]).buffer), "community-catalog-invalid-utf8"],
			[response(200, [], toArrayBuffer("{")), "community-catalog-invalid-json"],
		];
		for (const [fakeResponse, reasonCode] of cases) {
			const http = new FakeHttp();
			http.queued.push(fakeResponse);
			const result = await fetchCommunityPluginCatalog(http.send);
			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.code).toBe(reasonCode);
			}
		}
	});

	it("memoizes one session request and retries only when explicitly requested", async () => {
		const http = new FakeHttp();
		http.queued.push(
			response(500, []),
			response(200, [{ id: "example", repo: "owner/repo" }]),
		);
		const session = new CommunityPluginCatalogSession(http.send);

		expect(http.calls).toEqual([]);
		const first = session.load();
		const joined = session.load();
		expect(joined).toBe(first);
		expect((await first).status).toBe("error");
		expect(http.calls).toHaveLength(1);
		expect((await session.load()).status).toBe("error");
		expect(http.calls).toHaveLength(1);
		expect((await session.retry()).status).toBe("loaded");
		expect(http.calls).toHaveLength(2);
	});
});
