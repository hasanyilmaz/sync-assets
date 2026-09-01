import {
	Notice,
	normalizePath,
	Plugin,
	requestUrl,
} from "obsidian";

import {
	IntegrityCheckCoordinator,
	type IntegrityCheckRun,
} from "./src/check-coordinator";
import { CommunityPluginCatalogSession } from "./src/community-catalog";
import {
	type IntegrityVerificationBatch,
	verifyPluginIntegrity,
} from "./src/integrity-verification";
import {
	discoverLocalPlugins,
	type LocalDiscoveryResult,
} from "./src/local-discovery";
import { probeMonitoredLocalAssets } from "./src/local-follow-up-probe";
import {
	createRemoteHttpClient,
	executeObsidianAppReload,
} from "./src/obsidian-bridge";
import { readInstalledPluginDisplayName } from "./src/plugin-display-name";
import { InlineRepairApprovalProvider } from "./src/repair-approval";
import {
	IntegrityResultsModal,
	SyncAssetsSettingTab,
} from "./src/plugin-ui";
import {
	PersistentDataController,
	type PersistedRepairRecord,
} from "./src/persisted-state";
import {
	createSessionId,
	PersistentRepairJournal,
	recordAllPostRestartHealthyProofs,
} from "./src/repair-lifecycle";
import { RepairTransactionEngine } from "./src/repair-transaction";
import { RepairUiCoordinator } from "./src/repair-ui-coordinator";
import {
	type RemoteResolutionBatch,
	resolveRemoteReleases,
} from "./src/remote-release";
import {
	SettingsController,
	type SettingsState,
} from "./src/settings-controller";
import {
	createDefaultSettings,
	type SyncAssetsSettings,
} from "./src/settings";
import {
	buildStartupAttentionSummary,
	StartupCheckController,
} from "./src/startup-check";
import { StartupLocalFollowUpController } from "./src/startup-local-follow-up";

/**
 * Sync Assets plugin entry point.
 *
 * Stage 9 adds a settings-only installed-plugin picker backed by the official
 * Obsidian community catalog. Opening settings may perform local read-only
 * discovery and one catalog request, but never starts an integrity check,
 * repair, cleanup, reload, or restart behavior.
 */
export default class SyncAssetsPlugin extends Plugin {
	settings: SyncAssetsSettings = createDefaultSettings();

	private settingsController: SettingsController | null = null;
	private coordinator: IntegrityCheckCoordinator | null = null;
	private resultsModal: IntegrityResultsModal | null = null;
	private settingTab: SyncAssetsSettingTab | null = null;
	private repairCoordinator: RepairUiCoordinator | null = null;
	private approvalProvider: InlineRepairApprovalProvider | null = null;
	private journal: PersistentRepairJournal | null = null;
	private startupController: StartupCheckController | null = null;
	private startupFollowUpController: StartupLocalFollowUpController | null = null;
	private loaded = false;
	private readonly sessionId = createSessionId();

	async onload(): Promise<void> {
		const persistence = new PersistentDataController({
			load: (): Promise<unknown> => this.loadData() as Promise<unknown>,
			save: (data): Promise<void> => this.saveData(data),
		});
		this.settingsController = new SettingsController(persistence);
		const settingsState = await this.settingsController.load();
		const startupSettingsState = this.settingsController.getState();
		this.settings = settingsState.settings;
		if (settingsState.issues.length > 0) {
			new Notice("Sync Assets settings are invalid. Safe defaults are active; open the plugin settings for details.", 0);
		}

		const http = createRemoteHttpClient(request => requestUrl(request));
		const discover = (settings: SyncAssetsSettings): Promise<LocalDiscoveryResult> => discoverLocalPlugins(settings, {
			adapter: this.app.vault.adapter,
			configDir: this.app.vault.configDir,
			ownPluginId: this.manifest.id,
			normalizePath,
		});
		this.coordinator = new IntegrityCheckCoordinator({
			discover,
			resolve: (discovery: LocalDiscoveryResult): Promise<RemoteResolutionBatch> => resolveRemoteReleases(discovery, { http }),
			verify: (
				discovery: LocalDiscoveryResult,
				remote: RemoteResolutionBatch,
			): Promise<IntegrityVerificationBatch> => verifyPluginIntegrity(
				discovery,
				remote,
				{ adapter: this.app.vault.adapter },
			),
		});
		this.startupController = new StartupCheckController(
			this.coordinator,
			() => startupSettingsState,
		);
		this.startupFollowUpController = new StartupLocalFollowUpController({
			getSettingsState: (): SettingsState => this.settingsController?.getState() ?? startupSettingsState,
			probe: (): Promise<string | null> => probeMonitoredLocalAssets(
				(this.settingsController?.getState() ?? startupSettingsState).settings,
				{
					adapter: this.app.vault.adapter,
					configDir: this.app.vault.configDir,
					normalizePath,
				},
			),
			isBusy: (): boolean => (
				this.coordinator?.getSnapshot().activeRunId !== null
				|| this.repairCoordinator?.isBusy() === true
			),
			runFullCheck: (): Promise<IntegrityCheckRun | null> => this.runStartupFollowUpCheck(),
			schedule: (callback, delayMs): (() => void) => {
				const timeoutId = window.setTimeout(callback, delayMs);
				return (): void => window.clearTimeout(timeoutId);
			},
		});
		this.journal = new PersistentRepairJournal(persistence, this.sessionId);
		this.approvalProvider = new InlineRepairApprovalProvider();
		const repairEngine = new RepairTransactionEngine({
			adapter: this.app.vault.adapter,
			http,
			journal: this.journal,
			approval: this.approvalProvider,
			ownPluginId: this.manifest.id,
			normalizePath,
		});
		this.repairCoordinator = new RepairUiCoordinator(
			repairEngine,
			this.journal,
			this.app.vault.adapter,
			normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/.repair`),
			() => this.coordinator?.getSnapshot().activeRunId !== null,
		);
		this.resultsModal = new IntegrityResultsModal(
			this.app,
			this.coordinator,
			() => this.runManualCheck(),
			this.repairCoordinator,
			this.journal,
			this.approvalProvider,
			() => executeObsidianAppReload(this.app),
		);
		const catalogSession = new CommunityPluginCatalogSession(http);
		this.settingTab = new SyncAssetsSettingTab(
			this.app,
			this,
			this.settingsController,
			settings => {
				this.settings = settings;
			},
			() => discover(this.settingsController?.getState().settings ?? createDefaultSettings()),
			catalogSession,
			this.journal,
		);
		this.addSettingTab(this.settingTab);
		this.addCommand({
			id: "check-plugin-integrity",
			name: "Check plugin integrity",
			callback: () => {
				this.resultsModal?.open();
				void this.runManualCheck();
			},
		});
		const journalSnapshot = this.journal.getSnapshot();
		if (!journalSnapshot.usable) {
			new Notice("Sync Assets repair journal is invalid. Repair and backup cleanup are locked; no automatic recovery was attempted.", 0);
		} else if (
			journalSnapshot.blockingRecord !== null
			&& !this.isAwaitingPostRestartVerification(journalSnapshot.blockingRecord)
		) {
			const pluginName = await this.getPluginDisplayName(
				journalSnapshot.blockingRecord.receipt.pluginId,
			);
			new Notice(`Sync Assets operation for ${pluginName} requires manual attention. No automatic recovery was attempted.`, 0);
		}
		this.loaded = true;
		this.app.workspace.onLayoutReady(() => {
			if (this.loaded) {
				this.startupFollowUpController?.start();
				void this.runStartupCheck();
			}
		});
	}

	onunload(): void {
		this.loaded = false;
		this.startupFollowUpController?.stop();
		this.resultsModal?.close();
	}

	async onExternalSettingsChange(): Promise<void> {
		if (this.settingsController === null) {
			return;
		}
		const state = await this.settingsController.load();
		this.settings = state.settings;
		this.settingTab?.reloadFromController();
		if (state.issues.length > 0) {
			new Notice("Sync Assets settings are invalid. Safe defaults are active; open the plugin settings for details.", 0);
		}
	}

	private async runManualCheck(): Promise<unknown> {
		this.startupController?.markManualIntent();
		if (this.settingsController === null || this.coordinator === null) {
			return;
		}
		if (this.repairCoordinator?.isBusy() === true) {
			new Notice("Wait for the active repair or backup cleanup operation to finish.");
			return;
		}
		const state = this.settingsController.getState();
		const run = await this.coordinator.run(state.settings, state.issues, "manual");
		await this.reconcilePostRestartEvidence(run, true);
		await this.removeVerifiedSuccessfulRepairs();
		return run;
	}

	private async runStartupCheck(): Promise<void> {
		if (this.startupController === null) {
			return;
		}
		const outcome = await this.startupController.runAfterLayoutReady();
		if (!this.loaded) {
			return;
		}
		if (outcome.status === "skipped") {
			await this.removeVerifiedSuccessfulRepairs();
			return;
		}
		await this.handleAutomaticRun(outcome.run);
	}

	private async runStartupFollowUpCheck(): Promise<IntegrityCheckRun | null> {
		if (
			!this.loaded
			|| this.settingsController === null
			|| this.coordinator === null
			|| this.repairCoordinator?.isBusy() === true
			|| this.coordinator.getSnapshot().activeRunId !== null
		) {
			return null;
		}
		const state = this.settingsController.getState();
		if (
			state.issues.length > 0
			|| !state.settings.startupCheckEnabled
			|| state.settings.repositories.length === 0
		) {
			return null;
		}
		const run = await this.coordinator.run(state.settings, state.issues, "startup");
		await this.handleAutomaticRun(run);
		return run;
	}

	private async handleAutomaticRun(run: IntegrityCheckRun): Promise<void> {
		await this.reconcilePostRestartEvidence(run, false);
		await this.removeVerifiedSuccessfulRepairs();
		const summary = buildStartupAttentionSummary(run);
		if (summary === null) {
			return;
		}
		this.resultsModal?.open();
	}

	private async reconcilePostRestartEvidence(
		run: IntegrityCheckRun,
		announceSuccess: boolean,
	): Promise<void> {
		if (this.journal === null) {
			return;
		}
		const attempts = await recordAllPostRestartHealthyProofs(
			this.journal,
			run,
			this.sessionId,
		);
		for (const attempt of attempts) {
			if (attempt.result.status !== "recorded" && attempt.result.status !== "persistence-error") {
				continue;
			}
			const pluginName = await this.getPluginDisplayName(attempt.pluginId);
			if (attempt.result.status === "recorded" && announceSuccess) {
				new Notice(`${pluginName} passed the restart check.`);
			} else if (attempt.result.status === "persistence-error") {
				new Notice(`Sync Assets could not save post-restart verification for ${pluginName}: ${attempt.result.reason?.message ?? "unknown error"}`, 0);
			}
		}
	}

	private async removeVerifiedSuccessfulRepairs(): Promise<void> {
		if (
			this.journal === null
			|| this.repairCoordinator === null
		) {
			return;
		}
		const records = this.journal.getSnapshot().records.filter(record => (
			record.receipt.phase === "committed"
			&& record.healthyProof !== null
			&& ["none", "cleanup-eligible", "deleted"].includes(record.backupCleanup.status)
		));
		for (const record of records) {
			const result = await this.repairCoordinator.cleanup(record.receipt.transactionId, true);
			if (result.status === "blocked" || result.status === "needs-attention") {
				const pluginName = await this.getPluginDisplayName(record.receipt.pluginId);
				new Notice(`Sync Assets could not remove the successful repair for ${pluginName}: ${result.reason.message}`, 0);
				return;
			}
		}
	}

	private isAwaitingPostRestartVerification(record: PersistedRepairRecord): boolean {
		return record.receipt.phase === "committed" && record.healthyProof === null;
	}

	private async getPluginDisplayName(pluginId: string): Promise<string> {
		return await readInstalledPluginDisplayName(pluginId, {
			adapter: this.app.vault.adapter,
			configDir: this.app.vault.configDir,
			normalizePath,
		}) ?? "the repaired plugin";
	}
}
