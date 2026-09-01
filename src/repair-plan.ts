import type { IntegrityCheckRun } from "./check-coordinator";
import {
	RELEASE_ASSET_NAMES,
	type ArtifactFingerprint,
	type GitHubRepository,
	type IntegrityReason,
	type LocalArtifactEvidence,
	type ReleaseAssetName,
} from "./domain";
import type { EvaluatedIntegrityRecord } from "./integrity-verification";
import { MAX_HASHABLE_ARTIFACT_BYTES } from "./integrity-verification";
import type {
	DiscoveredPluginRecord,
	LocalPluginRecord,
} from "./local-discovery";
import {
	isTrustedReleaseAssetDownloadUrl,
	type ResolvedRemoteRecord,
	type TrustedReleaseAsset,
} from "./remote-release";
import { validatePluginId } from "./security";

export const REPAIR_APPLY_ORDER = [
	"main.js",
	"styles.css",
	"manifest.json",
] as const satisfies readonly ReleaseAssetName[];

const TRANSACTION_ID_PATTERN = /^repair-[0-9a-f]{32}$/;

export interface RepairPlanArtifact {
	readonly assetName: ReleaseAssetName;
	readonly targetPath: string;
	readonly stagedPath: string;
	readonly backupPath: string;
	readonly expected: ArtifactFingerprint;
	readonly original: LocalArtifactEvidence;
	readonly downloadUrl: string | null;
}

export interface RepairPlan {
	readonly transactionId: string;
	readonly fingerprint: string;
	readonly runId: number;
	readonly pluginId: string;
	readonly pluginName: string;
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly releaseId: number;
	readonly releaseTag: string;
	readonly pluginPath: string;
	readonly workspacePath: string;
	readonly stagedDirectoryPath: string;
	readonly backupDirectoryPath: string;
	readonly artifacts: readonly RepairPlanArtifact[];
	readonly remoteManifestBytes: ArrayBuffer;
}

export type RepairPlanResult =
	| { readonly ok: true; readonly plan: RepairPlan }
	| { readonly ok: false; readonly status: "blocked"; readonly reason: IntegrityReason };

export interface RepairPlanContext {
	readonly transactionId: string;
	readonly ownPluginId: string;
	readonly normalizePath: (path: string) => string;
}

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function blocked(code: string, message: string): RepairPlanResult {
	return { ok: false, status: "blocked", reason: reason(code, message) };
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

function sameFingerprint(
	left: ArtifactFingerprint | null,
	right: TrustedReleaseAsset | undefined,
): boolean {
	return left !== null
		&& right !== undefined
		&& left.sizeBytes === right.sizeBytes
		&& left.sha256 === right.sha256;
}

function uniqueMap<T extends { readonly pluginId: string }>(
	records: readonly T[],
): Map<string, T> | null {
	const result = new Map<string, T>();
	for (const record of records) {
		if (result.has(record.pluginId)) {
			return null;
		}
		result.set(record.pluginId, record);
	}
	return result;
}

function validateRecordSets(run: IntegrityCheckRun): IntegrityReason | null {
	if (
		run.status !== "completed"
		|| run.discovery === null
		|| run.remote === null
		|| run.verification === null
		|| run.discovery.status !== "completed"
		|| run.remote.status === "error"
		|| run.verification.status === "error"
	) {
		return reason(
			"repair-run-not-usable",
			"Repair planning requires one completed and usable integrity check run.",
		);
	}

	const local = uniqueMap(run.discovery.plugins);
	const remote = uniqueMap(run.remote.records);
	const verification = uniqueMap(run.verification.records);
	if (local === null || remote === null || verification === null) {
		return reason(
			"repair-duplicate-record",
			"Repair evidence contains a duplicate plugin record.",
		);
	}
	if (local.size !== remote.size || local.size !== verification.size) {
		return reason(
			"repair-record-set-mismatch",
			"Discovery, remote, and verification plugin record sets must match exactly.",
		);
	}
	for (const pluginId of local.keys()) {
		if (!remote.has(pluginId) || !verification.has(pluginId)) {
			return reason(
				"repair-record-set-mismatch",
				"Discovery, remote, and verification plugin record sets must match exactly.",
			);
		}
	}
	return null;
}

function validateLocalTarget(
	plugin: LocalPluginRecord | undefined,
	pluginId: string,
	pluginRoot: string,
	normalizePath: RepairPlanContext["normalizePath"],
): plugin is DiscoveredPluginRecord & { readonly repository: GitHubRepository } {
	return plugin?.status === "discovered"
		&& plugin.repository !== null
		&& plugin.pluginId === pluginId
		&& plugin.manifest.id === pluginId
		&& plugin.pluginPath === normalizePath(`${pluginRoot}/${pluginId}`)
		&& plugin.artifacts.length === RELEASE_ASSET_NAMES.length
		&& RELEASE_ASSET_NAMES.every(assetName => (
			plugin.artifacts.filter(snapshot => snapshot.assetName === assetName).length === 1
			&& plugin.artifacts.find(snapshot => snapshot.assetName === assetName)?.path
				=== normalizePath(`${plugin.pluginPath}/${assetName}`)
		));
}

function validateRemoteTarget(
	record: ResolvedRemoteRecord,
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
): IntegrityReason | null {
	if (
		record.pluginId !== plugin.pluginId
		|| record.manifestVersion !== plugin.manifest.version
		|| !sameRepository(record.repository, plugin.repository)
		|| !sameRepository(record.release.repository, plugin.repository)
		|| record.release.manifest.id !== plugin.pluginId
		|| record.release.manifest.version !== plugin.manifest.version
		|| !Number.isSafeInteger(record.release.releaseId)
		|| record.release.releaseId <= 0
		|| (
			record.release.tagName !== plugin.manifest.version
			&& record.release.tagName !== `v${plugin.manifest.version}`
		)
	) {
		return reason(
			"repair-release-identity-mismatch",
			"Resolved release identity does not exactly match the discovered plugin.",
		);
	}

	const assets = new Set<ReleaseAssetName>();
	for (const asset of record.release.assets) {
		if (assets.has(asset.assetName)) {
			return reason("repair-duplicate-asset", "Resolved release contains duplicate artifact evidence.");
		}
		assets.add(asset.assetName);
		if (
			!Number.isSafeInteger(asset.assetId)
			|| asset.assetId <= 0
			|| !Number.isSafeInteger(asset.sizeBytes)
			|| asset.sizeBytes < 0
			|| !/^sha256:[0-9a-f]{64}$/.test(asset.sha256)
		) {
			return reason(
				"repair-invalid-asset-metadata",
				`Resolved ${asset.assetName} metadata is not safe for repair.`,
			);
		}
		if (!isTrustedReleaseAssetDownloadUrl(
			asset.downloadUrl,
			plugin.repository,
			record.release.tagName,
			asset.assetName,
		)) {
			return reason(
				"repair-untrusted-download-url",
				`Resolved ${asset.assetName} download URL is not trusted for this release.`,
			);
		}
	}
	if (!assets.has("main.js") || !assets.has("manifest.json")) {
		return reason("repair-asset-set-mismatch", "Resolved release lacks a required artifact.");
	}
	return null;
}

function validateVerificationTarget(
	record: EvaluatedIntegrityRecord,
	plugin: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	remote: ResolvedRemoteRecord,
): IntegrityReason | null {
	if (
		record.pluginId !== plugin.pluginId
		|| record.manifestVersion !== plugin.manifest.version
		|| !sameRepository(record.repository, plugin.repository)
		|| record.sourceRemoteStatus !== "resolved"
		|| record.status !== "repair-available"
		|| !record.result.repairEligible
		|| record.result.pluginId !== plugin.pluginId
		|| record.result.manifestVersion !== plugin.manifest.version
		|| !sameRepository(record.result.repository, plugin.repository)
	) {
		return reason(
			"repair-verification-identity-mismatch",
			"Verification evidence is not a repair-available result for the selected plugin.",
		);
	}

	const artifacts = new Set<ReleaseAssetName>();
	for (const artifact of record.result.artifacts) {
		if (artifacts.has(artifact.assetName)) {
			return reason("repair-duplicate-verification-artifact", "Verification contains duplicate artifact evidence.");
		}
		artifacts.add(artifact.assetName);
		const trusted = remote.release.assets.find(candidate => (
			candidate.assetName === artifact.assetName
		));
		if (trusted === undefined) {
			if (artifact.expected !== null || artifact.repairEligible) {
				return reason("repair-verification-asset-mismatch", "Verification trusts an artifact absent from the release.");
			}
			continue;
		}
		if (!sameFingerprint(artifact.expected, trusted)) {
			return reason("repair-verification-asset-mismatch", "Verification fingerprint differs from trusted release metadata.");
		}
		if (
			artifact.repairEligible
			&& artifact.status !== "missing"
			&& artifact.status !== "mismatched"
		) {
			return reason("repair-ineligible-artifact-status", "Only missing or mismatched artifacts may be repair-eligible.");
		}
		if (artifact.repairEligible && artifact.local.exists === null) {
			return reason("repair-local-evidence-missing", "Repair-eligible artifact lacks definite local existence evidence.");
		}
	}
	if (!RELEASE_ASSET_NAMES.every(assetName => artifacts.has(assetName))) {
		return reason("repair-verification-artifact-set-mismatch", "Verification must contain every allowlisted artifact exactly once.");
	}
	return null;
}

function fingerprintFor(
	runId: number,
	transactionId: string,
	pluginId: string,
	repository: GitHubRepository,
	version: string,
	releaseId: number,
	tagName: string,
	artifacts: readonly RepairPlanArtifact[],
): string {
	const artifactFingerprint = artifacts.map(artifact => [
		artifact.assetName,
		artifact.targetPath,
		String(artifact.expected.sizeBytes),
		artifact.expected.sha256,
		artifact.original.exists === null ? "unknown" : String(artifact.original.exists),
		artifact.original.sizeBytes === null ? "null" : String(artifact.original.sizeBytes),
		artifact.original.sha256 ?? "null",
	].join(":"));
	return [
		"repair-plan-v1",
		String(runId),
		transactionId,
		pluginId,
		`${repository.owner}/${repository.repo}`,
		version,
		String(releaseId),
		tagName,
		...artifactFingerprint,
	].join("\n");
}

export function createRepairPlan(
	run: IntegrityCheckRun,
	pluginId: string,
	context: RepairPlanContext,
): RepairPlanResult {
	const recordSetProblem = validateRecordSets(run);
	if (recordSetProblem !== null) {
		return { ok: false, status: "blocked", reason: recordSetProblem };
	}
	if (!TRANSACTION_ID_PATTERN.test(context.transactionId)) {
		return blocked("invalid-repair-transaction-id", "Repair transaction ID is not path-safe.");
	}
	const ownPluginId = validatePluginId(context.ownPluginId, "ownPluginId");
	const targetPluginId = validatePluginId(pluginId, "pluginId");
	if (!ownPluginId.ok || !targetPluginId.ok || ownPluginId.value === targetPluginId.value) {
		return blocked("invalid-repair-target", "Repair target must be a path-safe plugin other than Sync Assets.");
	}

	const discovery = run.discovery;
	const remoteBatch = run.remote;
	const verificationBatch = run.verification;
	if (discovery === null || remoteBatch === null || verificationBatch === null) {
		return blocked("repair-run-not-usable", "Repair evidence is incomplete.");
	}
	const plugin = discovery.plugins.find(candidate => candidate.pluginId === pluginId);
	if (!validateLocalTarget(plugin, pluginId, discovery.pluginRoot, context.normalizePath)) {
		return blocked("repair-local-target-mismatch", "Selected plugin does not have a safe discovered local target.");
	}
	const remote = remoteBatch.records.find(candidate => candidate.pluginId === pluginId);
	if (remote?.status !== "resolved") {
		return blocked("repair-remote-not-resolved", "Selected plugin lacks a resolved trusted release.");
	}
	const remoteProblem = validateRemoteTarget(remote, plugin);
	if (remoteProblem !== null) {
		return { ok: false, status: "blocked", reason: remoteProblem };
	}
	const verification = verificationBatch.records.find(candidate => candidate.pluginId === pluginId);
	if (verification?.outcome !== "evaluated") {
		return blocked("repair-verification-not-evaluated", "Selected plugin lacks evaluated integrity evidence.");
	}
	const verificationProblem = validateVerificationTarget(verification, plugin, remote);
	if (verificationProblem !== null) {
		return { ok: false, status: "blocked", reason: verificationProblem };
	}

	const workspacePath = context.normalizePath(
		`${discovery.pluginRoot}/${ownPluginId.value}/.repair/${context.transactionId}`,
	);
	const stagedDirectoryPath = context.normalizePath(`${workspacePath}/staged`);
	const backupDirectoryPath = context.normalizePath(`${workspacePath}/backup`);
	const artifacts: RepairPlanArtifact[] = [];
	for (const assetName of REPAIR_APPLY_ORDER) {
		const integrity = verification.result.artifacts.find(candidate => (
			candidate.assetName === assetName
		));
		if (integrity?.repairEligible !== true) {
			continue;
		}
		const trusted = remote.release.assets.find(candidate => candidate.assetName === assetName);
		const snapshot = plugin.artifacts.find(candidate => candidate.assetName === assetName);
		if (
			trusted === undefined
			|| snapshot === undefined
			|| !sameFingerprint(integrity.expected, trusted)
		) {
			return blocked("repair-artifact-evidence-mismatch", `Repair evidence for ${assetName} is incomplete.`);
		}
		if (trusted.sizeBytes > MAX_HASHABLE_ARTIFACT_BYTES) {
			return blocked(
				"repair-artifact-size-limit",
				`Repair-eligible ${assetName} exceeds the ${MAX_HASHABLE_ARTIFACT_BYTES}-byte limit.`,
			);
		}
		artifacts.push({
			assetName,
			targetPath: snapshot.path,
			stagedPath: context.normalizePath(`${stagedDirectoryPath}/${assetName}`),
			backupPath: context.normalizePath(`${backupDirectoryPath}/${assetName}`),
			expected: { sizeBytes: trusted.sizeBytes, sha256: trusted.sha256 },
			original: { ...integrity.local },
			downloadUrl: assetName === "manifest.json" ? null : trusted.downloadUrl,
		});
	}
	if (artifacts.length === 0) {
		return blocked("repair-no-eligible-artifacts", "Selected plugin has no repair-eligible artifacts.");
	}

	const fingerprint = fingerprintFor(
		run.runId,
		context.transactionId,
		plugin.pluginId,
		plugin.repository,
		plugin.manifest.version,
		remote.release.releaseId,
		remote.release.tagName,
		artifacts,
	);
	return {
		ok: true,
		plan: {
			transactionId: context.transactionId,
			fingerprint,
			runId: run.runId,
			pluginId: plugin.pluginId,
			pluginName: plugin.manifest.name,
			repository: plugin.repository,
			manifestVersion: plugin.manifest.version,
			releaseId: remote.release.releaseId,
			releaseTag: remote.release.tagName,
			pluginPath: plugin.pluginPath,
			workspacePath,
			stagedDirectoryPath,
			backupDirectoryPath,
			artifacts,
			remoteManifestBytes: remote.release.manifestBytes.slice(0),
		},
	};
}
