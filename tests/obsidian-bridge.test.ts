import { describe, expect, it } from "vitest";

import {
	createRemoteHttpClient,
	executeObsidianAppReload,
} from "../src/obsidian-bridge";

describe("Obsidian requestUrl bridge", () => {
	it("forwards only the trusted request fields and normalizes the response", async () => {
		const calls: unknown[] = [];
		const client = createRemoteHttpClient(request => {
			calls.push(request);
			return Promise.resolve({
				status: 200,
				headers: { "x-ratelimit-remaining": "59" },
				arrayBuffer: new ArrayBuffer(3),
				json: { ignored: true },
				text: "abc",
			});
		});

		const response = await client({
			url: "https://api.github.com/example",
			method: "GET",
			headers: { Accept: "application/vnd.github+json" },
			throw: false,
		});

		expect(calls).toEqual([{
			url: "https://api.github.com/example",
			method: "GET",
			headers: { Accept: "application/vnd.github+json" },
			throw: false,
		}]);
		expect(response.status).toBe(200);
		expect(response.headers).toEqual({ "x-ratelimit-remaining": "59" });
		expect(response.arrayBuffer).toBeInstanceOf(ArrayBuffer);
		expect(response.arrayBuffer.byteLength).toBe(3);
		expect(response.text).toBe("abc");
	});
});

describe("Obsidian reload command bridge", () => {
	it("feature-detects and invokes only the built-in app reload command", () => {
		const calls: string[] = [];
		expect(executeObsidianAppReload({
			commands: {
				executeCommandById: (commandId: string): void => {
					calls.push(commandId);
				},
			},
		})).toBe(true);
		expect(calls).toEqual(["app:reload"]);
	});

	it("fails closed when the command surface is missing or throws", () => {
		expect(executeObsidianAppReload({})).toBe(false);
		expect(executeObsidianAppReload({
			commands: {
				executeCommandById: (): never => {
					throw new Error("unavailable");
				},
			},
		})).toBe(false);
	});

	it("fails closed when Obsidian declines to execute the reload command", () => {
		expect(executeObsidianAppReload({
			commands: {
				executeCommandById: (): boolean => false,
			},
		})).toBe(false);
	});
});
