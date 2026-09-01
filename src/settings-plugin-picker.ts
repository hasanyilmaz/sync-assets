import type { IntegrityReason } from "./domain";
import {
	lookupCommunityRepository,
	type CommunityPluginCatalogResult,
} from "./community-catalog";
import type { LocalDiscoveryResult } from "./local-discovery";
import {
	parseGitHubRepositorySlug,
	type ValidationIssue,
} from "./security";
import type { RepositoryMappingDraft } from "./settings-controller";

export interface InstalledPluginOption {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly version: string;
	readonly label: string;
	readonly repositorySlug: string | null;
	readonly repositorySource: "official-catalog" | null;
	readonly repositoryReason: IntegrityReason | null;
}

export interface MappingRowPresentation {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly version: string | null;
	readonly repositorySlug: string;
	readonly installed: boolean;
}

export interface SettingsPluginPickerModel {
	readonly options: readonly InstalledPluginOption[];
	readonly mappings: readonly MappingRowPresentation[];
	readonly discoveryReason: IntegrityReason | null;
}

export type MappingDraftCreationResult =
	| { readonly ok: true; readonly draft: RepositoryMappingDraft }
	| { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export function buildSettingsPluginPickerModel(
	discovery: LocalDiscoveryResult,
	drafts: readonly RepositoryMappingDraft[],
	catalog: CommunityPluginCatalogResult,
): SettingsPluginPickerModel {
	const discoveredById = new Map(
		discovery.plugins
			.filter(plugin => plugin.status === "discovered")
			.map(plugin => [plugin.pluginId, plugin] as const),
	);
	const mappedPluginIds = new Set(drafts.map(draft => draft.pluginId));
	const candidates = [...discoveredById.values()]
		.filter(plugin => !mappedPluginIds.has(plugin.pluginId))
		.map(plugin => {
			const lookup = lookupCommunityRepository(catalog, plugin.pluginId);
			return {
				pluginId: plugin.pluginId,
				pluginName: plugin.manifest.name,
				version: plugin.manifest.version,
				repositorySlug: lookup.repository === null
					? null
					: `${lookup.repository.owner}/${lookup.repository.repo}`,
				repositorySource: lookup.status === "resolved"
					? "official-catalog" as const
					: null,
				repositoryReason: lookup.reason,
			};
		});
	const nameCounts = new Map<string, number>();
	for (const candidate of candidates) {
		nameCounts.set(candidate.pluginName, (nameCounts.get(candidate.pluginName) ?? 0) + 1);
	}
	const options = candidates
		.map(candidate => ({
			...candidate,
			label: nameCounts.get(candidate.pluginName) === 1
				? candidate.pluginName
				: `${candidate.pluginName} (${candidate.pluginId})`,
		}))
		.sort((left, right) => (
			left.pluginName.localeCompare(right.pluginName)
			|| left.pluginId.localeCompare(right.pluginId)
		));
	const mappings = drafts.map(draft => {
		const installed = discoveredById.get(draft.pluginId);
		return {
			pluginId: draft.pluginId,
			pluginName: installed?.manifest.name ?? draft.pluginId,
			version: installed?.manifest.version ?? null,
			repositorySlug: draft.repositorySlug,
			installed: installed !== undefined,
		};
	});

	return {
		options,
		mappings,
		discoveryReason: discovery.status === "error"
			? discovery.issues[0] ?? {
				code: "settings-plugin-discovery-error",
				message: "Installed plugins could not be discovered.",
			}
			: null,
	};
}

export function createMappingDraftForOption(
	option: InstalledPluginOption,
	manualRepositorySlug: string,
): MappingDraftCreationResult {
	const repositorySlug = option.repositorySlug ?? manualRepositorySlug;
	const repository = parseGitHubRepositorySlug(
		repositorySlug,
		"repository",
	);
	if (!repository.ok) {
		return repository;
	}
	return {
		ok: true,
		draft: {
			pluginId: option.pluginId,
			repositorySlug: `${repository.value.owner}/${repository.value.repo}`,
		},
	};
}
