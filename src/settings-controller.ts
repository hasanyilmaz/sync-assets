import {
	parseGitHubRepositorySlug,
	type ValidationIssue,
	validatePluginId,
} from "./security";
import {
	createDefaultSettings,
	type SyncAssetsSettings,
} from "./settings";
import {
	PersistentDataController,
	type PersistedDataStorage,
	type SyncAssetsPersistedData,
} from "./persisted-state";

export interface RepositoryMappingDraft {
	readonly pluginId: string;
	readonly repositorySlug: string;
}

export type SettingsStorage = PersistedDataStorage;

export interface SettingsState {
	readonly settings: SyncAssetsSettings;
	readonly issues: readonly ValidationIssue[];
	readonly usedDefaults: boolean;
}

export type SettingsSaveResult =
	| { readonly ok: true; readonly state: SettingsState }
	| { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function issue(code: string, path: string, message: string): ValidationIssue {
	return { code, path, message };
}

function cloneSettings(settings: SyncAssetsSettings): SyncAssetsSettings {
	return {
		schemaVersion: settings.schemaVersion,
		startupCheckEnabled: settings.startupCheckEnabled,
		repositories: settings.repositories.map(mapping => ({
			pluginId: mapping.pluginId,
			repository: { ...mapping.repository },
		})),
	};
}

export function createMappingDrafts(
	settings: SyncAssetsSettings,
): RepositoryMappingDraft[] {
	return settings.repositories.map(mapping => ({
		pluginId: mapping.pluginId,
		repositorySlug: `${mapping.repository.owner}/${mapping.repository.repo}`,
	}));
}

export function validateMappingDrafts(
	drafts: readonly RepositoryMappingDraft[],
	startupCheckEnabled: boolean,
): SettingsSaveResult {
	const issues: ValidationIssue[] = [];
	const repositories: SyncAssetsSettings["repositories"][number][] = [];
	const pluginIds = new Set<string>();

	for (const [index, draft] of drafts.entries()) {
		const mappingPath = `repositories[${index}]`;
		const pluginId = validatePluginId(draft.pluginId, `${mappingPath}.pluginId`);
		const repository = parseGitHubRepositorySlug(
			draft.repositorySlug,
			`${mappingPath}.repository`,
		);

		if (!pluginId.ok) {
			issues.push(...pluginId.issues);
		}
		if (!repository.ok) {
			issues.push(...repository.issues);
		}
		if (!pluginId.ok || !repository.ok) {
			continue;
		}
		if (pluginIds.has(pluginId.value)) {
			issues.push(issue(
				"duplicate-plugin-id",
				`${mappingPath}.pluginId`,
				"Each plugin ID may have only one trusted repository mapping.",
			));
			continue;
		}

		pluginIds.add(pluginId.value);
		repositories.push({
			pluginId: pluginId.value,
			repository: repository.value,
		});
	}

	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: {
			settings: {
				schemaVersion: 2,
				startupCheckEnabled,
				repositories,
			},
			issues: [],
			usedDefaults: false,
		},
	};
}

export class SettingsController {
	private state: SettingsState = {
		settings: createDefaultSettings(),
		issues: [],
		usedDefaults: false,
	};

	private readonly persistence: PersistentDataController;

	constructor(storage: SettingsStorage | PersistentDataController) {
		this.persistence = storage instanceof PersistentDataController
			? storage
			: new PersistentDataController(storage);
	}

	getPersistence(): PersistentDataController {
		return this.persistence;
	}

	getState(): SettingsState {
		return {
			settings: cloneSettings(this.state.settings),
			issues: [...this.state.issues],
			usedDefaults: this.state.usedDefaults,
		};
	}

	async load(): Promise<SettingsState> {
		const parsed = await this.persistence.load();
		this.state = {
			settings: {
				schemaVersion: parsed.data.schemaVersion,
				startupCheckEnabled: parsed.data.startupCheckEnabled,
				repositories: parsed.data.repositories,
			},
			issues: parsed.issues,
			usedDefaults: parsed.usedDefaults,
		};
		return this.getState();
	}

	async saveDrafts(
		drafts: readonly RepositoryMappingDraft[],
		startupCheckEnabled = this.state.settings.startupCheckEnabled,
	): Promise<SettingsSaveResult> {
		const validation = validateMappingDrafts(
			drafts,
			startupCheckEnabled,
		);
		if (!validation.ok) {
			return validation;
		}

		const persisted = await this.persistence.mutate(current => ({
			...current,
			startupCheckEnabled: validation.state.settings.startupCheckEnabled,
			repositories: validation.state.settings.repositories,
		}));
		if (!persisted.ok) {
			return {
				ok: false,
				issues: [issue(
					"settings-save-error",
					"",
					persisted.issue.message,
				)],
			};
		}

		const saved: SyncAssetsPersistedData = persisted.data;
		this.state = {
			settings: {
				schemaVersion: saved.schemaVersion,
				startupCheckEnabled: saved.startupCheckEnabled,
				repositories: saved.repositories,
			},
			issues: [],
			usedDefaults: false,
		};
		return { ok: true, state: this.getState() };
	}
}
