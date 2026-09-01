import {
	type IntegrityReason,
	type ReleaseAssetName,
} from "./domain";
import type {
	RepairJournalPhase,
	RepairOriginalGuard,
	RepairReceipt,
	RepairReceiptArtifact,
} from "./repair-transaction";
import {
	buildReleaseTagCandidates,
	isReleaseAssetName,
	type ValidationIssue,
	validateGitHubRepository,
	validatePluginId,
} from "./security";
import {
	createDefaultSettings,
	parseSettings,
	type SyncAssetsSettings,
} from "./settings";

export const PERSISTED_SCHEMA_VERSION = 2 as const;

export const BACKUP_CLEANUP_STATUSES = [
	"none",
	"retained",
	"cleanup-eligible",
	"deleting",
	"deleted",
	"needs-attention",
] as const;

export type BackupCleanupStatus = (typeof BACKUP_CLEANUP_STATUSES)[number];

export interface PostRestartHealthyProof {
	readonly sessionId: string;
	readonly runId: number;
	readonly verifiedAtMs: number;
	readonly releaseId: number;
	readonly releaseTag: string;
}

export interface BackupCleanupState {
	readonly status: BackupCleanupStatus;
	readonly deletedAssetNames: readonly ReleaseAssetName[];
	readonly reason: IntegrityReason | null;
}

export interface PersistedRepairRecord {
	readonly receipt: RepairReceipt;
	readonly originSessionId: string;
	readonly healthyProof: PostRestartHealthyProof | null;
	readonly backupCleanup: BackupCleanupState;
}

export interface SyncAssetsPersistedData extends SyncAssetsSettings {
	readonly schemaVersion: typeof PERSISTED_SCHEMA_VERSION;
	readonly revision: number;
	readonly repairRecords: readonly PersistedRepairRecord[];
}

export interface PersistedDataParseResult {
	readonly data: SyncAssetsPersistedData;
	readonly issues: readonly ValidationIssue[];
	readonly usedDefaults: boolean;
	readonly migrationNeeded: boolean;
	readonly journalUsable: boolean;
}

export interface PersistedDataStorage {
	readonly load: () => Promise<unknown>;
	readonly save: (data: SyncAssetsPersistedData) => Promise<void>;
}

export type PersistedMutationResult =
	| { readonly ok: true; readonly data: SyncAssetsPersistedData }
	| { readonly ok: false; readonly issue: ValidationIssue };

const V1_KEYS = new Set(["schemaVersion", "startupCheckEnabled", "repositories"]);
const V2_KEYS = new Set([
	"schemaVersion",
	"revision",
	"startupCheckEnabled",
	"autoDeleteVerifiedBackups",
	"repositories",
	"repairRecords",
]);
const RECORD_KEYS = new Set(["receipt", "originSessionId", "healthyProof", "backupCleanup"]);
const PROOF_KEYS = new Set(["sessionId", "runId", "verifiedAtMs", "releaseId", "releaseTag"]);
const CLEANUP_KEYS = new Set(["status", "deletedAssetNames", "reason"]);
const REASON_KEYS = new Set(["code", "message"]);
const RECEIPT_KEYS = new Set([
	"transactionId", "planFingerprint", "runId", "pluginId", "repository",
	"manifestVersion", "releaseId", "releaseTag", "phase", "startedAtMs",
	"updatedAtMs", "finishedAtMs", "restartRequired", "artifacts",
	"completedSteps", "reason",
]);
const RECEIPT_ARTIFACT_KEYS = new Set([
	"assetName", "targetPath", "stagedPath", "backupPath", "expected",
	"original", "state", "backupRetained",
]);
const FINGERPRINT_KEYS = new Set(["sizeBytes", "sha256"]);
const PRESENT_GUARD_KEYS = new Set(["exists", "sizeBytes", "mtimeMs", "sha256"]);
const MISSING_GUARD_KEYS = new Set(["exists"]);
const RECEIPT_PHASES = new Set<RepairJournalPhase>([
	"planned", "authorized", "staged", "applying", "committed",
	"rolling-back", "rolled-back", "needs-attention",
]);
const ARTIFACT_STATES = new Set<RepairReceiptArtifact["state"]>([
	"pending", "staged", "backup-moved", "installed", "verified",
	"rolled-back", "needs-attention",
]);
const CLEANUP_STATUSES = new Set<BackupCleanupStatus>(BACKUP_CLEANUP_STATUSES);
const SESSION_ID_PATTERN = /^session-[0-9a-f]{32}$/;
const TRANSACTION_ID_PATTERN = /^repair-[0-9a-f]{32}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, path: string, message: string): ValidationIssue {
	return { code, path, message };
}

function unknownKeyIssues(
	value: Record<string, unknown>,
	keys: ReadonlySet<string>,
	path: string,
): ValidationIssue[] {
	return Object.keys(value)
		.filter(key => !keys.has(key))
		.map(key => issue(
			"unknown-persisted-field",
			path.length === 0 ? key : `${path}.${key}`,
			"Unknown persisted fields are rejected.",
		));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function parseReason(value: unknown, path: string, issues: ValidationIssue[]): IntegrityReason | null {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		issues.push(issue("invalid-repair-reason", path, "Repair reason must be null or a structured object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, REASON_KEYS, path));
	if (typeof value.code !== "string" || value.code.length === 0 || typeof value.message !== "string" || value.message.length === 0) {
		issues.push(issue("invalid-repair-reason", path, "Repair reason requires non-empty code and message strings."));
		return null;
	}
	return { code: value.code, message: value.message };
}

function parseGuard(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): RepairOriginalGuard | null {
	if (value === null) {
		return null;
	}
	if (!isRecord(value) || typeof value.exists !== "boolean") {
		issues.push(issue("invalid-repair-original", path, "Repair original guard is invalid."));
		return null;
	}
	if (!value.exists) {
		issues.push(...unknownKeyIssues(value, MISSING_GUARD_KEYS, path));
		return { exists: false };
	}
	issues.push(...unknownKeyIssues(value, PRESENT_GUARD_KEYS, path));
	if (
		!isSafeInteger(value.sizeBytes)
		|| !isSafeInteger(value.mtimeMs)
		|| typeof value.sha256 !== "string"
		|| !SHA256_PATTERN.test(value.sha256)
	) {
		issues.push(issue("invalid-repair-original", path, "Present repair original requires safe size, mtime, and SHA-256 evidence."));
		return null;
	}
	return {
		exists: true,
		sizeBytes: value.sizeBytes,
		mtimeMs: value.mtimeMs,
		sha256: value.sha256,
	};
}

function exactPathSuffix(path: string, suffix: string): boolean {
	const segments = path.split("/");
	return path.length > 0
		&& !path.includes("\\")
		&& !path.includes("//")
		&& segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..")
		&& (path === suffix || path.endsWith(`/${suffix}`));
}

function parseReceiptArtifact(
	value: unknown,
	path: string,
	receiptIdentity: { transactionId: string; pluginId: string },
	issues: ValidationIssue[],
): RepairReceiptArtifact | null {
	if (!isRecord(value)) {
		issues.push(issue("invalid-repair-artifact", path, "Repair artifact must be an object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, RECEIPT_ARTIFACT_KEYS, path));
	if (typeof value.assetName !== "string" || !isReleaseAssetName(value.assetName)) {
		issues.push(issue("invalid-repair-asset-name", `${path}.assetName`, "Repair artifact must be allowlisted."));
		return null;
	}
	const assetName = value.assetName;
	if (
		typeof value.targetPath !== "string"
		|| !exactPathSuffix(value.targetPath, `plugins/${receiptIdentity.pluginId}/${assetName}`)
		|| typeof value.stagedPath !== "string"
		|| !exactPathSuffix(value.stagedPath, `plugins/sync-assets/.repair/${receiptIdentity.transactionId}/staged/${assetName}`)
		|| typeof value.backupPath !== "string"
		|| !exactPathSuffix(value.backupPath, `plugins/sync-assets/.repair/${receiptIdentity.transactionId}/backup/${assetName}`)
	) {
		issues.push(issue("unsafe-repair-path", path, "Repair artifact paths do not match their exact trusted locations."));
		return null;
	}
	if (!isRecord(value.expected)) {
		issues.push(issue("invalid-repair-fingerprint", `${path}.expected`, "Expected repair fingerprint is invalid."));
		return null;
	}
	issues.push(...unknownKeyIssues(value.expected, FINGERPRINT_KEYS, `${path}.expected`));
	if (!isSafeInteger(value.expected.sizeBytes) || typeof value.expected.sha256 !== "string" || !SHA256_PATTERN.test(value.expected.sha256)) {
		issues.push(issue("invalid-repair-fingerprint", `${path}.expected`, "Expected repair fingerprint requires safe size and SHA-256."));
		return null;
	}
	if (typeof value.state !== "string" || !ARTIFACT_STATES.has(value.state as RepairReceiptArtifact["state"]) || typeof value.backupRetained !== "boolean") {
		issues.push(issue("invalid-repair-artifact-state", path, "Repair artifact state is invalid."));
		return null;
	}
	const original = parseGuard(value.original, `${path}.original`, issues);
	return {
		assetName,
		targetPath: value.targetPath,
		stagedPath: value.stagedPath,
		backupPath: value.backupPath,
		expected: { sizeBytes: value.expected.sizeBytes, sha256: value.expected.sha256 },
		original,
		state: value.state as RepairReceiptArtifact["state"],
		backupRetained: value.backupRetained,
	};
}

function parseReceipt(value: unknown, path: string, issues: ValidationIssue[]): RepairReceipt | null {
	if (!isRecord(value)) {
		issues.push(issue("invalid-repair-receipt", path, "Repair receipt must be an object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, RECEIPT_KEYS, path));
	const plugin = validatePluginId(value.pluginId, `${path}.pluginId`);
	const repository = isRecord(value.repository)
		? validateGitHubRepository(value.repository.owner, value.repository.repo, `${path}.repository`)
		: null;
	if (!plugin.ok) {
		issues.push(...plugin.issues);
	}
	if (repository === null) {
		issues.push(issue("invalid-github-repository", `${path}.repository`, "Repair receipt repository is invalid."));
	} else if (!repository.ok) {
		issues.push(...repository.issues);
	}
	const version = buildReleaseTagCandidates(value.manifestVersion, `${path}.manifestVersion`);
	if (!version.ok) {
		issues.push(...version.issues);
	}
	if (
		typeof value.transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(value.transactionId)
		|| typeof value.planFingerprint !== "string" || value.planFingerprint.length === 0
		|| !isSafeInteger(value.runId, 1)
		|| !isSafeInteger(value.releaseId, 1)
		|| typeof value.releaseTag !== "string"
		|| typeof value.phase !== "string" || !RECEIPT_PHASES.has(value.phase as RepairJournalPhase)
		|| !isSafeInteger(value.startedAtMs)
		|| !isSafeInteger(value.updatedAtMs)
		|| !(value.finishedAtMs === null || isSafeInteger(value.finishedAtMs))
		|| value.restartRequired !== true
		|| !Array.isArray(value.completedSteps)
		|| value.completedSteps.some(step => typeof step !== "string")
		|| !Array.isArray(value.artifacts)
		|| value.artifacts.length === 0
	) {
		issues.push(issue("invalid-repair-receipt", path, "Repair receipt identity, phase, timestamps, or steps are invalid."));
		return null;
	}
	if (!plugin.ok || repository === null || !repository.ok || !version.ok) {
		return null;
	}
	if (value.releaseTag !== version.value[0] && value.releaseTag !== version.value[1]) {
		issues.push(issue("invalid-repair-release-tag", `${path}.releaseTag`, "Repair release tag must exactly match the manifest version policy."));
		return null;
	}
	const artifacts: RepairReceiptArtifact[] = [];
	const names = new Set<ReleaseAssetName>();
	for (const [index, rawArtifact] of value.artifacts.entries()) {
		const artifact = parseReceiptArtifact(rawArtifact, `${path}.artifacts[${index}]`, {
			transactionId: value.transactionId,
			pluginId: plugin.value,
		}, issues);
		if (artifact === null) {
			continue;
		}
		if (names.has(artifact.assetName)) {
			issues.push(issue("duplicate-repair-artifact", `${path}.artifacts[${index}]`, "Repair receipt artifact names must be unique."));
			continue;
		}
		names.add(artifact.assetName);
		artifacts.push(artifact);
	}
	const parsedReason = parseReason(value.reason, `${path}.reason`, issues);
	if (
		value.phase === "committed"
		&& (
			value.finishedAtMs === null
			|| parsedReason !== null
			|| artifacts.some(artifact => artifact.state !== "verified")
		)
	) {
		issues.push(issue("invalid-committed-receipt", path, "Committed receipt must be finished, successful, and fully verified."));
	}
	if (
		["planned", "authorized", "staged", "applying", "rolling-back"].includes(value.phase)
		&& value.finishedAtMs !== null
	) {
		issues.push(issue("invalid-active-receipt", path, "An active receipt cannot have a finished timestamp."));
	}
	if (["rolled-back", "needs-attention"].includes(value.phase) && (value.finishedAtMs === null || parsedReason === null)) {
		issues.push(issue("invalid-terminal-receipt", path, "Rolled-back or needs-attention receipt requires a finish time and structured reason."));
	}
	return {
		transactionId: value.transactionId,
		planFingerprint: value.planFingerprint,
		runId: value.runId,
		pluginId: plugin.value,
		repository: repository.value,
		manifestVersion: version.value[0],
		releaseId: value.releaseId,
		releaseTag: value.releaseTag,
		phase: value.phase as RepairJournalPhase,
		startedAtMs: value.startedAtMs,
		updatedAtMs: value.updatedAtMs,
		finishedAtMs: value.finishedAtMs,
		restartRequired: true,
		artifacts,
		completedSteps: value.completedSteps.filter((step): step is string => typeof step === "string"),
		reason: parsedReason,
	};
}

function parseHealthyProof(
	value: unknown,
	path: string,
	receipt: RepairReceipt,
	issues: ValidationIssue[],
): PostRestartHealthyProof | null {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		issues.push(issue("invalid-healthy-proof", path, "Post-restart healthy proof must be null or an object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, PROOF_KEYS, path));
	if (
		typeof value.sessionId !== "string" || !SESSION_ID_PATTERN.test(value.sessionId)
		|| !isSafeInteger(value.runId, 1)
		|| !isSafeInteger(value.verifiedAtMs)
		|| value.releaseId !== receipt.releaseId
		|| value.releaseTag !== receipt.releaseTag
	) {
		issues.push(issue("invalid-healthy-proof", path, "Post-restart healthy proof does not match the committed release."));
		return null;
	}
	return {
		sessionId: value.sessionId,
		runId: value.runId,
		verifiedAtMs: value.verifiedAtMs,
		releaseId: value.releaseId,
		releaseTag: value.releaseTag,
	};
}

function parseCleanup(
	value: unknown,
	path: string,
	receipt: RepairReceipt,
	issues: ValidationIssue[],
): BackupCleanupState | null {
	if (!isRecord(value)) {
		issues.push(issue("invalid-backup-cleanup", path, "Backup cleanup state must be an object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, CLEANUP_KEYS, path));
	if (typeof value.status !== "string" || !CLEANUP_STATUSES.has(value.status as BackupCleanupStatus) || !Array.isArray(value.deletedAssetNames)) {
		issues.push(issue("invalid-backup-cleanup", path, "Backup cleanup status or deleted artifacts are invalid."));
		return null;
	}
	const deleted: ReleaseAssetName[] = [];
	for (const assetName of value.deletedAssetNames) {
		if (typeof assetName !== "string" || !isReleaseAssetName(assetName) || deleted.includes(assetName)) {
			issues.push(issue("invalid-backup-cleanup", `${path}.deletedAssetNames`, "Deleted backup artifact names must be unique and allowlisted."));
			continue;
		}
		if (!receipt.artifacts.some(artifact => artifact.assetName === assetName && artifact.backupRetained)) {
			issues.push(issue("invalid-backup-cleanup", `${path}.deletedAssetNames`, "Deleted backup must belong to the receipt and have been retained."));
			continue;
		}
		deleted.push(assetName);
	}
	return {
		status: value.status as BackupCleanupStatus,
		deletedAssetNames: deleted,
		reason: parseReason(value.reason, `${path}.reason`, issues),
	};
}

function parseRecord(value: unknown, path: string, issues: ValidationIssue[]): PersistedRepairRecord | null {
	if (!isRecord(value)) {
		issues.push(issue("invalid-repair-record", path, "Repair record must be an object."));
		return null;
	}
	issues.push(...unknownKeyIssues(value, RECORD_KEYS, path));
	const receipt = parseReceipt(value.receipt, `${path}.receipt`, issues);
	if (receipt === null || typeof value.originSessionId !== "string" || !SESSION_ID_PATTERN.test(value.originSessionId)) {
		issues.push(issue("invalid-repair-record", path, "Repair record identity or origin session is invalid."));
		return null;
	}
	const healthyProof = parseHealthyProof(value.healthyProof, `${path}.healthyProof`, receipt, issues);
	if (healthyProof !== null && healthyProof.sessionId === value.originSessionId) {
		issues.push(issue("same-session-healthy-proof", `${path}.healthyProof.sessionId`, "Healthy proof must come from a later plugin session."));
	}
	const backupCleanup = parseCleanup(value.backupCleanup, `${path}.backupCleanup`, receipt, issues);
	if (backupCleanup === null) {
		return null;
	}
	const retainedBackups = receipt.artifacts.filter(artifact => artifact.backupRetained);
	if (healthyProof !== null && receipt.phase !== "committed") {
		issues.push(issue("invalid-healthy-proof-phase", `${path}.healthyProof`, "Post-restart healthy proof is valid only for a committed receipt."));
	}
	if (
		["cleanup-eligible", "deleting", "deleted"].includes(backupCleanup.status)
		&& (receipt.phase !== "committed" || healthyProof === null || retainedBackups.length === 0)
	) {
		issues.push(issue("invalid-backup-cleanup-phase", `${path}.backupCleanup`, "Backup cleanup requires a committed receipt, healthy proof, and retained backups."));
	}
	if (backupCleanup.status === "retained" && (receipt.phase !== "committed" || healthyProof !== null || retainedBackups.length === 0)) {
		issues.push(issue("invalid-backup-retention", `${path}.backupCleanup`, "Retained backups must await post-restart proof for a committed receipt."));
	}
	if (
		backupCleanup.status === "deleted"
		&& (
			backupCleanup.deletedAssetNames.length !== retainedBackups.length
			|| retainedBackups.some(artifact => !backupCleanup.deletedAssetNames.includes(artifact.assetName))
		)
	) {
		issues.push(issue("incomplete-backup-cleanup", `${path}.backupCleanup.deletedAssetNames`, "Deleted cleanup state must account for every retained backup."));
	}
	return { receipt, originSessionId: value.originSessionId, healthyProof, backupCleanup };
}

function defaultData(): SyncAssetsPersistedData {
	return { ...createDefaultSettings(), revision: 0, repairRecords: [] };
}

export function createDefaultPersistedData(): SyncAssetsPersistedData {
	return clonePersistedData(defaultData());
}

export function parsePersistedData(raw: unknown): PersistedDataParseResult {
	if (isRecord(raw) && raw.schemaVersion === 1) {
		const unknown = unknownKeyIssues(raw, V1_KEYS, "");
		const parsed = parseSettings({ ...raw, schemaVersion: 2 });
		const issues = [...unknown, ...parsed.issues];
		return issues.length === 0
			? {
				data: { ...parsed.settings, revision: 0, repairRecords: [] },
				issues: [], usedDefaults: false, migrationNeeded: true, journalUsable: true,
			}
			: { data: defaultData(), issues, usedDefaults: true, migrationNeeded: false, journalUsable: false };
	}
	if (!isRecord(raw) || raw.schemaVersion !== PERSISTED_SCHEMA_VERSION) {
		return {
			data: defaultData(),
			issues: [issue("unsupported-settings-schema", "schemaVersion", "Persisted data must use schema 1 or 2.")],
			usedDefaults: true,
			migrationNeeded: false,
			journalUsable: false,
		};
	}
	const issues = unknownKeyIssues(raw, V2_KEYS, "");
	const settings = parseSettings({
		schemaVersion: raw.schemaVersion,
		startupCheckEnabled: raw.startupCheckEnabled,
		autoDeleteVerifiedBackups: raw.autoDeleteVerifiedBackups,
		repositories: raw.repositories,
	});
	issues.push(...settings.issues);
	if (!isSafeInteger(raw.revision)) {
		issues.push(issue("invalid-persisted-revision", "revision", "Persisted revision must be a non-negative safe integer."));
	}
	if (!Array.isArray(raw.repairRecords)) {
		issues.push(issue("invalid-repair-records", "repairRecords", "Repair records must be an array."));
	}
	const records: PersistedRepairRecord[] = [];
	const transactions = new Set<string>();
	if (Array.isArray(raw.repairRecords)) {
		for (const [index, candidate] of raw.repairRecords.entries()) {
			const record = parseRecord(candidate, `repairRecords[${index}]`, issues);
			if (record === null) {
				continue;
			}
			if (transactions.has(record.receipt.transactionId)) {
				issues.push(issue("duplicate-repair-transaction", `repairRecords[${index}]`, "Repair transaction IDs must be unique."));
				continue;
			}
			transactions.add(record.receipt.transactionId);
			records.push(record);
		}
	}
	const blockingRecords = records.filter(record => (
		["planned", "authorized", "staged", "applying", "rolling-back", "needs-attention"].includes(record.receipt.phase)
		|| record.backupCleanup.status === "deleting"
		|| record.backupCleanup.status === "needs-attention"
	));
	if (blockingRecords.length > 1) {
		issues.push(issue("multiple-blocking-repair-records", "repairRecords", "At most one repair or cleanup record may hold the global lock."));
	}
	if (issues.length > 0 || settings.usedDefaults || !isSafeInteger(raw.revision)) {
		return { data: defaultData(), issues, usedDefaults: true, migrationNeeded: false, journalUsable: false };
	}
	return {
		data: { ...settings.settings, revision: raw.revision, repairRecords: records },
		issues: [], usedDefaults: false, migrationNeeded: false, journalUsable: true,
	};
}

export function clonePersistedData(data: SyncAssetsPersistedData): SyncAssetsPersistedData {
	return structuredClone(data);
}

function stableContent(value: unknown): string {
	return JSON.stringify(value);
}

export class PersistentDataController {
	private data = defaultData();
	private issues: readonly ValidationIssue[] = [];
	private migrationNeeded = false;
	private journalUsable = true;
	private expectedRaw: unknown = undefined;
	private mutationChain: Promise<void> = Promise.resolve();

	constructor(private readonly storage: PersistedDataStorage) {}

	getData(): SyncAssetsPersistedData {
		return clonePersistedData(this.data);
	}

	getIssues(): readonly ValidationIssue[] {
		return [...this.issues];
	}

	isJournalUsable(): boolean {
		return this.journalUsable;
	}

	needsMigration(): boolean {
		return this.migrationNeeded;
	}

	async load(): Promise<PersistedDataParseResult> {
		let raw: unknown;
		try {
			raw = await this.storage.load();
		} catch (error) {
			const foundIssue = issue("settings-load-error", "", `Could not load Sync Assets data: ${error instanceof Error ? error.message : "Unknown storage error."}`);
			this.data = defaultData();
			this.issues = [foundIssue];
			this.journalUsable = false;
			this.migrationNeeded = false;
			this.expectedRaw = undefined;
			return { data: this.getData(), issues: this.getIssues(), usedDefaults: true, migrationNeeded: false, journalUsable: false };
		}
		this.expectedRaw = structuredClone(raw);
		if (raw === null || raw === undefined) {
			this.data = defaultData();
			this.issues = [];
			this.journalUsable = true;
			this.migrationNeeded = true;
			return { data: this.getData(), issues: [], usedDefaults: true, migrationNeeded: true, journalUsable: true };
		}
		const parsed = parsePersistedData(raw);
		this.data = parsed.data;
		this.issues = parsed.issues;
		this.journalUsable = parsed.journalUsable;
		this.migrationNeeded = parsed.migrationNeeded;
		return { ...parsed, data: this.getData(), issues: this.getIssues() };
	}

	mutate(
		apply: (current: SyncAssetsPersistedData) => SyncAssetsPersistedData,
	): Promise<PersistedMutationResult> {
		let resolveResult!: (result: PersistedMutationResult) => void;
		const result = new Promise<PersistedMutationResult>(resolve => {
			resolveResult = resolve;
		});
		this.mutationChain = this.mutationChain.then(async () => {
			if (!this.journalUsable) {
				resolveResult({ ok: false, issue: issue("persisted-data-locked", "", "Persisted data is invalid; repair and cleanup remain locked.") });
				return;
			}
			let currentRaw: unknown;
			try {
				currentRaw = await this.storage.load();
			} catch (error) {
				resolveResult({ ok: false, issue: issue("persisted-data-reload-error", "", `Could not re-read persisted data: ${error instanceof Error ? error.message : "Unknown storage error."}`) });
				return;
			}
			if (stableContent(currentRaw) !== stableContent(this.expectedRaw)) {
				resolveResult({ ok: false, issue: issue("persisted-data-conflict", "revision", "Sync Assets data changed externally; it was not overwritten.") });
				return;
			}
			let next: SyncAssetsPersistedData;
			try {
				next = apply(this.getData());
			} catch (error) {
				resolveResult({ ok: false, issue: issue("persisted-mutation-rejected", "", error instanceof Error ? error.message : "Persisted mutation was rejected.") });
				return;
			}
			const persisted = clonePersistedData({ ...next, schemaVersion: 2, revision: this.data.revision + 1 });
			const validation = parsePersistedData(persisted);
			if (!validation.journalUsable || validation.issues.length > 0) {
				resolveResult({ ok: false, issue: issue("persisted-mutation-invalid", "", validation.issues[0]?.message ?? "Persisted mutation produced invalid data.") });
				return;
			}
			try {
				await this.storage.save(persisted);
			} catch (error) {
				resolveResult({ ok: false, issue: issue("persisted-data-save-error", "", `Could not save Sync Assets data: ${error instanceof Error ? error.message : "Unknown storage error."}`) });
				return;
			}
			this.data = persisted;
			this.expectedRaw = clonePersistedData(persisted);
			this.issues = [];
			this.migrationNeeded = false;
			resolveResult({ ok: true, data: this.getData() });
		});
		return result;
	}
}
