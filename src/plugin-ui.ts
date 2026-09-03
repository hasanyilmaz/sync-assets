import {
	type App,
	ButtonComponent,
	Modal,
	Notice,
	type Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
} from "obsidian";

import {
	type CheckCoordinatorSnapshot,
	type CheckPhase,
	type IntegrityCheckRun,
	IntegrityCheckCoordinator,
} from "./check-coordinator";
import {
	CommunityPluginCatalogSession,
	type CommunityPluginCatalogResult,
} from "./community-catalog";
import {
	buildCheckPresentation,
	hasRetryableRemoteFailure,
	shouldShowHealthyGroup,
	type ArtifactPresentation,
	type CheckPresentation,
	type PresentationGroup,
	type PluginPresentation,
} from "./check-presentation";
import type { LocalDiscoveryResult } from "./local-discovery";
import {
	InlineRepairApprovalProvider,
	runAuthorizedRepairBatch,
} from "./repair-approval";
import { buildRepairHistoryPresentations } from "./repair-history-presentation";
import {
	PersistentRepairJournal,
} from "./repair-lifecycle";
import {
	RepairUiCoordinator,
	type RepairUiSnapshot,
} from "./repair-ui-coordinator";
import {
	createMappingDrafts,
	type RepositoryMappingDraft,
	SettingsController,
} from "./settings-controller";
import {
	buildSettingsPluginPickerModel,
	createMappingDraftForOption,
	type InstalledPluginOption,
} from "./settings-plugin-picker";
import type { SyncAssetsSettings } from "./settings";

const PHASE_LABELS: Readonly<Record<CheckPhase, string>> = {
	idle: "Ready to check installed plugins.",
	discovering: "Discovering installed plugins…",
	resolving: "Resolving exact GitHub releases…",
	verifying: "Verifying local artifact integrity…",
	completed: "Results ready.",
	failed: "Integrity check failed.",
};

function formatBytes(value: number | null): string {
	if (value === null) {
		return "Unknown";
	}
	return `${value.toLocaleString()} bytes`;
}

function formatDate(value: number): string {
	return new Date(value).toLocaleString();
}

function appendLabelValue(
	container: HTMLElement,
	label: string,
	value: string,
	code = false,
): void {
	const row = container.createDiv({ cls: "sync-assets-detail-row" });
	row.createSpan({ cls: "sync-assets-detail-label", text: `${label}: ` });
	row.createEl(code ? "code" : "span", { text: value });
}

function renderArtifact(
	container: HTMLElement,
	artifact: ArtifactPresentation,
): void {
	container.createDiv({
		cls: "sync-assets-artifact",
		text: `${artifact.assetName} — ${artifact.statusLabel}`,
	});
}

function renderArtifactTechnical(
	container: HTMLElement,
	artifact: ArtifactPresentation,
): void {
	const body = container.createDiv({ cls: "sync-assets-repair-artifact" });
	body.createEl("strong", { text: artifact.assetName });
	appendLabelValue(body, "Status", artifact.statusLabel);
	appendLabelValue(body, "Expected size", formatBytes(artifact.expectedSizeBytes));
	appendLabelValue(body, "Local size", formatBytes(artifact.localSizeBytes));
	appendLabelValue(body, "Local exists", artifact.localExists === null
		? "Unknown"
		: artifact.localExists ? "Yes" : "No");
	appendLabelValue(body, "Hash status", artifact.hashStatus);
	appendLabelValue(body, "Repair eligible", artifact.repairEligible ? "Yes" : "No");
	if (artifact.expectedSha256 !== null) {
		appendLabelValue(body, "Expected SHA-256", artifact.expectedSha256, true);
	}
	if (artifact.localSha256 !== null) {
		appendLabelValue(body, "Local SHA-256", artifact.localSha256, true);
	}
	if (artifact.reasonCode !== null) {
		appendLabelValue(body, "Reason", artifact.reasonCode, true);
	}
	if (artifact.reasonMessage !== null) {
		body.createEl("p", { text: artifact.reasonMessage });
	}
}

function renderPlugin(
	container: HTMLElement,
	plugin: PluginPresentation,
	getRepairBlockMessage: ((pluginId: string) => string | null) = () => null,
): void {
	const card = container.createDiv({ cls: "sync-assets-plugin-card" });
	const heading = card.createDiv({ cls: "sync-assets-plugin-heading" });
	heading.createEl("strong", { text: plugin.pluginName });
	heading.createSpan({
		cls: "sync-assets-status",
		text: plugin.statusLabel,
	});
	if (plugin.reasonMessage !== null && plugin.retryAtMs === null) {
		card.createEl("p", { text: plugin.reasonMessage });
	}
	if (plugin.retryAtMs !== null) {
		card.createEl("p", {
			cls: "setting-item-description",
			text: `GitHub limit reached — try again after ${formatDate(plugin.retryAtMs)}.`,
		});
	}
	for (const artifact of plugin.artifacts) {
		renderArtifact(card, artifact);
	}
	const technical = card.createEl("details", { cls: "sync-assets-technical" });
	technical.createEl("summary", { text: "Technical details" });
	const technicalBody = technical.createDiv({ cls: "sync-assets-artifact-body" });
	if (plugin.groupId !== "repair-available") {
		appendLabelValue(technicalBody, "Plugin ID", plugin.pluginId, true);
		if (plugin.repositorySlug !== null) {
			appendLabelValue(technicalBody, "Repository", plugin.repositorySlug, true);
		}
		if (plugin.manifestVersion !== null) {
			appendLabelValue(technicalBody, "Manifest version", plugin.manifestVersion, true);
		}
		if (plugin.releaseTag !== null) {
			appendLabelValue(technicalBody, "Release tag", plugin.releaseTag, true);
		}
		if (plugin.reasonCode !== null) {
			appendLabelValue(technicalBody, "Reason", plugin.reasonCode, true);
		}
		if (plugin.technicalMessage !== null) {
			appendLabelValue(technicalBody, "Technical error", plugin.technicalMessage, true);
		}
	}
	const technicalArtifacts = plugin.groupId === "repair-available"
		? plugin.artifacts.filter(artifact => artifact.status !== "healthy")
		: plugin.artifacts;
	for (const artifact of technicalArtifacts) {
		renderArtifactTechnical(technicalBody, artifact);
	}
	if (plugin.groupId === "repair-available") {
		const blockMessage = getRepairBlockMessage(plugin.pluginId);
		if (blockMessage !== null) {
			card.createEl("p", {
				cls: "setting-item-description sync-assets-repair-blocked",
				text: blockMessage,
			});
		}
	}
}

function renderHealthyGroup(
	container: HTMLElement,
	group: PresentationGroup,
): void {
	const list = container.createDiv({ cls: "sync-assets-summary sync-assets-healthy-list" });
	for (const plugin of group.plugins) {
		const item = list.createDiv({ cls: "sync-assets-healthy-plugin" });
		item.createEl("strong", { text: `✓ ${plugin.pluginName}` });
		const artifactCount = plugin.artifacts.length;
		item.createEl("p", {
			cls: "setting-item-description",
			text: `${artifactCount} ${artifactCount === 1 ? "file" : "files"} checked — everything matches.`,
		});
	}
}

function renderPresentation(
	container: HTMLElement,
	presentation: CheckPresentation,
	getRepairBlockMessage: ((pluginId: string) => string | null) = () => null,
): void {
	const showHealthy = shouldShowHealthyGroup(presentation);
	if (presentation.reasonCode !== null) {
		const warning = container.createDiv({ cls: "sync-assets-warning" });
		warning.createEl("strong", { text: "The check could not finish" });
		warning.createEl("p", { text: presentation.reasonMessage ?? "Please try again." });
	}
	if (presentation.settingsWarnings.length > 0) {
		const warning = container.createDiv({ cls: "sync-assets-warning" });
		warning.createEl("strong", { text: "Settings warning" });
		const list = warning.createEl("ul");
		for (const message of presentation.settingsWarnings) {
			list.createEl("li", { text: message });
		}
	}

	for (const group of presentation.groups) {
		if (group.plugins.length === 0) {
			continue;
		}
		if (group.displayMode === "healthy-list") {
			if (showHealthy) {
				renderHealthyGroup(container, group);
			}
			continue;
		}
		if (group.displayMode === "not-monitored") {
			continue;
		}
		if (group.id !== "repair-available") {
			container.createEl("h3", { text: `${group.title} (${group.plugins.length})` });
		}
		const groupContainer = container.createDiv({ cls: "sync-assets-group" });
		for (const plugin of group.plugins) {
			renderPlugin(
				groupContainer,
				plugin,
				getRepairBlockMessage,
			);
		}
	}
}

export class IntegrityResultsModal extends Modal {
	private unsubscribe: (() => void) | null = null;
	private unsubscribeRepair: (() => void) | null = null;
	private repairSnapshot: RepairUiSnapshot;
	private batchRunning = false;

	constructor(
		app: App,
		private readonly coordinator: IntegrityCheckCoordinator,
		private readonly startCheck: () => Promise<unknown>,
		private readonly repairCoordinator: RepairUiCoordinator,
		private readonly journal: PersistentRepairJournal,
		private readonly approval: InlineRepairApprovalProvider,
		private readonly reloadApp: () => boolean,
	) {
		super(app);
		this.repairSnapshot = repairCoordinator.getSnapshot();
	}

	onOpen(): void {
		this.setTitle("Sync Assets integrity check");
		this.modalEl.addClass("sync-assets-modal");
		this.unsubscribe?.();
		this.unsubscribe = this.coordinator.subscribe(snapshot => {
			this.render(snapshot);
		});
		this.unsubscribeRepair = this.repairCoordinator.subscribe(snapshot => {
			this.repairSnapshot = snapshot;
			this.render(this.coordinator.getSnapshot());
		});
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeRepair?.();
		this.unsubscribeRepair = null;
		this.contentEl.empty();
	}

	private render(snapshot: CheckCoordinatorSnapshot): void {
		this.contentEl.empty();
		const isRunning = snapshot.activeRunId !== null;
		const mutationRunning = this.repairSnapshot.operation !== "idle";
		const repairRunning = mutationRunning || this.batchRunning;
		const committedLatestRun = this.repairSnapshot.latestRepair?.status === "committed"
			&& this.repairSnapshot.latestRepair.receipt !== null
			&& this.repairSnapshot.latestRepair.receipt.runId === snapshot.latestRun?.runId;
		if (isRunning || repairRunning) {
			this.contentEl.createEl("p", {
				cls: "sync-assets-progress",
				text: isRunning
					? snapshot.progressLabel ?? PHASE_LABELS[snapshot.phase]
					: this.repairSnapshot.operation === "cleaning-up"
						? "Removing verified backup…"
						: "Repairing plugins…",
			});
		}

		let footerRepairPlugins: readonly PluginPresentation[] = [];
		let footerRepairBlocked = false;
		let retryAvailable = false;
		if (
			!isRunning
			&& !repairRunning
			&& snapshot.latestRun !== null
			&& !committedLatestRun
		) {
			const latestRun = snapshot.latestRun;
			const presentation = buildCheckPresentation(latestRun);
			retryAvailable = hasRetryableRemoteFailure(presentation);
			const repairPlugins = presentation.groups.find(group => (
				group.id === "repair-available"
			))?.plugins ?? [];
			const getRepairBlockMessage = (pluginId: string): string | null => {
				if (repairRunning) {
					return "A repair operation is already in progress.";
				}
				if (!this.repairCoordinator.canUseEvidence(pluginId, latestRun.runId)) {
					return "Run a new check before repairing this plugin again.";
				}
				if (this.journal.getSnapshot().blockingRecord !== null) {
					return "A previous repair needs attention. Open Settings → Sync Assets for details.";
				}
				return null;
			};
			footerRepairPlugins = repairPlugins;
			footerRepairBlocked = repairPlugins.some(plugin => (
				getRepairBlockMessage(plugin.pluginId) !== null
			));
			renderPresentation(
				this.contentEl,
				presentation,
				getRepairBlockMessage,
			);
		}

		if (committedLatestRun || repairRunning) {
			return;
		}
		const actions = this.contentEl.createDiv({
			cls: "sync-assets-actions sync-assets-result-actions",
		});
		const secondaryActions = actions.createDiv({ cls: "sync-assets-result-secondary-actions" });
		new ButtonComponent(secondaryActions)
			.setButtonText("Cancel")
			.setClass("sync-assets-cancel-button")
			.setTooltip("Closes this window without repairing any plugins.")
			.onClick(() => this.close());
		const primaryActions = actions.createDiv({ cls: "sync-assets-result-primary-actions" });
		if (retryAvailable) {
			new ButtonComponent(primaryActions)
				.setButtonText("Try again")
				.setTooltip("Runs the integrity check again.")
				.setDisabled(isRunning || repairRunning)
				.onClick(() => {
					void this.startCheck();
				});
		}
		if (footerRepairPlugins.length > 0 && !footerRepairBlocked && snapshot.latestRun !== null) {
			const latestRun = snapshot.latestRun;
			const needsFullRestart = footerRepairPlugins.some(plugin => (
				plugin.artifacts.some(artifact => (
					artifact.assetName === "manifest.json" && artifact.repairEligible
				))
			));
			new ButtonComponent(primaryActions)
				.setButtonText("Repair")
				.setCta()
				.setTooltip(needsFullRestart
					? "Repairs all listed plugins. Restart Obsidian afterward."
					: "Repairs all listed plugins. Reload or restart Obsidian afterward.")
				.setDisabled(isRunning || repairRunning)
				.onClick(() => {
					void this.runRepairBatch(latestRun, footerRepairPlugins, false);
				});
			if (!needsFullRestart) {
				new ButtonComponent(primaryActions)
					.setButtonText("Repair and reload Obsidian")
					.setCta()
					.setTooltip("Repairs all listed plugins, then reloads Obsidian automatically.")
					.setDisabled(isRunning || repairRunning)
					.onClick(() => {
						void this.runRepairBatch(latestRun, footerRepairPlugins, true);
					});
			}
		}
	}

	private async runRepairBatch(
		run: IntegrityCheckRun,
		plugins: readonly PluginPresentation[],
		reloadAfterCommit: boolean,
	): Promise<void> {
		this.batchRunning = true;
		this.render(this.coordinator.getSnapshot());
		const result = await runAuthorizedRepairBatch(
			run,
			plugins.map(plugin => plugin.pluginId),
			this.approval,
			this.repairCoordinator,
		);
		if (result.status !== "committed") {
			this.batchRunning = false;
			await this.startCheck();
			return;
		}
		this.batchRunning = false;
		this.close();
		if (reloadAfterCommit && !this.reloadApp()) {
			new Notice("Repair finished, but Obsidian could not reload automatically. Reload or restart it manually.", 0);
		}
	}

}

export class SyncAssetsSettingTab extends PluginSettingTab {
	private drafts: RepositoryMappingDraft[] | null = null;
	private startupCheckEnabledDraft: boolean | null = null;
	private validationMessages: string[] = [];
	private saving = false;
	private initialPickerLoadStarted = false;
	private loadingDiscovery = false;
	private loadingCatalog = false;
	private discovery: LocalDiscoveryResult | null = null;
	private catalog: CommunityPluginCatalogResult | null = null;
	private selectedPluginId = "";
	private manualRepositorySlug = "";
	private pickerError: string | null = null;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly controller: SettingsController,
		private readonly onSettingsChanged: (settings: SyncAssetsSettings) => void,
		private readonly discoverInstalledPlugins: () => Promise<LocalDiscoveryResult>,
		private readonly catalogSession: CommunityPluginCatalogSession,
		private readonly journal: PersistentRepairJournal,
	) {
		super(app, plugin);
		if (requireApiVersion("1.11.0")) {
			this.icon = "refresh-ccw-dot";
		}
		this.journal.subscribe(() => {
			if (this.containerEl.isConnected) {
				this.renderSettings();
			}
		});
	}

	getSettingDefinitions(): [] {
		return [];
	}

	display(): void {
		if (this.drafts === null) {
			this.drafts = createMappingDrafts(this.controller.getState().settings);
		}
		if (this.startupCheckEnabledDraft === null) {
			this.startupCheckEnabledDraft = this.controller.getState().settings.startupCheckEnabled;
		}
		this.renderSettings();
		if (!this.initialPickerLoadStarted) {
			this.initialPickerLoadStarted = true;
			void this.loadInitialPickerData();
		}
	}

	reloadFromController(): void {
		this.drafts = createMappingDrafts(this.controller.getState().settings);
		this.startupCheckEnabledDraft = this.controller.getState().settings.startupCheckEnabled;
		this.validationMessages = [];
		if (this.containerEl.isConnected) {
			this.renderSettings();
		}
	}

	private renderSettings(): void {
		const { containerEl } = this;
		const state = this.controller.getState();
		const drafts = this.drafts ?? [];
		containerEl.empty();
		const messages = [
			...state.issues.map(foundIssue => foundIssue.message),
			...this.validationMessages,
		];
		if (messages.length > 0) {
			const warning = containerEl.createDiv({ cls: "sync-assets-warning" });
			warning.createEl("strong", { text: "Settings change was not saved" });
			const list = warning.createEl("ul");
			for (const message of messages) {
				list.createEl("li", { text: message });
			}
		}

		new Setting(containerEl)
			.setName("Check automatically at startup")
			.setDesc("Check monitored plugins when Obsidian starts. Repair still requires confirmation.")
			.addToggle(toggle => toggle
				.setValue(this.startupCheckEnabledDraft ?? state.settings.startupCheckEnabled)
				.setDisabled(this.saving)
				.onChange(async value => {
					await this.persistSettings(this.drafts ?? [], value);
				}));

		this.renderInstalledPluginPicker(drafts);
		this.renderMappingRows(drafts);
		this.renderRepairAttention();
	}

	private renderRepairAttention(): void {
		const journal = this.journal.getSnapshot();
		if (!journal.usable) {
			const warning = this.containerEl.createDiv({ cls: "sync-assets-warning" });
			warning.createEl("strong", { text: "Repair history needs attention" });
			warning.createEl("p", { text: "Sync Assets will not change invalid repair data." });
			return;
		}
		for (const item of buildRepairHistoryPresentations(journal.records)) {
			const panel = this.containerEl.createDiv({
				cls: item.warning ? "sync-assets-warning" : "sync-assets-summary",
			});
			panel.createEl("strong", { text: this.getRepairPluginName(item.pluginId) });
			panel.createEl("p", { text: item.message });
		}
	}

	private getRepairPluginName(pluginId: string): string {
		const discovered = this.discovery?.plugins.find(candidate => (
			candidate.status === "discovered" && candidate.pluginId === pluginId
		));
		return discovered?.status === "discovered" ? discovered.manifest.name : "Repaired plugin";
	}

	private renderInstalledPluginPicker(
		drafts: readonly RepositoryMappingDraft[],
	): void {
		const { containerEl } = this;
		new Setting(containerEl)
			.setName("Plugins")
			.setHeading();

		if (this.pickerError !== null) {
			const warning = containerEl.createDiv({ cls: "sync-assets-warning" });
			warning.createEl("strong", { text: "Installed plugins could not be loaded" });
			warning.createEl("p", { text: this.pickerError });
		}
		if (this.catalog?.status === "error") {
			const warning = containerEl.createDiv({ cls: "sync-assets-warning" });
			warning.createEl("strong", { text: "Automatic repository lookup is unavailable" });
			warning.createEl("p", { text: `${this.catalog.reason.message} You can still enter owner/repo for a selected plugin.` });
			new ButtonComponent(warning)
				.setButtonText(this.loadingCatalog ? "Retrying…" : "Retry catalog")
				.setDisabled(this.loadingCatalog || this.saving)
				.onClick(async () => {
					await this.retryCatalog();
				});
		}

		if (this.loadingDiscovery || this.loadingCatalog) {
			new Setting(containerEl)
				.setName("Installed plugin")
				.setDesc("Loading plugins…")
				.addButton(button => button
					.setIcon("refresh-cw")
					.setTooltip("Refresh installed plugins")
					.setDisabled(true));
			return;
		}
		if (this.discovery === null || this.catalog === null) {
			return;
		}

		const model = buildSettingsPluginPickerModel(this.discovery, drafts, this.catalog);
		if (model.discoveryReason !== null) {
			const warning = containerEl.createDiv({ cls: "sync-assets-warning" });
			warning.createEl("strong", { text: "Local plugin discovery failed" });
			warning.createEl("p", { text: model.discoveryReason.message });
		}
		const selected = model.options.find(option => option.pluginId === this.selectedPluginId) ?? null;
		if (selected === null && this.selectedPluginId.length > 0) {
			this.selectedPluginId = "";
			this.manualRepositorySlug = "";
		}
		const picker = new Setting(containerEl)
			.setClass("sync-assets-picker-row")
			.setName("Installed plugin")
			.setDesc(model.options.length === 0
				? "All available plugins are already monitored."
				: "Choose a plugin to monitor.")
			.addDropdown(dropdown => {
				dropdown.addOption("", model.options.length === 0
					? "No plugins available"
					: "Choose an installed plugin…");
				for (const option of model.options) {
					dropdown.addOption(option.pluginId, option.label);
				}
				dropdown
					.setValue(selected?.pluginId ?? "")
					.setDisabled(model.options.length === 0 || this.saving)
					.onChange(value => {
						this.selectedPluginId = value;
						this.manualRepositorySlug = "";
						this.validationMessages = [];
						this.renderSettings();
					});
			})
			.addButton(button => button
				.setIcon("refresh-cw")
				.setTooltip("Refresh installed plugins")
				.setDisabled(this.loadingDiscovery || this.saving)
				.onClick(async () => {
					await this.refreshInstalledPlugins();
				}));

		if (selected !== null && selected.repositorySlug !== null) {
			picker.addButton(button => button
				.setButtonText("Add")
				.setCta()
				.setDisabled(this.saving)
				.onClick(async () => {
					await this.addSelectedPlugin(selected);
				}));
		} else if (selected !== null) {
			this.renderManualRepositoryFallback(selected);
		}
	}

	private renderManualRepositoryFallback(option: InstalledPluginOption): void {
		const setting = new Setting(this.containerEl)
			.setClass("sync-assets-mapping-row")
			.setName(option.pluginName)
			.setDesc("Not found in the official catalog. Enter the GitHub repository as owner/repository.")
			.addText(text => text
				.setPlaceholder("Owner/repository")
				.setValue(this.manualRepositorySlug)
				.onChange(value => {
					this.manualRepositorySlug = value;
					this.validationMessages = [];
				}));
		setting.addButton(button => button
			.setButtonText("Add")
			.setCta()
			.setDisabled(this.saving)
			.onClick(async () => {
				await this.addSelectedPlugin(option);
			}));
	}

	private renderMappingRows(
		drafts: readonly RepositoryMappingDraft[],
	): void {
		new Setting(this.containerEl)
			.setName("Monitored plugins")
			.setHeading();
		if (drafts.length === 0) {
			this.containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "No plugins are monitored.",
			});
			return;
		}
		const mappings = this.discovery !== null && this.catalog !== null
			? buildSettingsPluginPickerModel(this.discovery, drafts, this.catalog).mappings
			: drafts.map(draft => ({
				pluginId: draft.pluginId,
				pluginName: draft.pluginId,
				version: null,
				repositorySlug: draft.repositorySlug,
				installed: false,
			}));
		for (const [index, mapping] of mappings.entries()) {
			const row = new Setting(this.containerEl)
				.setClass("sync-assets-mapping-row")
				.setName(mapping.pluginName);
			if (!mapping.installed) {
				row.setDesc("Not installed");
			}
			row
				.addButton(button => button
					.setButtonText("Remove")
					.setClass("sync-assets-remove-button")
					.setDisabled(this.saving)
					.onClick(async () => {
						const nextDrafts = (this.drafts ?? []).filter((_, draftIndex) => draftIndex !== index);
						await this.persistSettings(
							nextDrafts,
							this.startupCheckEnabledDraft ?? this.controller.getState().settings.startupCheckEnabled,
						);
					}));
		}
	}

	private async addSelectedPlugin(option: InstalledPluginOption): Promise<void> {
		const result = createMappingDraftForOption(option, this.manualRepositorySlug);
		if (!result.ok) {
			this.validationMessages = result.issues.map(foundIssue => foundIssue.message);
			this.renderSettings();
			return;
		}
		const saved = await this.persistSettings(
			[...(this.drafts ?? []), result.draft],
			this.startupCheckEnabledDraft ?? this.controller.getState().settings.startupCheckEnabled,
		);
		if (saved) {
			this.selectedPluginId = "";
			this.manualRepositorySlug = "";
			this.renderSettings();
		}
	}

	private async loadInitialPickerData(): Promise<void> {
		this.loadingDiscovery = true;
		this.loadingCatalog = true;
		this.pickerError = null;
		this.renderSettings();
		const [discovery, catalog] = await Promise.all([
			this.discoverInstalledPlugins().catch(error => {
				this.pickerError = error instanceof Error ? error.message : "Unknown local discovery error.";
				return null;
			}),
			this.catalogSession.load(),
		]);
		this.discovery = discovery;
		this.catalog = catalog;
		this.loadingDiscovery = false;
		this.loadingCatalog = false;
		if (this.containerEl.isConnected) {
			this.renderSettings();
		}
	}

	private async refreshInstalledPlugins(): Promise<void> {
		if (this.loadingDiscovery) {
			return;
		}
		this.loadingDiscovery = true;
		this.pickerError = null;
		this.renderSettings();
		try {
			this.discovery = await this.discoverInstalledPlugins();
		} catch (error) {
			this.discovery = null;
			this.pickerError = error instanceof Error ? error.message : "Unknown local discovery error.";
		} finally {
			this.loadingDiscovery = false;
			this.renderSettings();
		}
	}

	private async retryCatalog(): Promise<void> {
		if (this.loadingCatalog) {
			return;
		}
		this.loadingCatalog = true;
		this.renderSettings();
		this.catalog = await this.catalogSession.retry();
		this.loadingCatalog = false;
		this.renderSettings();
	}

	private async persistSettings(
		nextDrafts: readonly RepositoryMappingDraft[],
		nextStartupCheckEnabled: boolean,
	): Promise<boolean> {
		if (this.saving) {
			return false;
		}
		this.saving = true;
		this.drafts = [...nextDrafts];
		this.startupCheckEnabledDraft = nextStartupCheckEnabled;
		this.validationMessages = [];
		this.renderSettings();
		const result = await this.controller.saveDrafts(
			nextDrafts,
			nextStartupCheckEnabled,
		);
		this.saving = false;
		if (!result.ok) {
			this.validationMessages = result.issues.map(foundIssue => (
				`${foundIssue.path.length > 0 ? `${foundIssue.path}: ` : ""}${foundIssue.message}`
			));
			const reloaded = await this.controller.load();
			this.drafts = createMappingDrafts(reloaded.settings);
			this.startupCheckEnabledDraft = reloaded.settings.startupCheckEnabled;
			this.renderSettings();
			return false;
		}

		this.drafts = createMappingDrafts(result.state.settings);
		this.startupCheckEnabledDraft = result.state.settings.startupCheckEnabled;
		this.onSettingsChanged(result.state.settings);
		this.renderSettings();
		return true;
	}
}
