import type { Stat } from "obsidian";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import type { ArtifactIntegrityResult } from "../src/domain";
import { sha256ArrayBuffer } from "../src/integrity-verification";
import type {
	RepairAdapter,
	RepairJournal,
	RepairReceipt,
} from "../src/repair-transaction";

export const PLUGIN_ROOT = ".obsidian/plugins";
export const PLUGIN_ID = "example-plugin";
export const PLUGIN_PATH = `${PLUGIN_ROOT}/${PLUGIN_ID}`;
export const OWN_PLUGIN_PATH = `${PLUGIN_ROOT}/sync-assets`;
export const TRANSACTION_ID = `repair-${"1".repeat(32)}`;

export function textBytes(value: string): ArrayBuffer {
	return Uint8Array.from(new TextEncoder().encode(value)).buffer;
}

export interface RepairFixture {
	readonly run: IntegrityCheckRun;
	readonly expectedFiles: Readonly<Record<"main.js" | "manifest.json" | "styles.css", ArrayBuffer>>;
	readonly originalFiles: Readonly<Record<"main.js" | "manifest.json", ArrayBuffer>>;
}

export async function createRepairFixture(
	includeManifestRepair = true,
): Promise<RepairFixture> {
	const expectedMain = textBytes("good-main");
	const originalMain = textBytes("bad--main");
	const expectedStyles = textBytes("good-css");
	const remoteManifest = textBytes(JSON.stringify({
		id: PLUGIN_ID,
		name: "Example Plugin",
		author: "Example",
		version: "1.2.3",
		minAppVersion: "1.7.2",
		description: "Remote manifest",
	}));
	const originalManifest = includeManifestRepair
		? textBytes(JSON.stringify({
			id: PLUGIN_ID,
			name: "Example Plugin",
			author: "Example",
			version: "1.2.3",
			minAppVersion: "1.7.2",
			description: "Locally changed manifest",
		}))
		: remoteManifest.slice(0);
	const [mainDigest, originalMainDigest, stylesDigest, manifestDigest, originalManifestDigest] = await Promise.all([
		sha256ArrayBuffer(expectedMain),
		sha256ArrayBuffer(originalMain),
		sha256ArrayBuffer(expectedStyles),
		sha256ArrayBuffer(remoteManifest),
		sha256ArrayBuffer(originalManifest),
	]);
	const repository = { owner: "example", repo: "plugin" };
	const manifest = {
		id: PLUGIN_ID,
		name: "Example Plugin",
		author: "Example",
		version: "1.2.3",
		minAppVersion: "1.7.2",
		description: "Remote manifest",
		isDesktopOnly: false,
	};
	const mainResult: ArtifactIntegrityResult = {
		assetName: "main.js",
		status: "mismatched",
		expected: { sizeBytes: expectedMain.byteLength, sha256: mainDigest },
		local: {
			exists: true,
			sizeBytes: originalMain.byteLength,
			sha256: originalMainDigest,
		},
		hashStatus: "computed",
		repairEligible: true,
		reason: { code: "artifact-digest-mismatch", message: "Main digest differs." },
		acceptedVariant: null,
	};
	const manifestResult: ArtifactIntegrityResult = includeManifestRepair
		? {
			assetName: "manifest.json",
			status: "mismatched",
			expected: { sizeBytes: remoteManifest.byteLength, sha256: manifestDigest },
			local: {
				exists: true,
				sizeBytes: originalManifest.byteLength,
				sha256: originalManifestDigest,
			},
			hashStatus: "computed",
			repairEligible: true,
			reason: { code: "artifact-digest-mismatch", message: "Manifest digest differs." },
			acceptedVariant: null,
		}
		: {
			assetName: "manifest.json",
			status: "healthy",
			expected: { sizeBytes: remoteManifest.byteLength, sha256: manifestDigest },
			local: {
				exists: true,
				sizeBytes: remoteManifest.byteLength,
				sha256: manifestDigest,
			},
			hashStatus: "computed",
			repairEligible: false,
			reason: null,
			acceptedVariant: null,
		};
	const stylesResult: ArtifactIntegrityResult = {
		assetName: "styles.css",
		status: "missing",
		expected: { sizeBytes: expectedStyles.byteLength, sha256: stylesDigest },
		local: { exists: false, sizeBytes: null, sha256: null },
		hashStatus: "not-required",
		repairEligible: true,
		reason: { code: "artifact-missing", message: "Styles are missing." },
		acceptedVariant: null,
	};
	const assets = [
		{
			assetId: 1,
			assetName: "main.js" as const,
			sizeBytes: expectedMain.byteLength,
			sha256: mainDigest,
			downloadUrl: "https://github.com/example/plugin/releases/download/1.2.3/main.js",
		},
		{
			assetId: 2,
			assetName: "manifest.json" as const,
			sizeBytes: remoteManifest.byteLength,
			sha256: manifestDigest,
			downloadUrl: "https://github.com/example/plugin/releases/download/1.2.3/manifest.json",
		},
		{
			assetId: 3,
			assetName: "styles.css" as const,
			sizeBytes: expectedStyles.byteLength,
			sha256: stylesDigest,
			downloadUrl: "https://github.com/example/plugin/releases/download/1.2.3/styles.css",
		},
	];

	return {
		run: {
			runId: 9,
			trigger: "manual",
			status: "completed",
			startedAtMs: 10,
			finishedAtMs: 20,
			settingsIssues: [],
			discovery: {
				status: "completed",
				pluginRoot: PLUGIN_ROOT,
				issues: [],
				plugins: [{
					status: "discovered",
					pluginId: PLUGIN_ID,
					pluginPath: PLUGIN_PATH,
					repository,
					manifest,
					artifacts: [
						{ assetName: "main.js", path: `${PLUGIN_PATH}/main.js`, state: "file", sizeBytes: originalMain.byteLength, reason: null },
						{ assetName: "manifest.json", path: `${PLUGIN_PATH}/manifest.json`, state: "file", sizeBytes: originalManifest.byteLength, reason: null },
						{ assetName: "styles.css", path: `${PLUGIN_PATH}/styles.css`, state: "missing", sizeBytes: null, reason: { code: "artifact-missing", message: "Missing." } },
					],
					reason: null,
				}],
			},
			remote: {
				status: "completed",
				records: [{
					status: "resolved",
					pluginId: PLUGIN_ID,
					repository,
					manifestVersion: "1.2.3",
					requestCount: 2,
					rateLimit: null,
					release: {
						repository,
						releaseId: 44,
						tagName: "1.2.3",
						publishedAt: "2026-08-30T12:00:00Z",
						assets,
						manifest,
						manifestBytes: remoteManifest,
					},
					reason: null,
					retryAtMs: null,
				}],
				requestCount: 2,
				rateLimit: null,
				reason: null,
			},
			verification: {
				status: "completed",
				records: [{
					outcome: "evaluated",
					pluginId: PLUGIN_ID,
					repository,
					manifestVersion: "1.2.3",
					status: "repair-available",
					sourceRemoteStatus: "resolved",
					result: {
						pluginId: PLUGIN_ID,
						manifestVersion: "1.2.3",
						repository,
						status: "repair-available",
						artifacts: [mainResult, manifestResult, stylesResult],
						repairEligible: true,
						reason: mainResult.reason,
					},
					reason: mainResult.reason,
					retryAtMs: null,
				}],
				reason: null,
			},
			reason: null,
		},
		expectedFiles: {
			"main.js": expectedMain,
			"manifest.json": remoteManifest,
			"styles.css": expectedStyles,
		},
		originalFiles: {
			"main.js": originalMain,
			"manifest.json": originalManifest,
		},
	};
}

type FakeEntry =
	| { type: "folder"; mtime: number }
	| { type: "file"; mtime: number; bytes: ArrayBuffer };

export class FakeRepairAdapter implements RepairAdapter {
	readonly calls: string[] = [];
	readonly entries = new Map<string, FakeEntry>();
	failRename: ((from: string, to: string) => boolean) | null = null;
	failRemove: ((path: string) => boolean) | null = null;
	afterRename: ((from: string, to: string, adapter: FakeRepairAdapter) => void) | null = null;
	private nextMtime = 100;

	seedFolder(path: string): void {
		this.entries.set(path, { type: "folder", mtime: this.nextMtime++ });
	}

	seedFile(path: string, bytes: ArrayBuffer): void {
		this.entries.set(path, { type: "file", bytes: bytes.slice(0), mtime: this.nextMtime++ });
	}

	fileBytes(path: string): ArrayBuffer | null {
		const entry = this.entries.get(path);
		return entry?.type === "file" ? entry.bytes.slice(0) : null;
	}

	async stat(path: string): Promise<Stat | null> {
		await Promise.resolve();
		this.calls.push(`stat:${path}`);
		const entry = this.entries.get(path);
		if (entry === undefined) {
			return null;
		}
		return {
			type: entry.type,
			ctime: entry.mtime,
			mtime: entry.mtime,
			size: entry.type === "file" ? entry.bytes.byteLength : 0,
		};
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		await Promise.resolve();
		this.calls.push(`readBinary:${path}`);
		const entry = this.entries.get(path);
		if (entry?.type !== "file") {
			throw new Error(`Missing file: ${path}`);
		}
		return entry.bytes.slice(0);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		await Promise.resolve();
		this.calls.push(`writeBinary:${path}`);
		this.entries.set(path, { type: "file", bytes: data.slice(0), mtime: this.nextMtime++ });
	}

	async mkdir(path: string): Promise<void> {
		await Promise.resolve();
		this.calls.push(`mkdir:${path}`);
		if (this.entries.has(path)) {
			throw new Error(`Path exists: ${path}`);
		}
		this.seedFolder(path);
	}

	async rename(from: string, to: string): Promise<void> {
		await Promise.resolve();
		this.calls.push(`rename:${from}->${to}`);
		if (this.failRename?.(from, to) === true) {
			throw new Error("Injected rename failure.");
		}
		const entry = this.entries.get(from);
		if (entry === undefined || this.entries.has(to)) {
			throw new Error(`Cannot rename ${from} to ${to}`);
		}
		this.entries.delete(from);
		this.entries.set(to, entry);
		this.afterRename?.(from, to, this);
	}

	async remove(path: string): Promise<void> {
		await Promise.resolve();
		this.calls.push(`remove:${path}`);
		if (this.failRemove?.(path) === true) {
			throw new Error("Injected remove failure.");
		}
		const entry = this.entries.get(path);
		if (entry?.type !== "file") {
			throw new Error(`Cannot remove ${path}`);
		}
		this.entries.delete(path);
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		await Promise.resolve();
		this.calls.push(`rmdir:${path}:${String(recursive)}`);
		const entry = this.entries.get(path);
		if (entry?.type !== "folder") {
			throw new Error(`Cannot remove directory ${path}`);
		}
		const prefix = `${path}/`;
		const children = [...this.entries.keys()].filter(candidate => candidate.startsWith(prefix));
		if (children.length > 0 && !recursive) {
			throw new Error(`Directory is not empty: ${path}`);
		}
		for (const child of children) {
			this.entries.delete(child);
		}
		this.entries.delete(path);
	}
}

export class MemoryRepairJournal implements RepairJournal {
	readonly created: RepairReceipt[] = [];
	readonly updated: RepairReceipt[] = [];
	open: RepairReceipt | null = null;
	failCreate = false;
	failUpdate = false;

	async getOpenTransaction(): Promise<RepairReceipt | null> {
		await Promise.resolve();
		return this.open;
	}

	async create(receipt: RepairReceipt): Promise<void> {
		await Promise.resolve();
		if (this.failCreate) {
			throw new Error("Injected journal create failure.");
		}
		this.created.push(receipt);
	}

	async update(receipt: RepairReceipt): Promise<void> {
		await Promise.resolve();
		if (this.failUpdate) {
			throw new Error("Injected journal update failure.");
		}
		this.updated.push(receipt);
	}
}
