import type { RepositoryMapping } from "./domain";
import {
	type ValidationIssue,
	validateGitHubRepository,
	validatePluginId,
} from "./security";

export const SETTINGS_SCHEMA_VERSION = 2 as const;

export interface SyncAssetsSettings {
	readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
	readonly startupCheckEnabled: boolean;
	readonly repositories: readonly RepositoryMapping[];
}

export interface SettingsParseResult {
	readonly settings: SyncAssetsSettings;
	readonly issues: readonly ValidationIssue[];
	readonly usedDefaults: boolean;
}

const SETTINGS_KEYS = new Set([
	"schemaVersion",
	"startupCheckEnabled",
	"autoDeleteVerifiedBackups",
	"repositories",
]);
const MAPPING_KEYS = new Set(["pluginId", "repository"]);
const REPOSITORY_KEYS = new Set(["owner", "repo"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUnknownKeys(
	value: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
	path: string,
): ValidationIssue[] {
	return Object.keys(value)
		.filter(key => !allowedKeys.has(key))
		.map(key => ({
			code: "unknown-setting",
			path: path.length === 0 ? key : `${path}.${key}`,
			message: "Unknown settings fields are rejected to keep the trust configuration explicit.",
		}));
}

export function createDefaultSettings(): SyncAssetsSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		startupCheckEnabled: true,
		repositories: [],
	};
}

export function parseSettings(raw: unknown): SettingsParseResult {
	const issues: ValidationIssue[] = [];
	const repositories: RepositoryMapping[] = [];

	if (!isRecord(raw)) {
		return {
			settings: createDefaultSettings(),
			issues: [{
				code: "invalid-settings",
				path: "",
				message: "Settings must be an object.",
			}],
			usedDefaults: true,
		};
	}

	issues.push(...findUnknownKeys(raw, SETTINGS_KEYS, ""));

	if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
		issues.push({
			code: "unsupported-settings-schema",
			path: "schemaVersion",
			message: `Only settings schema ${SETTINGS_SCHEMA_VERSION} is supported.`,
		});
	}

	if (typeof raw.startupCheckEnabled !== "boolean") {
		issues.push({
			code: "invalid-startup-check-setting",
			path: "startupCheckEnabled",
			message: "Startup check setting must be a boolean.",
		});
	}
	if (
		raw.autoDeleteVerifiedBackups !== undefined
		&& typeof raw.autoDeleteVerifiedBackups !== "boolean"
	) {
		issues.push({
			code: "invalid-auto-cleanup-setting",
			path: "autoDeleteVerifiedBackups",
			message: "Automatic backup cleanup setting must be a boolean.",
		});
	}

	if (!Array.isArray(raw.repositories)) {
		issues.push({
			code: "invalid-repository-mappings",
			path: "repositories",
			message: "Repository mappings must be an array.",
		});
	} else {
		const pluginIds = new Set<string>();

		raw.repositories.forEach((mapping, index) => {
			const mappingPath = `repositories[${index}]`;
			if (!isRecord(mapping)) {
				issues.push({
					code: "invalid-repository-mapping",
					path: mappingPath,
					message: "Repository mapping must be an object.",
				});
				return;
			}

			issues.push(...findUnknownKeys(mapping, MAPPING_KEYS, mappingPath));
			const pluginIdResult = validatePluginId(
				mapping.pluginId,
				`${mappingPath}.pluginId`,
			);

			if (!isRecord(mapping.repository)) {
				issues.push({
					code: "invalid-github-repository",
					path: `${mappingPath}.repository`,
					message: "Repository must contain explicit owner and repo fields.",
				});
				return;
			}

			issues.push(
				...findUnknownKeys(
					mapping.repository,
					REPOSITORY_KEYS,
					`${mappingPath}.repository`,
				),
			);
			const repositoryResult = validateGitHubRepository(
				mapping.repository.owner,
				mapping.repository.repo,
				`${mappingPath}.repository`,
			);

			if (!pluginIdResult.ok) {
				issues.push(...pluginIdResult.issues);
			}
			if (!repositoryResult.ok) {
				issues.push(...repositoryResult.issues);
			}
			if (!pluginIdResult.ok || !repositoryResult.ok) {
				return;
			}

			if (pluginIds.has(pluginIdResult.value)) {
				issues.push({
					code: "duplicate-plugin-id",
					path: `${mappingPath}.pluginId`,
					message: "Each plugin ID may have only one trusted repository mapping.",
				});
				return;
			}

			pluginIds.add(pluginIdResult.value);
			repositories.push({
				pluginId: pluginIdResult.value,
				repository: repositoryResult.value,
			});
		});
	}

	if (issues.length > 0 || typeof raw.startupCheckEnabled !== "boolean") {
		return {
			settings: createDefaultSettings(),
			issues,
			usedDefaults: true,
		};
	}

	return {
		settings: {
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			startupCheckEnabled: raw.startupCheckEnabled,
			repositories,
		},
		issues: [],
		usedDefaults: false,
	};
}
