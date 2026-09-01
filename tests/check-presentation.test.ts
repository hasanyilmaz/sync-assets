import { describe, expect, it } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import {
	buildCheckPresentation,
	PRESENTATION_GROUP_ORDER,
	shouldShowHealthyGroup,
} from "../src/check-presentation";
import type {
	ArtifactIntegrityResult,
	GitHubRepository,
	IntegrityStatus,
} from "../src/domain";
import type {
	BlockedIntegrityRecord,
	EvaluatedIntegrityRecord,
	IntegrityVerificationRecord,
} from "../src/integrity-verification";
import type {
	ConfiguredMissingPluginRecord,
	DiscoveredPluginRecord,
	LocalPluginRecord,
} from "../src/local-discovery";
import type {
	RemoteResolutionRecord,
	ResolvedRemoteRecord,
	SkippedRemoteRecord,
	UnresolvedRemoteRecord,
} from "../src/remote-release";

const REPOSITORY = { owner: "example", repo: "plugin" };
const DIGEST = `sha256:${"a".repeat(64)}`;

function discovered(
	pluginId: string,
	name = `Plugin ${pluginId}`,
	repository: GitHubRepository | null = REPOSITORY,
): DiscoveredPluginRecord {
	return {
		status: "discovered",
		pluginId,
		pluginPath: `.obsidian/plugins/${pluginId}`,
		repository,
		manifest: {
			id: pluginId,
			name,
			author: "Example",
			version: "1.2.3",
			minAppVersion: "1.7.2",
			description: "Example plugin",
			isDesktopOnly: false,
		},
		artifacts: [],
		reason: null,
	};
}

function resolved(plugin: DiscoveredPluginRecord): ResolvedRemoteRecord {
	if (plugin.repository === null) {
		throw new Error("Resolved fixture needs a repository.");
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
			releaseId: 1,
			tagName: "1.2.3",
			publishedAt: "2026-08-30T12:00:00Z",
			assets: [],
			manifest: plugin.manifest,
			manifestBytes: new ArrayBuffer(0),
		},
		reason: null,
		retryAtMs: null,
	};
}

function unresolved(
	plugin: DiscoveredPluginRecord,
	status: UnresolvedRemoteRecord["status"],
): UnresolvedRemoteRecord {
	if (plugin.repository === null) {
		throw new Error("Unresolved fixture needs a repository.");
	}
	return {
		status,
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		requestCount: 1,
		rateLimit: null,
		release: null,
		reason: { code: `${status}-reason`, message: `${status} message` },
		retryAtMs: status === "deferred" ? 2_000_000 : null,
	};
}

function skipped(
	plugin: LocalPluginRecord,
	code: string,
): SkippedRemoteRecord {
	return {
		status: "skipped",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.status === "discovered"
			? plugin.manifest.version
			: null,
		requestCount: 0,
		rateLimit: null,
		release: null,
		reason: { code, message: code },
		retryAtMs: null,
	};
}

function evaluated(
	plugin: DiscoveredPluginRecord,
	status: IntegrityStatus,
	artifacts: readonly ArtifactIntegrityResult[] = [],
): EvaluatedIntegrityRecord {
	if (plugin.repository === null) {
		throw new Error("Evaluated fixture needs a repository.");
	}
	const repairEligible = artifacts.some(artifact => artifact.repairEligible);
	const problem = status === "healthy"
		? null
		: { code: `${status}-reason`, message: `${status} message` };
	return {
		outcome: "evaluated",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		status,
		sourceRemoteStatus: "resolved",
		result: {
			pluginId: plugin.pluginId,
			manifestVersion: plugin.manifest.version,
			repository: plugin.repository,
			status,
			artifacts,
			repairEligible,
			reason: problem,
		},
		reason: problem,
		retryAtMs: null,
	};
}

function blocked(
	plugin: DiscoveredPluginRecord,
	remoteStatus: BlockedIntegrityRecord["sourceRemoteStatus"],
	status: BlockedIntegrityRecord["status"],
	retryAtMs: number | null = null,
): BlockedIntegrityRecord {
	return {
		outcome: "blocked",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion: plugin.manifest.version,
		status,
		sourceRemoteStatus: remoteStatus,
		result: null,
		reason: { code: `${remoteStatus}-reason`, message: `${remoteStatus} message` },
		retryAtMs,
	};
}

function buildFixtureRun(): IntegrityCheckRun {
	const repairZeta = discovered("repair-zeta");
	const repairAlpha = discovered("repair-alpha");
	const healthy = discovered("healthy", "<img src=x onerror=alert(1)>");
	const mismatched = discovered("mismatched");
	const failed = discovered("failed");
	const unsupported = discovered("unsupported");
	const unverifiable = discovered("unverifiable");
	const deferred = discovered("deferred");
	const unmapped = discovered("unmapped", "Unmapped", null);
	const configuredMissing: ConfiguredMissingPluginRecord = {
		status: "configured-missing",
		pluginId: "configured-missing",
		pluginPath: ".obsidian/plugins/configured-missing",
		repository: REPOSITORY,
		manifest: null,
		artifacts: [],
		reason: { code: "configured-plugin-missing", message: "Missing folder." },
	};
	const repairArtifact: ArtifactIntegrityResult = {
		assetName: "main.js",
		status: "mismatched",
		expected: { sizeBytes: 10, sha256: DIGEST },
		local: { exists: true, sizeBytes: 8, sha256: null },
		hashStatus: "not-computed",
		repairEligible: true,
		reason: { code: "artifact-size-mismatch", message: "Sizes differ." },
		acceptedVariant: null,
	};
	const plugins = [
		deferred,
		configuredMissing,
		unmapped,
		unverifiable,
		unsupported,
		failed,
		mismatched,
		healthy,
		repairZeta,
		repairAlpha,
	];
	const remotes: RemoteResolutionRecord[] = [
		resolved(repairZeta),
		resolved(repairAlpha),
		resolved(healthy),
		resolved(mismatched),
		resolved(failed),
		unresolved(unsupported, "unsupported"),
		unresolved(unverifiable, "unverifiable"),
		unresolved(deferred, "deferred"),
		skipped(unmapped, "repository-not-configured"),
		skipped(configuredMissing, "local-configured-missing"),
	];
	const verifications: IntegrityVerificationRecord[] = [
		evaluated(repairZeta, "repair-available", [repairArtifact]),
		evaluated(repairAlpha, "repair-available", [repairArtifact]),
		evaluated(healthy, "healthy"),
		evaluated(mismatched, "mismatched"),
		evaluated(failed, "error"),
		blocked(unsupported, "unsupported", "unsupported"),
		blocked(unverifiable, "unverifiable", "unverifiable"),
		blocked(deferred, "deferred", "unverifiable", 2_000_000),
		{
			...blocked(unmapped, "skipped", "unsupported"),
			repository: null,
		},
		{
			outcome: "blocked",
			pluginId: configuredMissing.pluginId,
			repository: configuredMissing.repository,
			manifestVersion: null,
			status: "unverifiable",
			sourceRemoteStatus: "skipped",
			result: null,
			reason: { code: "local-configured-missing", message: "Missing folder." },
			retryAtMs: null,
		},
	];

	return {
		runId: 7,
		trigger: "manual",
		status: "completed",
		startedAtMs: 1000,
		finishedAtMs: 2000,
		settingsIssues: [{ code: "invalid-settings", path: "", message: "Safe defaults active." }],
		discovery: {
			status: "completed",
			pluginRoot: ".obsidian/plugins",
			plugins,
			issues: [],
		},
		remote: {
			status: "partial",
			records: remotes,
			requestCount: 12,
			rateLimit: {
				limit: 60,
				remaining: 0,
				resetAtMs: 2_000_000,
				retryAtMs: 2_000_000,
			},
			reason: null,
		},
		verification: {
			status: "partial",
			records: verifications,
			reason: null,
		},
		reason: null,
	};
}

describe("check presentation", () => {
	it("groups every result class in fixed order and sorts plugin IDs within groups", () => {
		const presentation = buildCheckPresentation(buildFixtureRun());

		expect(presentation.groups.map(group => group.id)).toEqual(PRESENTATION_GROUP_ORDER);
		expect(presentation.groups.map(group => group.displayMode)).toEqual([
			"cards",
			"healthy-list",
			"cards",
			"not-monitored",
			"cards",
		]);
		expect(presentation.groups.map(group => [
			group.id,
			group.plugins.map(plugin => plugin.pluginId),
		])).toEqual([
			["repair-available", ["repair-alpha", "repair-zeta"]],
			["healthy", ["healthy"]],
			["needs-attention", ["deferred", "failed", "mismatched", "unsupported", "unverifiable"]],
			["not-configured", ["unmapped"]],
			["configured-missing", ["configured-missing"]],
		]);
	});

	it("carries artifact evidence, rate limits, settings warnings, and retry time", () => {
		const presentation = buildCheckPresentation(buildFixtureRun());
		const repair = presentation.groups[0]?.plugins[0];
		const deferred = presentation.groups[2]?.plugins.find(plugin => plugin.pluginId === "deferred");

		expect(presentation).toEqual(expect.objectContaining({
			runId: 7,
			totalInstalled: 9,
			configuredMissing: 1,
			requestCount: 12,
			rateLimitRemaining: 0,
			rateLimitLimit: 60,
			rateLimitRetryAtMs: 2_000_000,
			settingsWarnings: ["Safe defaults active."],
		}));
		expect(repair?.releaseTag).toBe("1.2.3");
		expect(repair?.statusLabel).toBe("Repair needed");
		expect(repair?.artifacts[0]).toEqual(expect.objectContaining({
			assetName: "main.js",
			statusLabel: "Different",
			expectedSizeBytes: 10,
			localSizeBytes: 8,
			expectedSha256: DIGEST,
			hashStatus: "not-computed",
			repairEligible: true,
		}));
		expect(deferred?.retryAtMs).toBe(2_000_000);
		expect(deferred?.statusLabel).toBe("Could not verify");
	});

	it("keeps user-controlled display values as inert text-model strings", () => {
		const presentation = buildCheckPresentation(buildFixtureRun());
		const healthy = presentation.groups[1]?.plugins[0];

		expect(healthy?.pluginName).toBe("<img src=x onerror=alert(1)>");
		expect(healthy?.statusLabel).toBe("Up to date");
	});

	it("shows healthy plugins only when the result has no visible problems", () => {
		const presentation = buildCheckPresentation(buildFixtureRun());
		expect(shouldShowHealthyGroup(presentation)).toBe(false);

		const healthyOnly = {
			...presentation,
			settingsWarnings: [],
			reasonCode: null,
			groups: presentation.groups.map(group => ({
				...group,
				plugins: group.id === "healthy" ? group.plugins : [],
			})),
		};
		expect(shouldShowHealthyGroup(healthyOnly)).toBe(true);
	});

	it("returns a safe empty model when an unexpected failure happens before discovery", () => {
		const presentation = buildCheckPresentation({
			runId: 1,
			trigger: "manual",
			status: "failed",
			startedAtMs: 1,
			finishedAtMs: 2,
			settingsIssues: [],
			discovery: null,
			remote: null,
			verification: null,
			reason: { code: "integrity-check-error", message: "Failed." },
		});

		expect(presentation.totalInstalled).toBe(0);
		expect(presentation.groups.every(group => group.plugins.length === 0)).toBe(true);
		expect(presentation.reasonCode).toBe("integrity-check-error");
	});
});
