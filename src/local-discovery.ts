import type { DataAdapter, ListedFiles, Stat } from "obsidian";

import {
	RELEASE_ASSET_NAMES,
	type GitHubRepository,
	type IntegrityReason,
	type ReleaseAssetName,
} from "./domain";
import { validatePluginId } from "./security";
import type { SyncAssetsSettings } from "./settings";
import {
	validatePluginManifest,
	type ValidatedPluginManifest,
} from "./plugin-manifest";

export const MAX_MANIFEST_BYTES = 65_536;

export type DiscoveryAdapter = Pick<DataAdapter, "list" | "read" | "stat">;

export interface LocalDiscoveryContext {
	readonly adapter: DiscoveryAdapter;
	readonly configDir: string;
	readonly ownPluginId: string;
	readonly normalizePath: (path: string) => string;
}

export type LocalPluginManifest = ValidatedPluginManifest;

export type LocalArtifactState = "file" | "missing" | "invalid" | "error";

export interface LocalArtifactSnapshot {
	readonly assetName: ReleaseAssetName;
	readonly path: string;
	readonly state: LocalArtifactState;
	readonly sizeBytes: number | null;
	readonly reason: IntegrityReason | null;
}

export interface DiscoveryIssue extends IntegrityReason {
	readonly scope: "scan" | "plugin" | "artifact";
	readonly path: string;
	readonly pluginId: string | null;
	readonly assetName: ReleaseAssetName | null;
}

interface LocalPluginRecordBase {
	readonly pluginId: string;
	readonly pluginPath: string;
	readonly repository: GitHubRepository | null;
	readonly reason: IntegrityReason | null;
}

export interface DiscoveredPluginRecord extends LocalPluginRecordBase {
	readonly status: "discovered";
	readonly manifest: LocalPluginManifest;
	readonly artifacts: readonly LocalArtifactSnapshot[];
}

export interface UnverifiablePluginRecord extends LocalPluginRecordBase {
	readonly status: "unverifiable";
	readonly manifest: null;
	readonly artifacts: readonly [];
}

export interface ErrorPluginRecord extends LocalPluginRecordBase {
	readonly status: "error";
	readonly manifest: null;
	readonly artifacts: readonly [];
}

export interface ConfiguredMissingPluginRecord extends LocalPluginRecordBase {
	readonly status: "configured-missing";
	readonly repository: GitHubRepository;
	readonly manifest: null;
	readonly artifacts: readonly [];
}

export type LocalPluginRecord =
	| DiscoveredPluginRecord
	| UnverifiablePluginRecord
	| ErrorPluginRecord
	| ConfiguredMissingPluginRecord;

export interface LocalDiscoveryResult {
	readonly status: "completed" | "error";
	readonly pluginRoot: string;
	readonly plugins: readonly LocalPluginRecord[];
	readonly issues: readonly DiscoveryIssue[];
}

interface ManifestReadSuccess {
	readonly ok: true;
	readonly manifest: LocalPluginManifest;
	readonly stat: Stat;
}

interface ManifestReadFailure {
	readonly ok: false;
	readonly status: "unverifiable" | "error";
	readonly reason: IntegrityReason;
}

type ManifestReadResult = ManifestReadSuccess | ManifestReadFailure;

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function issue(
	scope: DiscoveryIssue["scope"],
	path: string,
	pluginId: string | null,
	problem: IntegrityReason,
	assetName: ReleaseAssetName | null = null,
): DiscoveryIssue {
	return {
		...problem,
		scope,
		path,
		pluginId,
		assetName,
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown adapter error.";
}

async function readManifest(
	adapter: DiscoveryAdapter,
	manifestPath: string,
	folderName: string,
): Promise<ManifestReadResult> {
	let manifestStat: Stat | null;
	try {
		manifestStat = await adapter.stat(manifestPath);
	} catch (error) {
		return {
			ok: false,
			status: "error",
			reason: reason("manifest-stat-error", `Could not inspect manifest: ${getErrorMessage(error)}`),
		};
	}

	if (manifestStat === null) {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("manifest-missing", "Plugin manifest.json is missing."),
		};
	}
	if (manifestStat.type !== "file") {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("manifest-not-file", "Plugin manifest.json is not a regular file."),
		};
	}
	if (manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST_BYTES) {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason(
				"manifest-size-out-of-range",
				`Plugin manifest.json must be between 1 and ${MAX_MANIFEST_BYTES} bytes.`,
			),
		};
	}

	let rawManifest: string;
	try {
		rawManifest = await adapter.read(manifestPath);
	} catch (error) {
		return {
			ok: false,
			status: "error",
			reason: reason("manifest-read-error", `Could not read manifest: ${getErrorMessage(error)}`),
		};
	}

	let parsedManifest: unknown;
	try {
		parsedManifest = JSON.parse(rawManifest) as unknown;
	} catch {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("manifest-invalid-json", "Plugin manifest.json contains invalid JSON."),
		};
	}

	const validation = validatePluginManifest(parsedManifest, {
		expectedPluginId: folderName,
		idMismatchCode: "manifest-folder-mismatch",
		idMismatchMessage: "Manifest plugin ID must exactly match its direct plugin folder name.",
	});
	if (!validation.ok) {
		return { ok: false, status: "unverifiable", reason: validation.reason };
	}

	return { ok: true, manifest: validation.manifest, stat: manifestStat };
}

async function inspectArtifact(
	adapter: DiscoveryAdapter,
	path: string,
	pluginId: string,
	assetName: ReleaseAssetName,
	issues: DiscoveryIssue[],
): Promise<LocalArtifactSnapshot> {
	let artifactStat: Stat | null;
	try {
		artifactStat = await adapter.stat(path);
	} catch (error) {
		const problem = reason("artifact-stat-error", `Could not inspect artifact: ${getErrorMessage(error)}`);
		issues.push(issue("artifact", path, pluginId, problem, assetName));
		return { assetName, path, state: "error", sizeBytes: null, reason: problem };
	}

	if (artifactStat === null) {
		return {
			assetName,
			path,
			state: "missing",
			sizeBytes: null,
			reason: reason("artifact-missing", "Local release artifact is missing."),
		};
	}
	if (artifactStat.type !== "file") {
		const problem = reason("artifact-not-file", "Local release artifact is not a regular file.");
		issues.push(issue("artifact", path, pluginId, problem, assetName));
		return { assetName, path, state: "invalid", sizeBytes: null, reason: problem };
	}

	return {
		assetName,
		path,
		state: "file",
		sizeBytes: artifactStat.size,
		reason: null,
	};
}

function getDirectFolderName(pluginRoot: string, folderPath: string): string | null {
	const prefix = `${pluginRoot}/`;
	if (!folderPath.startsWith(prefix)) {
		return null;
	}

	const remainder = folderPath.slice(prefix.length);
	return remainder.length > 0 && !remainder.includes("/") ? remainder : null;
}

function configuredMissingRecord(
	pluginRoot: string,
	pluginId: string,
	repository: GitHubRepository,
	normalizePath: LocalDiscoveryContext["normalizePath"],
): ConfiguredMissingPluginRecord {
	return {
		status: "configured-missing",
		pluginId,
		pluginPath: normalizePath(`${pluginRoot}/${pluginId}`),
		repository,
		manifest: null,
		artifacts: [],
		reason: reason(
			"configured-plugin-missing",
			"The configured plugin folder is not installed in this vault.",
		),
	};
}

function configuredMissingRecords(
	pluginRoot: string,
	settings: SyncAssetsSettings,
	installedPluginIds: ReadonlySet<string>,
	context: LocalDiscoveryContext,
): ConfiguredMissingPluginRecord[] {
	return settings.repositories
		.filter(mapping => (
			mapping.pluginId !== context.ownPluginId
			&& !installedPluginIds.has(mapping.pluginId)
		))
		.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
		.map(mapping => configuredMissingRecord(
			pluginRoot,
			mapping.pluginId,
			mapping.repository,
			context.normalizePath,
		));
}

export async function discoverLocalPlugins(
	settings: SyncAssetsSettings,
	context: LocalDiscoveryContext,
): Promise<LocalDiscoveryResult> {
	const pluginRoot = context.normalizePath(`${context.configDir}/plugins`);
	const issues: DiscoveryIssue[] = [];
	const ownPluginIdResult = validatePluginId(context.ownPluginId, "ownPluginId");
	if (!ownPluginIdResult.ok) {
		const problem = reason("invalid-own-plugin-id", "Sync Assets plugin ID is not path-safe.");
		return {
			status: "error",
			pluginRoot,
			plugins: [],
			issues: [issue("scan", pluginRoot, null, problem)],
		};
	}

	let pluginRootStat: Stat | null;
	try {
		pluginRootStat = await context.adapter.stat(pluginRoot);
	} catch (error) {
		const problem = reason("plugin-root-stat-error", `Could not inspect plugin root: ${getErrorMessage(error)}`);
		return {
			status: "error",
			pluginRoot,
			plugins: [],
			issues: [issue("scan", pluginRoot, null, problem)],
		};
	}

	if (pluginRootStat === null) {
		return {
			status: "completed",
			pluginRoot,
			plugins: configuredMissingRecords(pluginRoot, settings, new Set(), context),
			issues,
		};
	}
	if (pluginRootStat.type !== "folder") {
		const problem = reason("plugin-root-not-folder", "Configured plugin root is not a folder.");
		return {
			status: "error",
			pluginRoot,
			plugins: [],
			issues: [issue("scan", pluginRoot, null, problem)],
		};
	}

	let listedFiles: ListedFiles;
	try {
		listedFiles = await context.adapter.list(pluginRoot);
	} catch (error) {
		const problem = reason("plugin-root-list-error", `Could not list plugin root: ${getErrorMessage(error)}`);
		return {
			status: "error",
			pluginRoot,
			plugins: [],
			issues: [issue("scan", pluginRoot, null, problem)],
		};
	}

	const folderNames = new Set<string>();
	for (const listedFolder of listedFiles.folders) {
		const normalizedFolder = context.normalizePath(listedFolder);
		const folderName = getDirectFolderName(pluginRoot, normalizedFolder);
		if (folderName === null) {
			issues.push(issue(
				"scan",
				normalizedFolder,
				null,
				reason("non-direct-plugin-folder", "Only direct plugin folders may be discovered."),
			));
			continue;
		}

		const folderIdResult = validatePluginId(folderName, "pluginFolder");
		if (!folderIdResult.ok) {
			issues.push(issue(
				"scan",
				normalizedFolder,
				null,
				reason("unsafe-plugin-folder", "Plugin folder name is not path-safe."),
			));
			continue;
		}

		if (folderIdResult.value !== ownPluginIdResult.value) {
			folderNames.add(folderIdResult.value);
		}
	}

	const installedPluginIds = new Set(folderNames);
	const repositoryByPluginId = new Map(
		settings.repositories.map(mapping => [mapping.pluginId, mapping.repository] as const),
	);
	const plugins: LocalPluginRecord[] = [];

	for (const folderName of [...folderNames].sort((left, right) => left.localeCompare(right))) {
		const pluginPath = context.normalizePath(`${pluginRoot}/${folderName}`);
		const manifestPath = context.normalizePath(`${pluginPath}/manifest.json`);
		const repository = repositoryByPluginId.get(folderName) ?? null;
		const manifestResult = await readManifest(context.adapter, manifestPath, folderName);

		if (!manifestResult.ok) {
			issues.push(issue("plugin", manifestPath, folderName, manifestResult.reason));
			plugins.push({
				status: manifestResult.status,
				pluginId: folderName,
				pluginPath,
				repository,
				manifest: null,
				artifacts: [],
				reason: manifestResult.reason,
			});
			continue;
		}

		const artifacts: LocalArtifactSnapshot[] = [];
		for (const assetName of RELEASE_ASSET_NAMES) {
			if (assetName === "manifest.json") {
				artifacts.push({
					assetName,
					path: manifestPath,
					state: "file",
					sizeBytes: manifestResult.stat.size,
					reason: null,
				});
				continue;
			}

			const artifactPath = context.normalizePath(`${pluginPath}/${assetName}`);
			artifacts.push(await inspectArtifact(
				context.adapter,
				artifactPath,
				folderName,
				assetName,
				issues,
			));
		}

		plugins.push({
			status: "discovered",
			pluginId: folderName,
			pluginPath,
			repository,
			manifest: manifestResult.manifest,
			artifacts,
			reason: null,
		});
	}

	plugins.push(...configuredMissingRecords(pluginRoot, settings, installedPluginIds, context));
	plugins.sort((left, right) => left.pluginId.localeCompare(right.pluginId));

	return { status: "completed", pluginRoot, plugins, issues };
}
