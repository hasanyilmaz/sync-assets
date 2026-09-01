export const RELEASE_ASSET_NAMES = [
	"main.js",
	"manifest.json",
	"styles.css",
] as const;

export const OBSIDIAN_NO_SOURCE_MAP_SUFFIX = "\n/* nosourcemap */";

export type ReleaseAssetName = (typeof RELEASE_ASSET_NAMES)[number];

export const INTEGRITY_STATUSES = [
	"healthy",
	"repair-available",
	"missing",
	"mismatched",
	"unsupported",
	"unverifiable",
	"error",
] as const;

export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export interface GitHubRepository {
	readonly owner: string;
	readonly repo: string;
}

export interface RepositoryMapping {
	readonly pluginId: string;
	readonly repository: GitHubRepository;
}

export interface ArtifactFingerprint {
	readonly sizeBytes: number;
	readonly sha256: string;
}

export type LocalArtifactEvidence =
	| {
		readonly exists: null;
		readonly sizeBytes: null;
		readonly sha256: null;
	}
	| {
		readonly exists: false;
		readonly sizeBytes: null;
		readonly sha256: null;
	}
	| {
		readonly exists: true;
		readonly sizeBytes: number | null;
		readonly sha256: string | null;
	};

export const HASH_COMPUTATION_STATUSES = [
	"not-required",
	"not-computed",
	"computed",
	"error",
] as const;

export type HashComputationStatus =
	(typeof HASH_COMPUTATION_STATUSES)[number];

export interface IntegrityReason {
	readonly code: string;
	readonly message: string;
}

/**
 * File-level evidence. `repairEligible` is explicit because a missing or
 * mismatched file is not repairable until its remote release is trusted.
 */
export interface ArtifactIntegrityResult {
	readonly assetName: ReleaseAssetName;
	readonly status: IntegrityStatus;
	readonly expected: ArtifactFingerprint | null;
	readonly local: LocalArtifactEvidence;
	readonly hashStatus: HashComputationStatus;
	readonly repairEligible: boolean;
	readonly reason: IntegrityReason | null;
	readonly acceptedVariant: "obsidian-nosourcemap-suffix" | null;
}

export interface PluginIntegrityResult {
	readonly pluginId: string;
	readonly manifestVersion: string;
	readonly repository: GitHubRepository;
	readonly status: IntegrityStatus;
	readonly artifacts: readonly ArtifactIntegrityResult[];
	readonly repairEligible: boolean;
	readonly reason: IntegrityReason | null;
}
