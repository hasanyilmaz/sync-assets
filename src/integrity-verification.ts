import type { DataAdapter, Stat } from "obsidian";

import {
	OBSIDIAN_NO_SOURCE_MAP_SUFFIX,
	RELEASE_ASSET_NAMES,
	type ArtifactFingerprint,
	type ArtifactIntegrityResult,
	type GitHubRepository,
	type IntegrityReason,
	type IntegrityStatus,
	type LocalArtifactEvidence,
	type PluginIntegrityResult,
	type ReleaseAssetName,
} from "./domain";
import {
	type DiscoveredPluginRecord,
	type LocalArtifactSnapshot,
	type LocalDiscoveryResult,
	type LocalPluginRecord,
} from "./local-discovery";
import {
	type RemoteResolutionBatch,
	type RemoteResolutionRecord,
	type RemoteFailureKind,
	type ResolvedRemoteRecord,
	type TrustedReleaseAsset,
} from "./remote-release";

export const MAX_HASHABLE_ARTIFACT_BYTES = 64 * 1024 * 1024;

const OBSIDIAN_NO_SOURCE_MAP_SUFFIX_BYTES = new TextEncoder().encode(
	OBSIDIAN_NO_SOURCE_MAP_SUFFIX,
);

export type IntegrityAdapter = Pick<DataAdapter, "readBinary" | "stat">;
export type Sha256Function = (bytes: ArrayBuffer) => Promise<string>;

export interface IntegrityVerificationContext {
	readonly adapter: IntegrityAdapter;
	readonly sha256?: Sha256Function;
}

export interface EvaluatedIntegrityRecord {
	readonly outcome: "evaluated";
	readonly pluginId: string;
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly status: IntegrityStatus;
	readonly sourceRemoteStatus: "resolved";
	readonly result: PluginIntegrityResult;
	readonly reason: IntegrityReason | null;
	readonly retryAtMs: null;
}

export interface BlockedIntegrityRecord {
	readonly outcome: "blocked";
	readonly pluginId: string;
	readonly repository: GitHubRepository | null;
	readonly manifestVersion: string | null;
	readonly status: "unsupported" | "unverifiable" | "error";
	readonly sourceRemoteStatus: Exclude<RemoteResolutionRecord["status"], "resolved">;
	readonly result: null;
	readonly reason: IntegrityReason;
	readonly retryAtMs: number | null;
	readonly remoteFailureKind?: RemoteFailureKind | null;
	readonly technicalMessage?: string | null;
}

export type IntegrityVerificationRecord =
	| EvaluatedIntegrityRecord
	| BlockedIntegrityRecord;

export interface IntegrityVerificationBatch {
	readonly status: "completed" | "partial" | "error";
	readonly records: readonly IntegrityVerificationRecord[];
	readonly reason: IntegrityReason | null;
}

interface CorrelatedTarget {
	readonly local: LocalPluginRecord;
	readonly remote: RemoteResolutionRecord;
}

type CorrelationResult =
	| { readonly ok: true; readonly targets: readonly CorrelatedTarget[] }
	| { readonly ok: false; readonly reason: IntegrityReason };

interface VerificationRunState {
	readonly hashCache: Map<string, string>;
	readonly sha256: Sha256Function;
}

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown adapter error.";
}

function sameRepository(
	left: GitHubRepository | null,
	right: GitHubRepository | null,
): boolean {
	return left === null
		? right === null
		: right !== null
			&& left.owner === right.owner
			&& left.repo === right.repo;
}

function isValidStatNumber(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isSha256Digest(value: string): boolean {
	return /^sha256:[0-9a-f]{64}$/i.test(value);
}

function unknownLocalEvidence(): LocalArtifactEvidence {
	return { exists: null, sizeBytes: null, sha256: null };
}

function missingLocalEvidence(): LocalArtifactEvidence {
	return { exists: false, sizeBytes: null, sha256: null };
}

function presentLocalEvidence(
	sizeBytes: number | null,
	sha256: string | null = null,
): LocalArtifactEvidence {
	return { exists: true, sizeBytes, sha256 };
}

function expectedFingerprint(
	asset: TrustedReleaseAsset | undefined,
): ArtifactFingerprint | null {
	return asset === undefined
		? null
		: { sizeBytes: asset.sizeBytes, sha256: asset.sha256 };
}

function artifactResult(
	assetName: ReleaseAssetName,
	status: IntegrityStatus,
	expected: ArtifactFingerprint | null,
	local: LocalArtifactEvidence,
	hashStatus: ArtifactIntegrityResult["hashStatus"],
	repairEligible: boolean,
	problem: IntegrityReason | null,
	acceptedVariant: ArtifactIntegrityResult["acceptedVariant"] = null,
): ArtifactIntegrityResult {
	return {
		assetName,
		status,
		expected,
		local,
		hashStatus,
		repairEligible,
		reason: problem,
		acceptedVariant,
	};
}

function mayHaveObsidianNoSourceMapSuffix(
	assetName: ReleaseAssetName,
	localSizeBytes: number,
	expectedSizeBytes: number,
): boolean {
	return assetName === "main.js"
		&& localSizeBytes === expectedSizeBytes + OBSIDIAN_NO_SOURCE_MAP_SUFFIX_BYTES.byteLength;
}

function endsWithObsidianNoSourceMapSuffix(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < OBSIDIAN_NO_SOURCE_MAP_SUFFIX_BYTES.byteLength) {
		return false;
	}
	const localBytes = new Uint8Array(bytes);
	const suffixStart = localBytes.byteLength - OBSIDIAN_NO_SOURCE_MAP_SUFFIX_BYTES.byteLength;
	return OBSIDIAN_NO_SOURCE_MAP_SUFFIX_BYTES.every((byte, index) => (
		localBytes[suffixStart + index] === byte
	));
}

export async function sha256ArrayBuffer(bytes: ArrayBuffer): Promise<string> {
	if (window.crypto?.subtle === undefined) {
		throw new Error("Web Crypto SHA-256 is unavailable in this runtime.");
	}

	const digest = await window.crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest), byte => (
		byte.toString(16).padStart(2, "0")
	)).join("");
	return `sha256:${hex}`;
}

function validateArtifactSnapshots(
	plugin: DiscoveredPluginRecord,
): IntegrityReason | null {
	if (plugin.artifacts.length !== RELEASE_ASSET_NAMES.length) {
		return reason(
			"local-artifact-set-mismatch",
			"Discovered plugin must contain exactly one snapshot for every allowlisted artifact.",
		);
	}

	const snapshots = new Map<ReleaseAssetName, LocalArtifactSnapshot>();
	for (const snapshot of plugin.artifacts) {
		if (snapshots.has(snapshot.assetName)) {
			return reason(
				"duplicate-local-artifact",
				`Discovered plugin contains duplicate ${snapshot.assetName} snapshots.`,
			);
		}
		snapshots.set(snapshot.assetName, snapshot);
	}

	for (const assetName of RELEASE_ASSET_NAMES) {
		const snapshot = snapshots.get(assetName);
		if (snapshot === undefined) {
			return reason(
				"local-artifact-set-mismatch",
				`Discovered plugin lacks the ${assetName} snapshot.`,
			);
		}
		if (snapshot.path !== `${plugin.pluginPath}/${assetName}`) {
			return reason(
				"local-artifact-path-mismatch",
				`Discovered ${assetName} path is outside its expected plugin artifact path.`,
			);
		}
	}

	return null;
}

function validateResolvedRecord(
	plugin: LocalPluginRecord,
	remote: ResolvedRemoteRecord,
): IntegrityReason | null {
	if (plugin.status !== "discovered" || plugin.repository === null) {
		return reason(
			"resolved-local-target-mismatch",
			"A resolved remote release requires a discovered local plugin with a repository mapping.",
		);
	}
	if (
		!sameRepository(remote.release.repository, plugin.repository)
		|| remote.release.manifest.id !== plugin.pluginId
		|| remote.release.manifest.version !== plugin.manifest.version
	) {
		return reason(
			"resolved-release-identity-mismatch",
			"Resolved release identity does not exactly match the local plugin target.",
		);
	}

	const assets = new Set<ReleaseAssetName>();
	for (const asset of remote.release.assets) {
		if (assets.has(asset.assetName)) {
			return reason(
				"duplicate-trusted-asset",
				`Resolved release contains duplicate ${asset.assetName} evidence.`,
			);
		}
		assets.add(asset.assetName);
	}
	if (!assets.has("main.js") || !assets.has("manifest.json")) {
		return reason(
			"trusted-asset-set-mismatch",
			"Resolved release lacks a required trusted artifact.",
		);
	}

	return validateArtifactSnapshots(plugin);
}

function correlateInputs(
	discovery: LocalDiscoveryResult,
	remote: RemoteResolutionBatch,
): CorrelationResult {
	if (discovery.status !== "completed") {
		return {
			ok: false,
			reason: reason(
				"local-discovery-error",
				"Integrity verification requires a completed local discovery result.",
			),
		};
	}
	if (remote.status === "error") {
		return {
			ok: false,
			reason: reason(
				"remote-resolution-error",
				"Integrity verification requires a usable remote resolution batch.",
			),
		};
	}

	const localById = new Map<string, LocalPluginRecord>();
	const pluginPaths = new Set<string>();
	for (const plugin of discovery.plugins) {
		if (localById.has(plugin.pluginId)) {
			return {
				ok: false,
				reason: reason("duplicate-local-plugin", "Local discovery contains duplicate plugin IDs."),
			};
		}
		if (pluginPaths.has(plugin.pluginPath)) {
			return {
				ok: false,
				reason: reason("duplicate-local-plugin-path", "Local discovery contains duplicate plugin paths."),
			};
		}
		localById.set(plugin.pluginId, plugin);
		pluginPaths.add(plugin.pluginPath);
	}

	const remoteById = new Map<string, RemoteResolutionRecord>();
	for (const record of remote.records) {
		if (remoteById.has(record.pluginId)) {
			return {
				ok: false,
				reason: reason("duplicate-remote-plugin", "Remote resolution contains duplicate plugin IDs."),
			};
		}
		remoteById.set(record.pluginId, record);
	}

	if (localById.size !== remoteById.size) {
		return {
			ok: false,
			reason: reason("verification-record-set-mismatch", "Local and remote plugin record sets do not match."),
		};
	}

	const targets: CorrelatedTarget[] = [];
	for (const plugin of [...discovery.plugins].sort((left, right) => (
		left.pluginId.localeCompare(right.pluginId)
	))) {
		const record = remoteById.get(plugin.pluginId);
		if (record === undefined) {
			return {
				ok: false,
				reason: reason("verification-record-set-mismatch", "Local and remote plugin record sets do not match."),
			};
		}

		const localVersion = plugin.status === "discovered"
			? plugin.manifest.version
			: null;
		if (
			!sameRepository(plugin.repository, record.repository)
			|| localVersion !== record.manifestVersion
		) {
			return {
				ok: false,
				reason: reason(
					"verification-target-identity-mismatch",
					"Local and remote plugin repository or manifest version does not match.",
				),
			};
		}

		if (plugin.status === "discovered") {
			const snapshotProblem = validateArtifactSnapshots(plugin);
			if (snapshotProblem !== null) {
				return { ok: false, reason: snapshotProblem };
			}
		}
		if (record.status === "resolved") {
			const releaseProblem = validateResolvedRecord(plugin, record);
			if (releaseProblem !== null) {
				return { ok: false, reason: releaseProblem };
			}
		}

		targets.push({ local: plugin, remote: record });
	}

	return { ok: true, targets };
}

function snapshotFor(
	plugin: DiscoveredPluginRecord,
	assetName: ReleaseAssetName,
): LocalArtifactSnapshot {
	const snapshot = plugin.artifacts.find(candidate => (
		candidate.assetName === assetName
	));
	if (snapshot === undefined) {
		throw new Error(`Validated snapshot ${assetName} is missing.`);
	}
	return snapshot;
}

async function inspectFreshStat(
	adapter: IntegrityAdapter,
	path: string,
): Promise<Stat | null | IntegrityReason> {
	try {
		return await adapter.stat(path);
	} catch (error) {
		return reason(
			"artifact-stat-error",
			`Could not inspect local artifact: ${getErrorMessage(error)}`,
		);
	}
}

function isIntegrityReason(value: Stat | null | IntegrityReason): value is IntegrityReason {
	return value !== null && "code" in value;
}

async function verifyLocalArtifact(
	adapter: IntegrityAdapter,
	plugin: DiscoveredPluginRecord,
	assetName: ReleaseAssetName,
	expectedAsset: TrustedReleaseAsset | undefined,
	state: VerificationRunState,
): Promise<ArtifactIntegrityResult> {
	const snapshot = snapshotFor(plugin, assetName);
	const expected = expectedFingerprint(expectedAsset);
	const initialStat = await inspectFreshStat(adapter, snapshot.path);

	if (isIntegrityReason(initialStat)) {
		return artifactResult(
			assetName,
			"error",
			expected,
			unknownLocalEvidence(),
			"error",
			false,
			initialStat,
		);
	}
	if (initialStat === null) {
		if (expectedAsset === undefined) {
			return artifactResult(
				assetName,
				"healthy",
				null,
				missingLocalEvidence(),
				"not-required",
				false,
				null,
			);
		}
		return artifactResult(
			assetName,
			"missing",
			expected,
			missingLocalEvidence(),
			"not-required",
			true,
			reason("artifact-missing", `Expected local artifact ${assetName} is missing.`),
		);
	}
	if (
		initialStat.type !== "file"
		|| !isValidStatNumber(initialStat.size)
		|| !isValidStatNumber(initialStat.mtime)
	) {
		return artifactResult(
			assetName,
			"unverifiable",
			expected,
			presentLocalEvidence(isValidStatNumber(initialStat.size) ? initialStat.size : null),
			"not-computed",
			false,
			reason("artifact-not-regular-file", `Local artifact ${assetName} is not a valid regular file.`),
		);
	}

	if (expectedAsset === undefined) {
		return artifactResult(
			assetName,
			"mismatched",
			null,
			presentLocalEvidence(initialStat.size),
			"not-required",
			false,
			reason(
				"unexpected-local-asset",
				`Local ${assetName} exists but the trusted release does not contain it.`,
			),
		);
	}

	if (
		expectedAsset.sizeBytes > MAX_HASHABLE_ARTIFACT_BYTES
		|| initialStat.size > MAX_HASHABLE_ARTIFACT_BYTES
	) {
		return artifactResult(
			assetName,
			"unsupported",
			expected,
			presentLocalEvidence(initialStat.size),
			"not-computed",
			false,
			reason(
				"artifact-hash-size-limit",
				`Artifact exceeds the ${MAX_HASHABLE_ARTIFACT_BYTES}-byte in-memory hash limit.`,
			),
		);
	}

	const possibleObsidianVariant = mayHaveObsidianNoSourceMapSuffix(
		assetName,
		initialStat.size,
		expectedAsset.sizeBytes,
	);
	if (initialStat.size !== expectedAsset.sizeBytes && !possibleObsidianVariant) {
		return artifactResult(
			assetName,
			"mismatched",
			expected,
			presentLocalEvidence(initialStat.size),
			"not-computed",
			true,
			reason("artifact-size-mismatch", `Local ${assetName} size differs from the trusted release.`),
		);
	}

	const cacheKey = [
		snapshot.path,
		String(initialStat.size),
		String(initialStat.mtime),
		expectedAsset.sha256,
		possibleObsidianVariant ? "obsidian-nosourcemap-suffix" : "exact",
	].join("\u0000");
	let localDigest = state.hashCache.get(cacheKey);
	if (localDigest === undefined) {
		let bytes: ArrayBuffer;
		try {
			bytes = await adapter.readBinary(snapshot.path);
		} catch (error) {
			return artifactResult(
				assetName,
				"error",
				expected,
				presentLocalEvidence(initialStat.size),
				"error",
				false,
				reason("artifact-read-error", `Could not read local artifact: ${getErrorMessage(error)}`),
			);
		}

		if (bytes.byteLength !== initialStat.size) {
			return artifactResult(
				assetName,
				"unverifiable",
				expected,
				presentLocalEvidence(initialStat.size),
				"not-computed",
				false,
				reason("artifact-read-size-mismatch", `Read byte length for ${assetName} differs from its initial stat.`),
			);
		}

		const finalStat = await inspectFreshStat(adapter, snapshot.path);
		if (isIntegrityReason(finalStat)) {
			return artifactResult(
				assetName,
				"error",
				expected,
				presentLocalEvidence(initialStat.size),
				"error",
				false,
				finalStat,
			);
		}
		if (
			finalStat === null
			|| finalStat.type !== "file"
			|| finalStat.size !== initialStat.size
			|| finalStat.mtime !== initialStat.mtime
		) {
			return artifactResult(
				assetName,
				"unverifiable",
				expected,
				presentLocalEvidence(initialStat.size),
				"not-computed",
				false,
				reason("artifact-changed-during-read", `Local ${assetName} changed while it was being read.`),
			);
		}

		let bytesToHash = bytes;
		if (possibleObsidianVariant) {
			if (!endsWithObsidianNoSourceMapSuffix(bytes)) {
				return artifactResult(
					assetName,
					"mismatched",
					expected,
					presentLocalEvidence(initialStat.size),
					"not-computed",
					true,
					reason("artifact-size-mismatch", `Local ${assetName} size differs from the trusted release.`),
				);
			}
			bytesToHash = bytes.slice(0, expectedAsset.sizeBytes);
		}

		try {
			localDigest = (await state.sha256(bytesToHash)).toLowerCase();
		} catch (error) {
			return artifactResult(
				assetName,
				"error",
				expected,
				presentLocalEvidence(initialStat.size),
				"error",
				false,
				reason("artifact-hash-error", `Could not hash local artifact: ${getErrorMessage(error)}`),
			);
		}
		if (!isSha256Digest(localDigest)) {
			return artifactResult(
				assetName,
				"error",
				expected,
				presentLocalEvidence(initialStat.size),
				"error",
				false,
				reason("invalid-hash-result", "SHA-256 implementation returned an invalid digest."),
			);
		}
		state.hashCache.set(cacheKey, localDigest);
	}

	const matches = localDigest === expectedAsset.sha256;
	return artifactResult(
		assetName,
		matches ? "healthy" : "mismatched",
		expected,
		presentLocalEvidence(initialStat.size, localDigest),
		"computed",
		!matches,
		matches
			? null
			: reason("artifact-digest-mismatch", `Local ${assetName} SHA-256 differs from the trusted release.`),
		matches && possibleObsidianVariant ? "obsidian-nosourcemap-suffix" : null,
	);
}

function aggregatePluginStatus(
	artifacts: readonly ArtifactIntegrityResult[],
): IntegrityStatus {
	if (artifacts.some(artifact => artifact.status === "error")) {
		return "error";
	}
	if (artifacts.some(artifact => artifact.repairEligible)) {
		return "repair-available";
	}
	for (const status of [
		"unverifiable",
		"unsupported",
		"mismatched",
		"missing",
	] as const) {
		if (artifacts.some(artifact => artifact.status === status)) {
			return status;
		}
	}
	return "healthy";
}

function aggregatePluginReason(
	status: IntegrityStatus,
	artifacts: readonly ArtifactIntegrityResult[],
): IntegrityReason | null {
	if (status === "healthy") {
		return null;
	}
	if (status === "repair-available") {
		return artifacts.find(artifact => artifact.repairEligible)?.reason ?? null;
	}
	return artifacts.find(artifact => artifact.status === status)?.reason ?? null;
}

function failedResolvedRecord(
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	status: "unverifiable" | "error",
	problem: IntegrityReason,
): EvaluatedIntegrityRecord {
	const result: PluginIntegrityResult = {
		pluginId: plugin.pluginId,
		manifestVersion: plugin.manifest.version,
		repository: plugin.repository,
		status,
		artifacts: [],
		repairEligible: false,
		reason: problem,
	};
	return {
		outcome: "evaluated",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		status,
		sourceRemoteStatus: "resolved",
		result,
		reason: problem,
		retryAtMs: null,
	};
}

async function verifyResolvedTarget(
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	remote: ResolvedRemoteRecord,
	context: IntegrityVerificationContext,
	state: VerificationRunState,
): Promise<EvaluatedIntegrityRecord> {
	const manifestAsset = remote.release.assets.find(asset => (
		asset.assetName === "manifest.json"
	));
	if (
		manifestAsset === undefined
		|| remote.release.manifestBytes.byteLength !== manifestAsset.sizeBytes
	) {
		const problem = reason(
			"remote-manifest-byte-evidence-mismatch",
			"Remote manifest bytes do not match trusted release metadata.",
		);
		return failedResolvedRecord(plugin, "unverifiable", problem);
	}

	let manifestDigest: string;
	try {
		manifestDigest = (await state.sha256(remote.release.manifestBytes)).toLowerCase();
	} catch (error) {
		const problem = reason(
			"remote-manifest-hash-error",
			`Could not hash remote manifest evidence: ${getErrorMessage(error)}`,
		);
		return failedResolvedRecord(plugin, "error", problem);
	}

	if (!isSha256Digest(manifestDigest)) {
		return failedResolvedRecord(
			plugin,
			"error",
			reason(
				"invalid-hash-result",
				"SHA-256 implementation returned an invalid digest for remote manifest evidence.",
			),
		);
	}
	if (manifestDigest !== manifestAsset.sha256) {
		const problem = reason(
			"remote-manifest-digest-mismatch",
			"Remote manifest SHA-256 does not match trusted release metadata.",
		);
		return failedResolvedRecord(plugin, "unverifiable", problem);
	}

	const assetsByName = new Map(remote.release.assets.map(asset => (
		[asset.assetName, asset] as const
	)));
	const artifacts: ArtifactIntegrityResult[] = [];
	for (const assetName of RELEASE_ASSET_NAMES) {
		artifacts.push(await verifyLocalArtifact(
			context.adapter,
			plugin,
			assetName,
			assetsByName.get(assetName),
			state,
		));
	}

	const status = aggregatePluginStatus(artifacts);
	const pluginReason = aggregatePluginReason(status, artifacts);
	const result: PluginIntegrityResult = {
		pluginId: plugin.pluginId,
		manifestVersion: plugin.manifest.version,
		repository: plugin.repository,
		status,
		artifacts,
		repairEligible: artifacts.some(artifact => artifact.repairEligible),
		reason: pluginReason,
	};
	return {
		outcome: "evaluated",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		status,
		sourceRemoteStatus: "resolved",
		result,
		reason: pluginReason,
		retryAtMs: null,
	};
}

function blockedStatus(
	record: Exclude<RemoteResolutionRecord, ResolvedRemoteRecord>,
): BlockedIntegrityRecord["status"] {
	if (record.status === "error") {
		return "error";
	}
	if (record.status === "unsupported") {
		return "unsupported";
	}
	if (record.status === "skipped") {
		if (record.reason.code === "repository-not-configured") {
			return "unsupported";
		}
		if (record.reason.code === "local-error") {
			return "error";
		}
	}
	return "unverifiable";
}

function blockedRecord(
	record: Exclude<RemoteResolutionRecord, ResolvedRemoteRecord>,
): BlockedIntegrityRecord {
	return {
		outcome: "blocked",
		pluginId: record.pluginId,
		repository: record.repository,
		manifestVersion: record.manifestVersion,
		status: blockedStatus(record),
		sourceRemoteStatus: record.status,
		result: null,
		reason: record.reason,
		retryAtMs: record.retryAtMs,
		remoteFailureKind: record.status === "skipped"
			? null
			: record.failureKind ?? null,
		technicalMessage: record.status === "skipped"
			? null
			: record.technicalMessage ?? null,
	};
}

export async function verifyPluginIntegrity(
	discovery: LocalDiscoveryResult,
	remote: RemoteResolutionBatch,
	context: IntegrityVerificationContext,
): Promise<IntegrityVerificationBatch> {
	const correlation = correlateInputs(discovery, remote);
	if (!correlation.ok) {
		return {
			status: "error",
			records: [],
			reason: correlation.reason,
		};
	}

	const state: VerificationRunState = {
		hashCache: new Map(),
		sha256: context.sha256 ?? sha256ArrayBuffer,
	};
	const records: IntegrityVerificationRecord[] = [];
	for (const target of correlation.targets) {
		if (target.remote.status !== "resolved") {
			records.push(blockedRecord(target.remote));
			continue;
		}
		if (target.local.status !== "discovered" || target.local.repository === null) {
			return {
				status: "error",
				records: [],
				reason: reason("resolved-local-target-mismatch", "Resolved target lost its validated local identity."),
			};
		}
		records.push(await verifyResolvedTarget(
			target.local as DiscoveredPluginRecord & { readonly repository: GitHubRepository },
			target.remote,
			context,
			state,
		));
	}

	const hasPartialResult = records.some(record => (
		record.status === "error" || record.sourceRemoteStatus === "deferred"
	));
	return {
		status: hasPartialResult ? "partial" : "completed",
		records,
		reason: null,
	};
}
