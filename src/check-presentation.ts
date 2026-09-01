import type {
	ArtifactIntegrityResult,
	HashComputationStatus,
	IntegrityStatus,
	ReleaseAssetName,
} from "./domain";
import type {
	CheckTrigger,
	IntegrityCheckRun,
} from "./check-coordinator";
import type { LocalPluginRecord } from "./local-discovery";
import type { RemoteResolutionRecord } from "./remote-release";

export const PRESENTATION_GROUP_ORDER = [
	"repair-available",
	"healthy",
	"needs-attention",
	"not-configured",
	"configured-missing",
] as const;

export type PresentationGroupId =
	(typeof PRESENTATION_GROUP_ORDER)[number];

export interface ArtifactPresentation {
	readonly assetName: ReleaseAssetName;
	readonly status: IntegrityStatus;
	readonly statusLabel: string;
	readonly expectedSizeBytes: number | null;
	readonly localExists: boolean | null;
	readonly localSizeBytes: number | null;
	readonly expectedSha256: string | null;
	readonly localSha256: string | null;
	readonly hashStatus: HashComputationStatus;
	readonly repairEligible: boolean;
	readonly reasonCode: string | null;
	readonly reasonMessage: string | null;
}

export interface PluginPresentation {
	readonly groupId: PresentationGroupId;
	readonly pluginId: string;
	readonly pluginName: string;
	readonly repositorySlug: string | null;
	readonly manifestVersion: string | null;
	readonly releaseTag: string | null;
	readonly status: IntegrityStatus;
	readonly statusLabel: string;
	readonly reasonCode: string | null;
	readonly reasonMessage: string | null;
	readonly retryAtMs: number | null;
	readonly artifacts: readonly ArtifactPresentation[];
}

export interface PresentationGroup {
	readonly id: PresentationGroupId;
	readonly title: string;
	readonly displayMode: "cards" | "healthy-list" | "not-monitored";
	readonly plugins: readonly PluginPresentation[];
}

export interface CheckPresentation {
	readonly runId: number;
	readonly trigger: CheckTrigger;
	readonly status: IntegrityCheckRun["status"];
	readonly startedAtMs: number;
	readonly finishedAtMs: number;
	readonly totalInstalled: number;
	readonly configuredMissing: number;
	readonly requestCount: number;
	readonly rateLimitRemaining: number | null;
	readonly rateLimitLimit: number | null;
	readonly rateLimitRetryAtMs: number | null;
	readonly settingsWarnings: readonly string[];
	readonly reasonCode: string | null;
	readonly reasonMessage: string | null;
	readonly groups: readonly PresentationGroup[];
}

export function shouldShowHealthyGroup(
	presentation: CheckPresentation,
): boolean {
	if (presentation.reasonCode !== null || presentation.settingsWarnings.length > 0) {
		return false;
	}
	return presentation.groups.every(group => (
		!["repair-available", "needs-attention", "configured-missing"].includes(group.id)
		|| group.plugins.length === 0
	));
}

const GROUP_TITLES: Readonly<Record<PresentationGroupId, string>> = {
	"repair-available": "Repair needed",
	healthy: "Healthy",
	"needs-attention": "Needs attention",
	"not-configured": "Not configured",
	"configured-missing": "Configured but missing",
};

export const INTEGRITY_STATUS_LABELS: Readonly<Record<IntegrityStatus, string>> = {
	healthy: "Up to date",
	"repair-available": "Repair needed",
	missing: "Missing",
	mismatched: "Different",
	unsupported: "Not supported",
	unverifiable: "Could not verify",
	error: "Check failed",
};

function artifactPresentation(
	artifact: ArtifactIntegrityResult,
): ArtifactPresentation {
	return {
		assetName: artifact.assetName,
		status: artifact.status,
		statusLabel: INTEGRITY_STATUS_LABELS[artifact.status],
		expectedSizeBytes: artifact.expected?.sizeBytes ?? null,
		localExists: artifact.local.exists,
		localSizeBytes: artifact.local.sizeBytes,
		expectedSha256: artifact.expected?.sha256 ?? null,
		localSha256: artifact.local.sha256,
		hashStatus: artifact.hashStatus,
		repairEligible: artifact.repairEligible,
		reasonCode: artifact.reason?.code ?? null,
		reasonMessage: artifact.reason?.message ?? null,
	};
}

function repositorySlug(plugin: LocalPluginRecord): string | null {
	return plugin.repository === null
		? null
		: `${plugin.repository.owner}/${plugin.repository.repo}`;
}

function classifyGroup(
	plugin: LocalPluginRecord,
	remote: RemoteResolutionRecord | undefined,
	status: IntegrityStatus,
): PresentationGroupId {
	if (plugin.status === "configured-missing") {
		return "configured-missing";
	}
	if (
		remote?.status === "skipped"
		&& remote.reason.code === "repository-not-configured"
	) {
		return "not-configured";
	}
	if (status === "repair-available") {
		return "repair-available";
	}
	if (status === "healthy") {
		return "healthy";
	}
	return "needs-attention";
}

function fallbackStatus(plugin: LocalPluginRecord): IntegrityStatus {
	if (plugin.status === "error") {
		return "error";
	}
	if (plugin.status === "configured-missing") {
		return "missing";
	}
	return "unverifiable";
}

export function buildCheckPresentation(
	run: IntegrityCheckRun,
): CheckPresentation {
	const remoteById = new Map(
		run.remote?.records.map(record => [record.pluginId, record] as const) ?? [],
	);
	const verificationById = new Map(
		run.verification?.records.map(record => [record.pluginId, record] as const) ?? [],
	);
	const grouped = new Map<PresentationGroupId, PluginPresentation[]>(
		PRESENTATION_GROUP_ORDER.map(groupId => [groupId, []]),
	);

	for (const plugin of run.discovery?.plugins ?? []) {
		const remote = remoteById.get(plugin.pluginId);
		const verification = verificationById.get(plugin.pluginId);
		const status = verification?.status ?? fallbackStatus(plugin);
		const groupId = classifyGroup(plugin, remote, status);
		const releaseTag = remote?.status === "resolved"
			? remote.release.tagName
			: null;
		const manifestVersion = plugin.status === "discovered"
			? plugin.manifest.version
			: null;
		const pluginName = plugin.status === "discovered"
			? plugin.manifest.name
			: plugin.pluginId;
		const problem = verification?.reason ?? remote?.reason ?? plugin.reason;
		const artifacts = verification?.outcome === "evaluated"
			? verification.result.artifacts.map(artifactPresentation)
			: [];

		grouped.get(groupId)?.push({
			groupId,
			pluginId: plugin.pluginId,
			pluginName,
			repositorySlug: repositorySlug(plugin),
			manifestVersion,
			releaseTag,
			status,
			statusLabel: INTEGRITY_STATUS_LABELS[status],
			reasonCode: problem?.code ?? null,
			reasonMessage: problem?.message ?? null,
			retryAtMs: verification?.retryAtMs ?? remote?.retryAtMs ?? null,
			artifacts,
		});
	}

	const groups = PRESENTATION_GROUP_ORDER.map(groupId => ({
		id: groupId,
		title: GROUP_TITLES[groupId],
		displayMode: groupId === "healthy"
			? "healthy-list" as const
			: groupId === "not-configured"
				? "not-monitored" as const
				: "cards" as const,
		plugins: [...(grouped.get(groupId) ?? [])].sort((left, right) => (
			left.pluginId.localeCompare(right.pluginId)
		)),
	}));
	const plugins = run.discovery?.plugins ?? [];

	return {
		runId: run.runId,
		trigger: run.trigger,
		status: run.status,
		startedAtMs: run.startedAtMs,
		finishedAtMs: run.finishedAtMs,
		totalInstalled: plugins.filter(plugin => plugin.status !== "configured-missing").length,
		configuredMissing: plugins.filter(plugin => plugin.status === "configured-missing").length,
		requestCount: run.remote?.requestCount ?? 0,
		rateLimitRemaining: run.remote?.rateLimit?.remaining ?? null,
		rateLimitLimit: run.remote?.rateLimit?.limit ?? null,
		rateLimitRetryAtMs: run.remote?.rateLimit?.retryAtMs ?? null,
		settingsWarnings: run.settingsIssues.map(foundIssue => foundIssue.message),
		reasonCode: run.reason?.code ?? null,
		reasonMessage: run.reason?.message ?? null,
		groups,
	};
}
