import {
	RELEASE_ASSET_NAMES,
	type GitHubRepository,
	type ReleaseAssetName,
} from "./domain";

export interface ValidationIssue {
	readonly code: string;
	readonly path: string;
	readonly message: string;
}

export type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const MANIFEST_VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function failure(code: string, path: string, message: string): ValidationResult<never> {
	return { ok: false, issues: [{ code, path, message }] };
}

export function validatePluginId(
	value: unknown,
	path = "pluginId",
): ValidationResult<string> {
	if (typeof value !== "string" || !PLUGIN_ID_PATTERN.test(value)) {
		return failure(
			"invalid-plugin-id",
			path,
			"Plugin ID must be a lowercase path-safe identifier.",
		);
	}

	return { ok: true, value };
}

export function validateGitHubRepository(
	owner: unknown,
	repo: unknown,
	path = "repository",
): ValidationResult<GitHubRepository> {
	const issues: ValidationIssue[] = [];

	if (typeof owner !== "string" || !GITHUB_OWNER_PATTERN.test(owner)) {
		issues.push({
			code: "invalid-github-owner",
			path: `${path}.owner`,
			message: "GitHub owner must be an account name, not a URL.",
		});
	}

	if (
		typeof repo !== "string"
		|| !GITHUB_REPO_PATTERN.test(repo)
		|| repo.toLowerCase().endsWith(".git")
	) {
		issues.push({
			code: "invalid-github-repository",
			path: `${path}.repo`,
			message: "GitHub repository must be a repository name, not a URL.",
		});
	}

	if (issues.length > 0 || typeof owner !== "string" || typeof repo !== "string") {
		return { ok: false, issues };
	}

	return { ok: true, value: { owner, repo } };
}

export function parseGitHubRepositorySlug(
	value: unknown,
	path = "repository",
): ValidationResult<GitHubRepository> {
	if (typeof value !== "string" || value.includes("://")) {
		return failure(
			"invalid-github-repository-slug",
			path,
			"Repository input must use the exact owner/repo form; URLs are not accepted.",
		);
	}

	const parts = value.split("/");
	if (parts.length !== 2) {
		return failure(
			"invalid-github-repository-slug",
			path,
			"Repository input must contain exactly one slash in owner/repo form.",
		);
	}

	return validateGitHubRepository(parts[0], parts[1], path);
}

export function buildReleaseTagCandidates(
	manifestVersion: unknown,
	path = "manifest.version",
): ValidationResult<readonly [string, string]> {
	if (
		typeof manifestVersion !== "string"
		|| !MANIFEST_VERSION_PATTERN.test(manifestVersion)
	) {
		return failure(
			"invalid-manifest-version",
			path,
			"Manifest version must be a valid unprefixed semantic version.",
		);
	}

	return {
		ok: true,
		value: [manifestVersion, `v${manifestVersion}`],
	};
}

export function isReleaseAssetName(value: string): value is ReleaseAssetName {
	return RELEASE_ASSET_NAMES.some(assetName => assetName === value);
}
