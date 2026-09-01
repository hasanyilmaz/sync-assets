import type {
	GitHubRepository,
	IntegrityReason,
} from "./domain";
import type { RemoteHttpClient } from "./remote-release";
import {
	parseGitHubRepositorySlug,
	validatePluginId,
} from "./security";

export const COMMUNITY_PLUGIN_CATALOG_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
export const MAX_COMMUNITY_CATALOG_BYTES = 4 * 1024 * 1024;

export interface LoadedCommunityPluginCatalog {
	readonly status: "loaded";
	readonly repositories: ReadonlyMap<string, GitHubRepository>;
	readonly unavailableByPluginId: ReadonlyMap<string, IntegrityReason>;
}

export interface FailedCommunityPluginCatalog {
	readonly status: "error";
	readonly reason: IntegrityReason;
}

export type CommunityPluginCatalogResult =
	| LoadedCommunityPluginCatalog
	| FailedCommunityPluginCatalog;

export type CommunityRepositoryLookup =
	| { readonly status: "resolved"; readonly repository: GitHubRepository; readonly reason: null }
	| { readonly status: "unlisted" | "unavailable"; readonly repository: null; readonly reason: IntegrityReason };

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(code: string, message: string): FailedCommunityPluginCatalog {
	return { status: "error", reason: reason(code, message) };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown catalog error.";
}

export function parseCommunityPluginCatalog(
	value: unknown,
): CommunityPluginCatalogResult {
	if (!Array.isArray(value)) {
		return errorResult(
			"community-catalog-invalid-root",
			"The official community plugin catalog must be a JSON array.",
		);
	}

	const repositories = new Map<string, GitHubRepository>();
	const unavailableByPluginId = new Map<string, IntegrityReason>();
	const occurrenceCounts = new Map<string, number>();

	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry)) {
			continue;
		}
		const pluginId = validatePluginId(entry.id, `catalog[${index}].id`);
		if (!pluginId.ok) {
			continue;
		}
		const id = pluginId.value;
		occurrenceCounts.set(id, (occurrenceCounts.get(id) ?? 0) + 1);
		const repository = parseGitHubRepositorySlug(
			entry.repo,
			`catalog[${index}].repo`,
		);
		if (!repository.ok) {
			unavailableByPluginId.set(id, reason(
				"community-catalog-invalid-repository",
				"The official catalog entry does not contain a valid owner/repo value.",
			));
			continue;
		}
		repositories.set(id, repository.value);
	}

	for (const [pluginId, count] of occurrenceCounts) {
		if (count > 1) {
			repositories.delete(pluginId);
			unavailableByPluginId.set(pluginId, reason(
				"community-catalog-duplicate-plugin-id",
				"The official catalog contains more than one entry for this plugin ID.",
			));
		}
	}

	for (const pluginId of unavailableByPluginId.keys()) {
		repositories.delete(pluginId);
	}

	return { status: "loaded", repositories, unavailableByPluginId };
}

export async function fetchCommunityPluginCatalog(
	http: RemoteHttpClient,
): Promise<CommunityPluginCatalogResult> {
	let response;
	try {
		response = await http({
			url: COMMUNITY_PLUGIN_CATALOG_URL,
			method: "GET",
			headers: { Accept: "application/json" },
			throw: false,
		});
	} catch (error) {
		return errorResult(
			"community-catalog-request-error",
			`Could not load the official community plugin catalog: ${getErrorMessage(error)}`,
		);
	}

	if (response.status !== 200) {
		return errorResult(
			"community-catalog-http-error",
			`The official community plugin catalog returned HTTP ${response.status}.`,
		);
	}
	if (
		response.arrayBuffer.byteLength < 1
		|| response.arrayBuffer.byteLength > MAX_COMMUNITY_CATALOG_BYTES
	) {
		return errorResult(
			"community-catalog-size-out-of-range",
			`The official community plugin catalog must be between 1 and ${MAX_COMMUNITY_CATALOG_BYTES} bytes.`,
		);
	}

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(response.arrayBuffer);
	} catch {
		return errorResult(
			"community-catalog-invalid-utf8",
			"The official community plugin catalog is not valid UTF-8.",
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return errorResult(
			"community-catalog-invalid-json",
			"The official community plugin catalog is not valid JSON.",
		);
	}
	return parseCommunityPluginCatalog(parsed);
}

export function lookupCommunityRepository(
	catalog: CommunityPluginCatalogResult,
	pluginId: string,
): CommunityRepositoryLookup {
	if (catalog.status === "error") {
		return { status: "unavailable", repository: null, reason: catalog.reason };
	}
	const repository = catalog.repositories.get(pluginId);
	if (repository !== undefined) {
		return { status: "resolved", repository, reason: null };
	}
	const unavailable = catalog.unavailableByPluginId.get(pluginId);
	if (unavailable !== undefined) {
		return { status: "unavailable", repository: null, reason: unavailable };
	}
	return {
		status: "unlisted",
		repository: null,
		reason: reason(
			"community-catalog-plugin-not-found",
			"This installed plugin is not listed in the official Obsidian community catalog.",
		),
	};
}

export class CommunityPluginCatalogSession {
	private cached: Promise<CommunityPluginCatalogResult> | null = null;

	constructor(private readonly http: RemoteHttpClient) {}

	load(): Promise<CommunityPluginCatalogResult> {
		this.cached ??= fetchCommunityPluginCatalog(this.http);
		return this.cached;
	}

	retry(): Promise<CommunityPluginCatalogResult> {
		this.cached = null;
		return this.load();
	}
}
