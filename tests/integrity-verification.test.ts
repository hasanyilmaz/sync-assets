import type { Stat } from "obsidian";
import { describe, expect, it } from "vitest";

import {
	OBSIDIAN_NO_SOURCE_MAP_SUFFIX,
	type GitHubRepository,
	type ReleaseAssetName,
} from "../src/domain";
import {
	MAX_HASHABLE_ARTIFACT_BYTES,
	sha256ArrayBuffer,
	verifyPluginIntegrity,
	type EvaluatedIntegrityRecord,
	type IntegrityAdapter,
	type IntegrityVerificationBatch,
	type Sha256Function,
} from "../src/integrity-verification";
import type {
	ConfiguredMissingPluginRecord,
	DiscoveredPluginRecord,
	LocalArtifactSnapshot,
	LocalDiscoveryResult,
} from "../src/local-discovery";
import type {
	RemoteResolutionBatch,
	RemoteResolutionRecord,
	ResolvedRemoteRecord,
	TrustedReleaseAsset,
} from "../src/remote-release";

const REPOSITORY = { owner: "example", repo: "plugin-repo" };

function toArrayBuffer(value: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(value);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function digestForText(value: string): string {
	const seed = Array.from(value).reduce((sum, character) => (
		(sum + (character.codePointAt(0) ?? 0)) % 16
	), 0);
	return `sha256:${seed.toString(16).repeat(64)}`;
}

const LARGE_DIGEST = `sha256:${"f".repeat(64)}`;

class FakeSha256 {
	readonly calls: Array<{ readonly byteLength: number; readonly text: string | null }> = [];
	readonly errors = new Set<string>();

	hash: Sha256Function = bytes => {
		const text = bytes.byteLength > 1_000_000
			? null
			: new TextDecoder().decode(bytes);
		this.calls.push({ byteLength: bytes.byteLength, text });
		if (text !== null && this.errors.has(text)) {
			return Promise.reject(new Error("hash failed"));
		}
		return Promise.resolve(text === null ? LARGE_DIGEST : digestForText(text));
	};
}

interface FakeNode {
	readonly bytes: ArrayBuffer;
	readonly stat: Stat;
}

class FakeIntegrityAdapter implements IntegrityAdapter {
	readonly calls: string[] = [];
	readonly nodes = new Map<string, FakeNode>();
	readonly statErrors = new Map<string, Error>();
	readonly readErrors = new Map<string, Error>();
	readonly statQueues = new Map<string, Array<Stat | null | Error>>();
	activeReads = 0;
	maxActiveReads = 0;

	setFile(
		path: string,
		content: string | ArrayBuffer,
		options: { readonly size?: number; readonly mtime?: number } = {},
	): void {
		const bytes = typeof content === "string" ? toArrayBuffer(content) : content;
		this.nodes.set(path, {
			bytes,
			stat: {
				type: "file",
				ctime: 1,
				mtime: options.mtime ?? 1,
				size: options.size ?? bytes.byteLength,
			},
		});
	}

	setFolder(path: string): void {
		this.nodes.set(path, {
			bytes: new ArrayBuffer(0),
			stat: { type: "folder", ctime: 1, mtime: 1, size: 0 },
		});
	}

	queueStats(path: string, ...values: Array<Stat | null | Error>): void {
		this.statQueues.set(path, values);
	}

	stat(path: string): Promise<Stat | null> {
		this.calls.push(`stat:${path}`);
		const queued = this.statQueues.get(path);
		const next = queued?.shift();
		if (next instanceof Error) {
			return Promise.reject(next);
		}
		if (next !== undefined) {
			return Promise.resolve(next);
		}
		const error = this.statErrors.get(path);
		if (error !== undefined) {
			return Promise.reject(error);
		}
		return Promise.resolve(this.nodes.get(path)?.stat ?? null);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		this.calls.push(`readBinary:${path}`);
		const error = this.readErrors.get(path);
		if (error !== undefined) {
			throw error;
		}
		const node = this.nodes.get(path);
		if (node === undefined) {
			throw new Error("missing fake binary");
		}
		this.activeReads += 1;
		this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
		await Promise.resolve();
		this.activeReads -= 1;
		return node.bytes.slice(0);
	}
}

function manifest(pluginId: string, version = "1.2.3"): DiscoveredPluginRecord["manifest"] {
	return {
		id: pluginId,
		name: `Plugin ${pluginId}`,
		author: "Example Author",
		version,
		minAppVersion: "1.7.2",
		description: "Example plugin",
		isDesktopOnly: false,
	};
}

function manifestText(pluginId: string, version = "1.2.3"): string {
	return JSON.stringify(manifest(pluginId, version));
}

function artifactSnapshots(pluginPath: string): LocalArtifactSnapshot[] {
	return (["main.js", "manifest.json", "styles.css"] as const).map(assetName => ({
		assetName,
		path: `${pluginPath}/${assetName}`,
		state: "file",
		sizeBytes: 1,
		reason: null,
	}));
}

function localPlugin(
	pluginId: string,
	repository: GitHubRepository | null = REPOSITORY,
	version = "1.2.3",
): DiscoveredPluginRecord {
	const pluginPath = `.custom/plugins/${pluginId}`;
	return {
		status: "discovered",
		pluginId,
		pluginPath,
		repository,
		manifest: manifest(pluginId, version),
		artifacts: artifactSnapshots(pluginPath),
		reason: null,
	};
}

interface ResolvedOptions {
	readonly mainContent?: string;
	readonly mainSize?: number;
	readonly mainDigest?: string;
	readonly manifestBytes?: ArrayBuffer;
	readonly manifestDigest?: string;
	readonly stylesContent?: string;
}

function trustedAsset(
	assetId: number,
	assetName: ReleaseAssetName,
	sizeBytes: number,
	sha256: string,
): TrustedReleaseAsset {
	return {
		assetId,
		assetName,
		sizeBytes,
		sha256,
		downloadUrl: `https://github.com/example/plugin-repo/releases/download/1.2.3/${assetName}`,
	};
}

function resolvedRecord(
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	options: ResolvedOptions = {},
): ResolvedRemoteRecord {
	const remoteManifestText = manifestText(plugin.pluginId, plugin.manifest.version);
	const remoteManifestBytes = options.manifestBytes ?? toArrayBuffer(remoteManifestText);
	const mainContent = options.mainContent ?? `main-${plugin.pluginId}`;
	const assets: TrustedReleaseAsset[] = [
		trustedAsset(
			1,
			"main.js",
			options.mainSize ?? toArrayBuffer(mainContent).byteLength,
			options.mainDigest ?? digestForText(mainContent),
		),
		trustedAsset(
			2,
			"manifest.json",
			remoteManifestBytes.byteLength,
			options.manifestDigest ?? digestForText(remoteManifestText),
		),
	];
	if (options.stylesContent !== undefined) {
		assets.push(trustedAsset(
			3,
			"styles.css",
			toArrayBuffer(options.stylesContent).byteLength,
			digestForText(options.stylesContent),
		));
	}

	return {
		status: "resolved",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		requestCount: 2,
		rateLimit: null,
		release: {
			repository: plugin.repository,
			releaseId: 100,
			tagName: plugin.manifest.version,
			publishedAt: "2026-08-30T12:00:00Z",
			assets,
			manifest: plugin.manifest,
			manifestBytes: remoteManifestBytes,
		},
		reason: null,
		retryAtMs: null,
	};
}

function discovery(plugins: LocalDiscoveryResult["plugins"]): LocalDiscoveryResult {
	return {
		status: "completed",
		pluginRoot: ".custom/plugins",
		plugins,
		issues: [],
	};
}

function remoteBatch(
	records: readonly RemoteResolutionRecord[],
	status: RemoteResolutionBatch["status"] = "completed",
): RemoteResolutionBatch {
	return {
		status,
		records,
		requestCount: records.reduce((sum, record) => sum + record.requestCount, 0),
		rateLimit: null,
		reason: null,
	};
}

function installMatchingPlugin(
	adapter: FakeIntegrityAdapter,
	plugin: DiscoveredPluginRecord,
	options: { readonly mainContent?: string; readonly stylesContent?: string } = {},
): void {
	adapter.setFile(`${plugin.pluginPath}/main.js`, options.mainContent ?? `main-${plugin.pluginId}`);
	adapter.setFile(`${plugin.pluginPath}/manifest.json`, manifestText(plugin.pluginId, plugin.manifest.version));
	if (options.stylesContent !== undefined) {
		adapter.setFile(`${plugin.pluginPath}/styles.css`, options.stylesContent);
	}
}

function evaluated(
	batch: IntegrityVerificationBatch,
	pluginId: string,
): EvaluatedIntegrityRecord {
	const record = batch.records.find(candidate => candidate.pluginId === pluginId);
	if (record?.outcome !== "evaluated") {
		throw new Error(`Expected evaluated record for ${pluginId}.`);
	}
	return record;
}

function artifact(
	record: EvaluatedIntegrityRecord,
	assetName: ReleaseAssetName,
): EvaluatedIntegrityRecord["result"]["artifacts"][number] {
	const result = record.result.artifacts.find(candidate => candidate.assetName === assetName);
	if (result === undefined) {
		throw new Error(`Expected ${assetName} result.`);
	}
	return result;
}

describe("Web Crypto SHA-256", () => {
	it("produces a normalized digest for a known vector", async () => {
		await expect(sha256ArrayBuffer(toArrayBuffer("abc"))).resolves.toBe(
			"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("integrity verification", () => {
	it("verifies matching artifacts in allowlist order and treats absent optional styles as healthy", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin);

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin)]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "operon");

		expect(result.status).toBe("completed");
		expect(record.status).toBe("healthy");
		expect(record.result.artifacts.map(found => found.assetName)).toEqual([
			"main.js",
			"manifest.json",
			"styles.css",
		]);
		expect(artifact(record, "main.js")).toEqual(expect.objectContaining({
			status: "healthy",
			hashStatus: "computed",
			repairEligible: false,
		}));
		expect(artifact(record, "styles.css")).toEqual(expect.objectContaining({
			status: "healthy",
			expected: null,
			local: { exists: false, sizeBytes: null, sha256: null },
			hashStatus: "not-required",
		}));
		expect(adapter.maxActiveReads).toBe(1);
		expect(adapter.calls.filter(call => call.startsWith("readBinary:"))).toEqual([
			"readBinary:.custom/plugins/operon/main.js",
			"readBinary:.custom/plugins/operon/manifest.json",
		]);
	});

	it("checks size before reading or hashing a mismatched local artifact", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin);
		adapter.setFile(`${plugin.pluginPath}/main.js`, "short");

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { mainContent: "expected-main" })]),
			{ adapter, sha256: sha.hash },
		);
		const main = artifact(evaluated(result, "operon"), "main.js");

		expect(main).toEqual(expect.objectContaining({
			status: "mismatched",
			hashStatus: "not-computed",
			repairEligible: true,
		}));
		expect(adapter.calls).not.toContain("readBinary:.custom/plugins/operon/main.js");
		expect(sha.calls.some(call => call.text === "short")).toBe(false);
	});

	it("accepts Obsidian's exact nosourcemap suffix when the canonical main.js matches", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		const expectedMain = "expected-main";
		installMatchingPlugin(adapter, plugin, {
			mainContent: `${expectedMain}${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`,
		});

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { mainContent: expectedMain })]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "operon");
		const main = artifact(record, "main.js");

		expect(record.status).toBe("healthy");
		expect(main).toEqual(expect.objectContaining({
			status: "healthy",
			hashStatus: "computed",
			repairEligible: false,
			acceptedVariant: "obsidian-nosourcemap-suffix",
			local: {
				exists: true,
				sizeBytes: expectedMain.length + OBSIDIAN_NO_SOURCE_MAP_SUFFIX.length,
				sha256: digestForText(expectedMain),
			},
		}));
		expect(sha.calls.some(call => call.text === expectedMain)).toBe(true);
		expect(sha.calls.some(call => call.text === `${expectedMain}${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`)).toBe(false);
	});

	it("rejects an arbitrary same-length main.js suffix without hashing it", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		const expectedMain = "expected-main";
		const wrongSuffix = "x".repeat(OBSIDIAN_NO_SOURCE_MAP_SUFFIX.length);
		installMatchingPlugin(adapter, plugin, { mainContent: `${expectedMain}${wrongSuffix}` });

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { mainContent: expectedMain })]),
			{ adapter, sha256: sha.hash },
		);
		const main = artifact(evaluated(result, "operon"), "main.js");

		expect(main).toEqual(expect.objectContaining({
			status: "mismatched",
			hashStatus: "not-computed",
			repairEligible: true,
			acceptedVariant: null,
		}));
		expect(sha.calls.some(call => call.text?.includes(wrongSuffix) === true)).toBe(false);
	});

	it("rejects changed main.js content even when the exact Obsidian suffix is present", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		const expectedMain = "expected-main";
		const changedMain = "different-one";
		expect(changedMain).toHaveLength(expectedMain.length);
		installMatchingPlugin(adapter, plugin, {
			mainContent: `${changedMain}${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`,
		});

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { mainContent: expectedMain })]),
			{ adapter, sha256: sha.hash },
		);
		const main = artifact(evaluated(result, "operon"), "main.js");

		expect(main).toEqual(expect.objectContaining({
			status: "mismatched",
			hashStatus: "computed",
			repairEligible: true,
			acceptedVariant: null,
		}));
		expect(main.local.sha256).toBe(digestForText(changedMain));
	});

	it("does not accept the Obsidian main.js suffix on manifest.json", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin);
		adapter.setFile(
			`${plugin.pluginPath}/manifest.json`,
			`${manifestText(plugin.pluginId, plugin.manifest.version)}${OBSIDIAN_NO_SOURCE_MAP_SUFFIX}`,
		);

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin)]),
			{ adapter, sha256: sha.hash },
		);
		const manifestArtifact = artifact(evaluated(result, "operon"), "manifest.json");

		expect(manifestArtifact).toEqual(expect.objectContaining({
			status: "mismatched",
			hashStatus: "not-computed",
			repairEligible: true,
			acceptedVariant: null,
		}));
		expect(adapter.calls).not.toContain("readBinary:.custom/plugins/operon/manifest.json");
	});

	it("marks same-size digest mismatches as repairable", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin, { mainContent: "local-main" });

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { mainContent: "other-main" })]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "operon");
		const main = artifact(record, "main.js");

		expect(record.status).toBe("repair-available");
		expect(main.status).toBe("mismatched");
		expect(main.hashStatus).toBe("computed");
		expect(main.local.sha256).toBe(digestForText("local-main"));
		expect(main.repairEligible).toBe(true);
	});

	it("marks a missing expected artifact as repairable without reading it", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		adapter.setFile(`${plugin.pluginPath}/manifest.json`, manifestText("operon"));

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin)]),
			{ adapter, sha256: sha.hash },
		);
		const main = artifact(evaluated(result, "operon"), "main.js");

		expect(main).toEqual(expect.objectContaining({
			status: "missing",
			local: { exists: false, sizeBytes: null, sha256: null },
			repairEligible: true,
		}));
		expect(adapter.calls).not.toContain("readBinary:.custom/plugins/operon/main.js");
	});

	it("blocks every local operation when remote manifest digest evidence is wrong", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin);

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin, { manifestDigest: `sha256:${"0".repeat(64)}` })]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "operon");

		expect(record.status).toBe("unverifiable");
		expect(record.reason?.code).toBe("remote-manifest-digest-mismatch");
		expect(record.result.artifacts).toEqual([]);
		expect(adapter.calls).toEqual([]);
	});

	it("isolates remote manifest hash failures before local access", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		sha.errors.add(manifestText("operon"));

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin)]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "operon");

		expect(result.status).toBe("partial");
		expect(record.status).toBe("error");
		expect(record.reason?.code).toBe("remote-manifest-hash-error");
		expect(adapter.calls).toEqual([]);
	});

	it("rejects remote manifest byte-length drift before hashing or local access", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const record = resolvedRecord(plugin);
		const manifestAsset = record.release.assets.find(found => found.assetName === "manifest.json");
		if (manifestAsset === undefined) {
			throw new Error("Missing manifest fixture.");
		}
		const altered: ResolvedRemoteRecord = {
			...record,
			release: {
				...record.release,
				assets: record.release.assets.map(asset => asset.assetName === "manifest.json"
					? { ...asset, sizeBytes: manifestAsset.sizeBytes + 1 }
					: asset),
			},
		};
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([altered]),
			{ adapter, sha256: sha.hash },
		);

		expect(evaluated(result, "operon").reason?.code).toBe("remote-manifest-byte-evidence-mismatch");
		expect(adapter.calls).toEqual([]);
		expect(sha.calls).toEqual([]);
	});

	it("isolates folders, stat failures, read failures, byte drift, TOCTOU changes, and hash failures", async () => {
		const cases = [
			{ id: "folder", expected: "unverifiable", code: "artifact-not-regular-file" },
			{ id: "stat-error", expected: "error", code: "artifact-stat-error" },
			{ id: "read-error", expected: "error", code: "artifact-read-error" },
			{ id: "byte-drift", expected: "unverifiable", code: "artifact-read-size-mismatch" },
			{ id: "changed", expected: "unverifiable", code: "artifact-changed-during-read" },
			{ id: "hash-error", expected: "error", code: "artifact-hash-error" },
		] as const;

		for (const testCase of cases) {
			const plugin = localPlugin(testCase.id) as DiscoveredPluginRecord & { repository: GitHubRepository };
			const adapter = new FakeIntegrityAdapter();
			const sha = new FakeSha256();
			installMatchingPlugin(adapter, plugin);
			const mainPath = `${plugin.pluginPath}/main.js`;
			if (testCase.id === "folder") {
				adapter.setFolder(mainPath);
			} else if (testCase.id === "stat-error") {
				adapter.statErrors.set(mainPath, new Error("stat failed"));
			} else if (testCase.id === "read-error") {
				adapter.readErrors.set(mainPath, new Error("read failed"));
			} else if (testCase.id === "byte-drift") {
				adapter.setFile(mainPath, "short", { size: toArrayBuffer("main-byte-drift").byteLength });
			} else if (testCase.id === "changed") {
				const size = toArrayBuffer("main-changed").byteLength;
				adapter.queueStats(
					mainPath,
					{ type: "file", ctime: 1, mtime: 1, size },
					{ type: "file", ctime: 1, mtime: 2, size },
				);
			} else {
				sha.errors.add("main-hash-error");
			}

			const result = await verifyPluginIntegrity(
				discovery([plugin]),
				remoteBatch([resolvedRecord(plugin)]),
				{ adapter, sha256: sha.hash },
			);
			const main = artifact(evaluated(result, testCase.id), "main.js");
			expect(main.status, testCase.id).toBe(testCase.expected);
			expect(main.reason?.code, testCase.id).toBe(testCase.code);
			expect(main.repairEligible, testCase.id).toBe(false);
		}
	});

	it("accepts the 64 MiB boundary and rejects larger artifacts without reading", async () => {
		const boundary = localPlugin("boundary") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const oversized = localPlugin("oversized") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, boundary);
		installMatchingPlugin(adapter, oversized);
		adapter.setFile(`${boundary.pluginPath}/main.js`, new ArrayBuffer(MAX_HASHABLE_ARTIFACT_BYTES));
		adapter.setFile(`${oversized.pluginPath}/main.js`, "tiny", { size: MAX_HASHABLE_ARTIFACT_BYTES + 1 });

		const result = await verifyPluginIntegrity(
			discovery([oversized, boundary]),
			remoteBatch([
				resolvedRecord(oversized, {
					mainSize: MAX_HASHABLE_ARTIFACT_BYTES + 1,
					mainDigest: LARGE_DIGEST,
				}),
				resolvedRecord(boundary, {
					mainSize: MAX_HASHABLE_ARTIFACT_BYTES,
					mainDigest: LARGE_DIGEST,
				}),
			]),
			{ adapter, sha256: sha.hash },
		);

		expect(artifact(evaluated(result, "boundary"), "main.js").status).toBe("healthy");
		expect(artifact(evaluated(result, "oversized"), "main.js")).toEqual(expect.objectContaining({
			status: "unsupported",
			hashStatus: "not-computed",
			repairEligible: false,
		}));
		expect(adapter.calls).not.toContain("readBinary:.custom/plugins/oversized/main.js");
	});

	it("reports an unexpected local styles.css without making deletion repairable", async () => {
		const plugin = localPlugin("styled") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, plugin, { stylesContent: "body{}" });

		const result = await verifyPluginIntegrity(
			discovery([plugin]),
			remoteBatch([resolvedRecord(plugin)]),
			{ adapter, sha256: sha.hash },
		);
		const record = evaluated(result, "styled");
		const styles = artifact(record, "styles.css");

		expect(record.status).toBe("mismatched");
		expect(record.result.repairEligible).toBe(false);
		expect(styles.reason?.code).toBe("unexpected-local-asset");
		expect(styles.repairEligible).toBe(false);
		expect(adapter.calls).not.toContain("readBinary:.custom/plugins/styled/styles.css");
	});

	it("passes remote non-resolved states through without filesystem or hash work", async () => {
		const skipped = localPlugin("alpha", null);
		const unsupported = localPlugin("bravo") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const unverifiable = localPlugin("charlie") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const failed = localPlugin("delta") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const deferred = localPlugin("echo") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const records: RemoteResolutionRecord[] = [
			{
				status: "skipped",
				pluginId: skipped.pluginId,
				repository: null,
				manifestVersion: skipped.manifest.version,
				requestCount: 0,
				rateLimit: null,
				release: null,
				reason: { code: "repository-not-configured", message: "No mapping." },
				retryAtMs: null,
			},
			...([
				[unsupported, "unsupported", "not-found", null],
				[unverifiable, "unverifiable", "bad-release", null],
				[failed, "error", "network-error", null],
				[deferred, "deferred", "rate-limit", 1234],
			] as const).map(([plugin, status, code, retryAtMs]) => ({
				status,
				pluginId: plugin.pluginId,
				repository: plugin.repository,
				manifestVersion: plugin.manifest.version,
				requestCount: 0,
				rateLimit: null,
				release: null,
				reason: { code, message: code },
				retryAtMs,
			})),
		];
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();

		const result = await verifyPluginIntegrity(
			discovery([deferred, failed, unverifiable, unsupported, skipped]),
			remoteBatch(records, "partial"),
			{ adapter, sha256: sha.hash },
		);

		expect(result.status).toBe("partial");
		expect(result.records.map(record => [record.pluginId, record.status, record.sourceRemoteStatus])).toEqual([
			["alpha", "unsupported", "skipped"],
			["bravo", "unsupported", "unsupported"],
			["charlie", "unverifiable", "unverifiable"],
			["delta", "error", "error"],
			["echo", "unverifiable", "deferred"],
		]);
		expect(adapter.calls).toEqual([]);
		expect(sha.calls).toEqual([]);
	});

	it("fails closed on record-set, identity, duplicate, and artifact-path inconsistencies", async () => {
		const plugin = localPlugin("operon") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const validRemote = resolvedRecord(plugin);
		const wrongRepository: ResolvedRemoteRecord = {
			...validRemote,
			repository: { owner: "other", repo: "repository" },
		};
		const wrongVersion: ResolvedRemoteRecord = {
			...validRemote,
			manifestVersion: "9.9.9",
		};
		const wrongPath: DiscoveredPluginRecord = {
			...plugin,
			artifacts: plugin.artifacts.map(snapshot => snapshot.assetName === "main.js"
				? { ...snapshot, path: ".custom/plugins/other/main.js" }
				: snapshot),
		};
		const cases: Array<{
			readonly local: LocalDiscoveryResult;
			readonly remote: RemoteResolutionBatch;
			readonly code: string;
		}> = [
			{ local: discovery([plugin]), remote: remoteBatch([]), code: "verification-record-set-mismatch" },
			{ local: discovery([plugin]), remote: remoteBatch([wrongRepository]), code: "verification-target-identity-mismatch" },
			{ local: discovery([plugin]), remote: remoteBatch([wrongVersion]), code: "verification-target-identity-mismatch" },
			{ local: discovery([plugin, plugin]), remote: remoteBatch([validRemote]), code: "duplicate-local-plugin" },
			{ local: discovery([plugin]), remote: remoteBatch([validRemote, validRemote]), code: "duplicate-remote-plugin" },
			{ local: discovery([wrongPath]), remote: remoteBatch([validRemote]), code: "local-artifact-path-mismatch" },
		];

		for (const testCase of cases) {
			const adapter = new FakeIntegrityAdapter();
			const sha = new FakeSha256();
			const result = await verifyPluginIntegrity(
				testCase.local,
				testCase.remote,
				{ adapter, sha256: sha.hash },
			);
			expect(result.status).toBe("error");
			expect(result.reason?.code).toBe(testCase.code);
			expect(result.records).toEqual([]);
			expect(adapter.calls).toEqual([]);
			expect(sha.calls).toEqual([]);
		}
	});

	it("sorts plugins, hashes sequentially, and does not retain hash cache across runs", async () => {
		const alpha = localPlugin("alpha") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const zeta = localPlugin("zeta") as DiscoveredPluginRecord & { repository: GitHubRepository };
		const adapter = new FakeIntegrityAdapter();
		const sha = new FakeSha256();
		installMatchingPlugin(adapter, alpha);
		installMatchingPlugin(adapter, zeta);
		const local = discovery([zeta, alpha]);
		const remote = remoteBatch([resolvedRecord(zeta), resolvedRecord(alpha)]);

		const first = await verifyPluginIntegrity(local, remote, { adapter, sha256: sha.hash });
		const firstHashCount = sha.calls.length;
		const second = await verifyPluginIntegrity(local, remote, { adapter, sha256: sha.hash });

		expect(first.records.map(record => record.pluginId)).toEqual(["alpha", "zeta"]);
		expect(second.records.map(record => record.pluginId)).toEqual(["alpha", "zeta"]);
		expect(adapter.maxActiveReads).toBe(1);
		expect(firstHashCount).toBe(6);
		expect(sha.calls).toHaveLength(12);
	});

	it("represents configured-missing targets as blocked and unverifiable", async () => {
		const missing: ConfiguredMissingPluginRecord = {
			status: "configured-missing",
			pluginId: "missing",
			pluginPath: ".custom/plugins/missing",
			repository: REPOSITORY,
			manifest: null,
			artifacts: [],
			reason: { code: "configured-plugin-missing", message: "Missing." },
		};
		const remote: RemoteResolutionRecord = {
			status: "skipped",
			pluginId: "missing",
			repository: REPOSITORY,
			manifestVersion: null,
			requestCount: 0,
			rateLimit: null,
			release: null,
			reason: { code: "local-configured-missing", message: "Missing." },
			retryAtMs: null,
		};
		const adapter = new FakeIntegrityAdapter();

		const result = await verifyPluginIntegrity(
			discovery([missing]),
			remoteBatch([remote]),
			{ adapter, sha256: new FakeSha256().hash },
		);

		expect(result.records[0]).toEqual(expect.objectContaining({
			outcome: "blocked",
			status: "unverifiable",
			sourceRemoteStatus: "skipped",
		}));
		expect(adapter.calls).toEqual([]);
	});
});
