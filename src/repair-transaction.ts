import type { DataAdapter, Stat } from "obsidian";

import type { IntegrityCheckRun } from "./check-coordinator";
import {
	type ArtifactFingerprint,
	type GitHubRepository,
	type IntegrityReason,
	type ReleaseAssetName,
} from "./domain";
import {
	MAX_HASHABLE_ARTIFACT_BYTES,
	sha256ArrayBuffer,
	type Sha256Function,
} from "./integrity-verification";
import {
	createRepairPlan,
	type RepairPlan,
	type RepairPlanArtifact,
} from "./repair-plan";
import type {
	RemoteHttpClient,
	RemoteHttpRequest,
} from "./remote-release";

export const REPAIR_JOURNAL_PHASES = [
	"planned",
	"authorized",
	"staged",
	"applying",
	"committed",
	"rolling-back",
	"rolled-back",
	"needs-attention",
] as const;

export type RepairJournalPhase = (typeof REPAIR_JOURNAL_PHASES)[number];

export const REPAIR_RESULT_STATUSES = [
	"committed",
	"cancelled",
	"blocked",
	"stale",
	"rolled-back",
	"needs-attention",
	"error",
] as const;

export type RepairResultStatus = (typeof REPAIR_RESULT_STATUSES)[number];

export type RepairAdapter = Pick<
	DataAdapter,
	"mkdir" | "readBinary" | "remove" | "rename" | "rmdir" | "stat" | "writeBinary"
>;

export type RepairOriginalGuard =
	| { readonly exists: false }
	| {
		readonly exists: true;
		readonly sizeBytes: number;
		readonly mtimeMs: number;
		readonly sha256: string;
	};

export interface RepairReceiptArtifact {
	readonly assetName: ReleaseAssetName;
	readonly targetPath: string;
	readonly stagedPath: string;
	readonly backupPath: string;
	readonly expected: ArtifactFingerprint;
	readonly original: RepairOriginalGuard | null;
	readonly state: "pending" | "staged" | "backup-moved" | "installed" | "verified" | "rolled-back" | "needs-attention";
	readonly backupRetained: boolean;
}

export interface RepairReceipt {
	readonly transactionId: string;
	readonly planFingerprint: string;
	readonly runId: number;
	readonly pluginId: string;
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly releaseId: number;
	readonly releaseTag: string;
	readonly phase: RepairJournalPhase;
	readonly startedAtMs: number;
	readonly updatedAtMs: number;
	readonly finishedAtMs: number | null;
	readonly restartRequired: true;
	readonly artifacts: readonly RepairReceiptArtifact[];
	readonly completedSteps: readonly string[];
	readonly reason: IntegrityReason | null;
}

export interface RepairJournal {
	readonly getOpenTransaction: () => Promise<RepairReceipt | null>;
	readonly create: (receipt: RepairReceipt) => Promise<void>;
	readonly update: (receipt: RepairReceipt) => Promise<void>;
}

export interface RepairApprovalRequest {
	readonly transactionId: string;
	readonly planFingerprint: string;
	readonly pluginId: string;
	readonly pluginName: string;
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly releaseId: number;
	readonly releaseTag: string;
	readonly artifacts: readonly {
		readonly assetName: ReleaseAssetName;
		readonly expected: ArtifactFingerprint;
	}[];
	readonly restartRequired: true;
}

export interface RepairAuthorization {
	readonly transactionId: string;
	readonly planFingerprint: string;
	readonly approvedAssetNames: readonly ReleaseAssetName[];
	readonly reloadAfterCommit?: boolean;
}

export interface RepairApprovalProvider {
	readonly requestApproval: (
		request: RepairApprovalRequest,
	) => Promise<RepairAuthorization | null>;
}

export interface RepairTransactionResult {
	readonly status: RepairResultStatus;
	readonly transactionId: string | null;
	readonly pluginId: string;
	readonly receipt: RepairReceipt | null;
	readonly reason: IntegrityReason | null;
	readonly completionAction?: "reload-app";
}

export interface RepairTransactionContext {
	readonly adapter: RepairAdapter;
	readonly http: RemoteHttpClient;
	readonly journal: RepairJournal;
	readonly approval: RepairApprovalProvider;
	readonly ownPluginId: string;
	readonly normalizePath: (path: string) => string;
	readonly sha256?: Sha256Function;
	readonly now?: () => number;
	readonly createTransactionId?: () => string;
}

interface AppliedArtifact {
	readonly plan: RepairPlanArtifact;
	readonly original: RepairOriginalGuard;
	backupMoved: boolean;
	installed: boolean;
}

type GuardResult =
	| { readonly ok: true; readonly guard: RepairOriginalGuard }
	| { readonly ok: false; readonly reason: IntegrityReason };

type OperationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: IntegrityReason };

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown repair operation error.";
}

function result(
	status: RepairResultStatus,
	pluginId: string,
	problem: IntegrityReason | null,
	receipt: RepairReceipt | null = null,
	transactionId: string | null = receipt?.transactionId ?? null,
): RepairTransactionResult {
	return { status, transactionId, pluginId, receipt, reason: problem };
}

function isValidStatNumber(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: string): boolean {
	return /^sha256:[0-9a-f]{64}$/.test(value);
}

function sameGuard(left: RepairOriginalGuard, right: RepairOriginalGuard): boolean {
	return left.exists === false
		? right.exists === false
		: right.exists === true
			&& left.sizeBytes === right.sizeBytes
			&& left.mtimeMs === right.mtimeMs
			&& left.sha256 === right.sha256;
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

function createDefaultTransactionId(): string {
	if (globalThis.crypto?.getRandomValues === undefined) {
		throw new Error("Web Crypto random values are unavailable in this runtime.");
	}
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return `repair-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function downloadRequest(url: string): RemoteHttpRequest {
	return {
		url,
		method: "GET",
		throw: false,
		headers: {
			Accept: "application/octet-stream",
			"User-Agent": "Sync-Assets-Obsidian",
		},
	};
}

function approvalRequest(plan: RepairPlan): RepairApprovalRequest {
	return {
		transactionId: plan.transactionId,
		planFingerprint: plan.fingerprint,
		pluginId: plan.pluginId,
		pluginName: plan.pluginName,
		repository: { ...plan.repository },
		manifestVersion: plan.manifestVersion,
		releaseId: plan.releaseId,
		releaseTag: plan.releaseTag,
		artifacts: plan.artifacts.map(artifact => ({
			assetName: artifact.assetName,
			expected: { ...artifact.expected },
		})),
		restartRequired: true,
	};
}

function authorizationMatches(
	plan: RepairPlan,
	authorization: RepairAuthorization,
): boolean {
	return authorization.transactionId === plan.transactionId
		&& authorization.planFingerprint === plan.fingerprint
		&& authorization.approvedAssetNames.length === plan.artifacts.length
		&& authorization.approvedAssetNames.every((assetName, index) => (
			assetName === plan.artifacts[index]?.assetName
		))
		&& (
			authorization.reloadAfterCommit !== true
			|| plan.artifacts.every(artifact => artifact.assetName !== "manifest.json")
		);
}

function initialReceipt(plan: RepairPlan, nowMs: number): RepairReceipt {
	return {
		transactionId: plan.transactionId,
		planFingerprint: plan.fingerprint,
		runId: plan.runId,
		pluginId: plan.pluginId,
		repository: { ...plan.repository },
		manifestVersion: plan.manifestVersion,
		releaseId: plan.releaseId,
		releaseTag: plan.releaseTag,
		phase: "planned",
		startedAtMs: nowMs,
		updatedAtMs: nowMs,
		finishedAtMs: null,
		restartRequired: true,
		artifacts: plan.artifacts.map(artifact => ({
			assetName: artifact.assetName,
			targetPath: artifact.targetPath,
			stagedPath: artifact.stagedPath,
			backupPath: artifact.backupPath,
			expected: { ...artifact.expected },
			original: null,
			state: "pending",
			backupRetained: false,
		})),
		completedSteps: [],
		reason: null,
	};
}

function updateReceipt(
	receipt: RepairReceipt,
	nowMs: number,
	changes: Partial<Pick<RepairReceipt, "artifacts" | "finishedAtMs" | "phase" | "reason">>,
	step?: string,
): RepairReceipt {
	return {
		...receipt,
		...changes,
		updatedAtMs: nowMs,
		completedSteps: step === undefined
			? receipt.completedSteps
			: [...receipt.completedSteps, step],
	};
}

function updateReceiptArtifact(
	receipt: RepairReceipt,
	assetName: ReleaseAssetName,
	changes: Partial<RepairReceiptArtifact>,
): RepairReceipt {
	return {
		...receipt,
		artifacts: receipt.artifacts.map(artifact => (
			artifact.assetName === assetName ? { ...artifact, ...changes } : artifact
		)),
	};
}

async function stat(
	adapter: RepairAdapter,
	path: string,
): Promise<Stat | null | IntegrityReason> {
	try {
		return await adapter.stat(path);
	} catch (error) {
		return reason("repair-stat-error", `Could not inspect ${path}: ${getErrorMessage(error)}`);
	}
}

function isProblem(value: Stat | null | IntegrityReason): value is IntegrityReason {
	return value !== null && "code" in value;
}

async function captureGuard(
	adapter: RepairAdapter,
	path: string,
	sha256: Sha256Function,
): Promise<GuardResult> {
	const initial = await stat(adapter, path);
	if (isProblem(initial)) {
		return { ok: false, reason: initial };
	}
	if (initial === null) {
		return { ok: true, guard: { exists: false } };
	}
	if (
		initial.type !== "file"
		|| !isValidStatNumber(initial.size)
		|| !isValidStatNumber(initial.mtime)
		|| initial.size > MAX_HASHABLE_ARTIFACT_BYTES
	) {
		return {
			ok: false,
			reason: reason("repair-local-file-unverifiable", `Repair target ${path} is not a hashable regular file.`),
		};
	}

	let bytes: ArrayBuffer;
	try {
		bytes = await adapter.readBinary(path);
	} catch (error) {
		return { ok: false, reason: reason("repair-read-error", `Could not read ${path}: ${getErrorMessage(error)}`) };
	}
	if (bytes.byteLength !== initial.size) {
		return { ok: false, reason: reason("repair-read-size-mismatch", `Read size changed for ${path}.`) };
	}
	const final = await stat(adapter, path);
	if (
		isProblem(final)
		|| final === null
		|| final.type !== "file"
		|| final.size !== initial.size
		|| final.mtime !== initial.mtime
	) {
		return {
			ok: false,
			reason: isProblem(final)
				? final
				: reason("repair-file-changed-during-read", `Repair target ${path} changed while it was read.`),
		};
	}

	let digest: string;
	try {
		digest = (await sha256(bytes)).toLowerCase();
	} catch (error) {
		return { ok: false, reason: reason("repair-hash-error", `Could not hash ${path}: ${getErrorMessage(error)}`) };
	}
	if (!isSha256(digest)) {
		return { ok: false, reason: reason("repair-invalid-hash", "SHA-256 implementation returned an invalid digest.") };
	}
	return {
		ok: true,
		guard: {
			exists: true,
			sizeBytes: initial.size,
			mtimeMs: initial.mtime,
			sha256: digest,
		},
	};
}

function guardMatchesStageFive(
	artifact: RepairPlanArtifact,
	guard: RepairOriginalGuard,
): boolean {
	if (artifact.original.exists === false) {
		return guard.exists === false;
	}
	if (artifact.original.exists !== true || guard.exists !== true) {
		return false;
	}
	if (
		artifact.original.sizeBytes === null
		|| artifact.original.sizeBytes !== guard.sizeBytes
		|| (
			artifact.original.sha256 !== null
			&& artifact.original.sha256 !== guard.sha256
		)
	) {
		return false;
	}
	return guard.sizeBytes !== artifact.expected.sizeBytes
		|| guard.sha256 !== artifact.expected.sha256;
}

async function verifyExpectedFile(
	adapter: RepairAdapter,
	path: string,
	expected: ArtifactFingerprint,
	sha256: Sha256Function,
): Promise<OperationResult> {
	const guard = await captureGuard(adapter, path, sha256);
	if (!guard.ok) {
		return guard;
	}
	if (
		guard.guard.exists === false
		|| guard.guard.sizeBytes !== expected.sizeBytes
		|| guard.guard.sha256 !== expected.sha256
	) {
		return { ok: false, reason: reason("repair-written-file-mismatch", `Written file ${path} failed size or SHA-256 verification.`) };
	}
	return { ok: true };
}

async function ensureDirectory(
	adapter: RepairAdapter,
	path: string,
): Promise<OperationResult> {
	const current = await stat(adapter, path);
	if (isProblem(current)) {
		return { ok: false, reason: current };
	}
	if (current !== null) {
		return current.type === "folder"
			? { ok: true }
			: { ok: false, reason: reason("repair-workspace-not-folder", `${path} must be a folder.`) };
	}
	try {
		await adapter.mkdir(path);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: reason("repair-mkdir-error", `Could not create ${path}: ${getErrorMessage(error)}`) };
	}
}

async function createWorkspace(
	adapter: RepairAdapter,
	plan: RepairPlan,
): Promise<OperationResult> {
	const ownPluginPath = parentPath(parentPath(plan.workspacePath));
	const repairRootPath = parentPath(plan.workspacePath);
	const ownPluginStat = await stat(adapter, ownPluginPath);
	if (isProblem(ownPluginStat)) {
		return { ok: false, reason: ownPluginStat };
	}
	if (ownPluginStat?.type !== "folder") {
		return { ok: false, reason: reason("repair-own-plugin-folder-missing", "Sync Assets plugin folder is unavailable.") };
	}
	const repairRoot = await ensureDirectory(adapter, repairRootPath);
	if (!repairRoot.ok) {
		return repairRoot;
	}
	const workspaceStat = await stat(adapter, plan.workspacePath);
	if (isProblem(workspaceStat)) {
		return { ok: false, reason: workspaceStat };
	}
	if (workspaceStat !== null) {
		return { ok: false, reason: reason("repair-workspace-collision", "Repair transaction workspace already exists.") };
	}
	for (const path of [
		plan.workspacePath,
		plan.stagedDirectoryPath,
		plan.backupDirectoryPath,
	]) {
		const created = await ensureDirectory(adapter, path);
		if (!created.ok) {
			return created;
		}
	}
	return { ok: true };
}

async function bytesForArtifact(
	plan: RepairPlan,
	artifact: RepairPlanArtifact,
	http: RemoteHttpClient,
): Promise<{ readonly ok: true; readonly bytes: ArrayBuffer } | { readonly ok: false; readonly reason: IntegrityReason }> {
	if (artifact.expected.sizeBytes > MAX_HASHABLE_ARTIFACT_BYTES) {
		return { ok: false, reason: reason("repair-download-size-limit", `${artifact.assetName} exceeds the repair memory limit.`) };
	}
	if (artifact.assetName === "manifest.json") {
		return { ok: true, bytes: plan.remoteManifestBytes.slice(0) };
	}
	if (artifact.downloadUrl === null) {
		return { ok: false, reason: reason("repair-download-url-missing", `${artifact.assetName} lacks a trusted download URL.`) };
	}
	try {
		const response = await http(downloadRequest(artifact.downloadUrl));
		if (response.status !== 200) {
			return { ok: false, reason: reason("repair-download-http-error", `${artifact.assetName} download returned HTTP ${response.status}.`) };
		}
		return { ok: true, bytes: response.arrayBuffer };
	} catch (error) {
		return { ok: false, reason: reason("repair-download-error", `Could not download ${artifact.assetName}: ${getErrorMessage(error)}`) };
	}
}

async function stageArtifacts(
	plan: RepairPlan,
	context: RepairTransactionContext,
	sha256: Sha256Function,
	stagedByEngine: Set<ReleaseAssetName>,
): Promise<OperationResult> {
	for (const artifact of plan.artifacts) {
		const downloaded = await bytesForArtifact(plan, artifact, context.http);
		if (!downloaded.ok) {
			return downloaded;
		}
		if (downloaded.bytes.byteLength !== artifact.expected.sizeBytes) {
			return { ok: false, reason: reason("repair-download-size-mismatch", `${artifact.assetName} download size differs from trusted metadata.`) };
		}
		let digest: string;
		try {
			digest = (await sha256(downloaded.bytes)).toLowerCase();
		} catch (error) {
			return { ok: false, reason: reason("repair-download-hash-error", `Could not hash ${artifact.assetName}: ${getErrorMessage(error)}`) };
		}
		if (!isSha256(digest) || digest !== artifact.expected.sha256) {
			return { ok: false, reason: reason("repair-download-digest-mismatch", `${artifact.assetName} download digest differs from trusted metadata.`) };
		}
		const existing = await stat(context.adapter, artifact.stagedPath);
		if (isProblem(existing)) {
			return { ok: false, reason: existing };
		}
		if (existing !== null) {
			return { ok: false, reason: reason("repair-staging-collision", `Staging path for ${artifact.assetName} already exists.`) };
		}
		stagedByEngine.add(artifact.assetName);
		try {
			await context.adapter.writeBinary(artifact.stagedPath, downloaded.bytes);
		} catch (error) {
			return { ok: false, reason: reason("repair-stage-write-error", `Could not stage ${artifact.assetName}: ${getErrorMessage(error)}`) };
		}
		const staged = await verifyExpectedFile(context.adapter, artifact.stagedPath, artifact.expected, sha256);
		if (!staged.ok) {
			return staged;
		}
	}
	return { ok: true };
}

async function removeOwnedFile(
	adapter: RepairAdapter,
	path: string,
): Promise<OperationResult> {
	const current = await stat(adapter, path);
	if (isProblem(current)) {
		return { ok: false, reason: current };
	}
	if (current === null) {
		return { ok: true };
	}
	if (current.type !== "file") {
		return { ok: false, reason: reason("repair-owned-path-not-file", `Transaction-owned path ${path} is not a file.`) };
	}
	try {
		await adapter.remove(path);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: reason("repair-cleanup-error", `Could not remove ${path}: ${getErrorMessage(error)}`) };
	}
}

async function cleanupStagedFiles(
	adapter: RepairAdapter,
	plan: RepairPlan,
	stagedByEngine: ReadonlySet<ReleaseAssetName>,
): Promise<IntegrityReason | null> {
	for (const artifact of [...plan.artifacts].reverse().filter(candidate => (
		stagedByEngine.has(candidate.assetName)
	))) {
		const removed = await removeOwnedFile(adapter, artifact.stagedPath);
		if (!removed.ok) {
			return removed.reason;
		}
	}
	return null;
}

async function cleanupEmptyWorkspaceDirectories(
	adapter: RepairAdapter,
	plan: RepairPlan,
): Promise<void> {
	for (const path of [
		plan.stagedDirectoryPath,
		plan.backupDirectoryPath,
		plan.workspacePath,
	]) {
		try {
			await adapter.rmdir(path, false);
		} catch {
			// Empty transaction directories are best-effort cleanup. A non-empty or
			// externally changed directory is deliberately left untouched.
		}
	}
}

async function captureFreshGuards(
	plan: RepairPlan,
	adapter: RepairAdapter,
	sha256: Sha256Function,
): Promise<
	| { readonly ok: true; readonly guards: ReadonlyMap<ReleaseAssetName, RepairOriginalGuard> }
	| { readonly ok: false; readonly reason: IntegrityReason }
> {
	const guards = new Map<ReleaseAssetName, RepairOriginalGuard>();
	for (const artifact of plan.artifacts) {
		const captured = await captureGuard(adapter, artifact.targetPath, sha256);
		if (!captured.ok) {
			return captured;
		}
		if (!guardMatchesStageFive(artifact, captured.guard)) {
			return {
				ok: false,
				reason: reason("repair-evidence-stale", `${artifact.assetName} changed after the integrity check.`),
			};
		}
		guards.set(artifact.assetName, captured.guard);
	}
	return { ok: true, guards };
}

async function guardStillMatches(
	artifact: RepairPlanArtifact,
	expected: RepairOriginalGuard,
	adapter: RepairAdapter,
	sha256: Sha256Function,
): Promise<OperationResult> {
	const current = await captureGuard(adapter, artifact.targetPath, sha256);
	if (!current.ok) {
		return current;
	}
	return sameGuard(expected, current.guard)
		? { ok: true }
		: { ok: false, reason: reason("repair-target-race", `${artifact.assetName} changed immediately before replacement.`) };
}

async function rename(
	adapter: RepairAdapter,
	from: string,
	to: string,
): Promise<OperationResult> {
	try {
		await adapter.rename(from, to);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: reason("repair-rename-error", `Could not move ${from} to ${to}: ${getErrorMessage(error)}`) };
	}
}

async function applyArtifact(
	state: AppliedArtifact,
	adapter: RepairAdapter,
	sha256: Sha256Function,
): Promise<OperationResult> {
	const unchanged = await guardStillMatches(state.plan, state.original, adapter, sha256);
	if (!unchanged.ok) {
		return unchanged;
	}
	if (state.original.exists) {
		const backupAbsent = await stat(adapter, state.plan.backupPath);
		if (isProblem(backupAbsent)) {
			return { ok: false, reason: backupAbsent };
		}
		if (backupAbsent !== null) {
			return { ok: false, reason: reason("repair-backup-collision", `Backup path for ${state.plan.assetName} already exists.`) };
		}
		const moved = await rename(adapter, state.plan.targetPath, state.plan.backupPath);
		if (!moved.ok) {
			return moved;
		}
		state.backupMoved = true;
		const backup = await captureGuard(adapter, state.plan.backupPath, sha256);
		if (!backup.ok || !sameGuard(state.original, backup.guard)) {
			return {
				ok: false,
				reason: backup.ok
					? reason("repair-backup-verification-failed", `Backup for ${state.plan.assetName} differs from the original.`)
					: backup.reason,
			};
		}
	}
	const installed = await rename(adapter, state.plan.stagedPath, state.plan.targetPath);
	if (!installed.ok) {
		return installed;
	}
	state.installed = true;
	return verifyExpectedFile(adapter, state.plan.targetPath, state.plan.expected, sha256);
}

async function rollbackArtifact(
	state: AppliedArtifact,
	adapter: RepairAdapter,
	sha256: Sha256Function,
): Promise<OperationResult> {
	if (state.installed) {
		const installed = await captureGuard(adapter, state.plan.targetPath, sha256);
		if (!installed.ok) {
			return installed;
		}
		if (
			installed.guard.exists === false
			|| installed.guard.sizeBytes !== state.plan.expected.sizeBytes
			|| installed.guard.sha256 !== state.plan.expected.sha256
		) {
			return {
				ok: false,
				reason: reason(
					"repair-rollback-target-changed",
					`Installed ${state.plan.assetName} no longer matches this transaction; it was not removed.`,
				),
			};
		}
		const removed = await removeOwnedFile(adapter, state.plan.targetPath);
		if (!removed.ok) {
			return removed;
		}
	}
	if (state.backupMoved) {
		const restored = await rename(adapter, state.plan.backupPath, state.plan.targetPath);
		if (!restored.ok) {
			return restored;
		}
	}
	const restoredGuard = await captureGuard(adapter, state.plan.targetPath, sha256);
	if (!restoredGuard.ok) {
		return restoredGuard;
	}
	return sameGuard(state.original, restoredGuard.guard)
		? { ok: true }
		: { ok: false, reason: reason("repair-rollback-verification-failed", `Rollback verification failed for ${state.plan.assetName}.`) };
}

export class RepairTransactionEngine {
	private active = false;

	constructor(private readonly context: RepairTransactionContext) {}

	repair(run: IntegrityCheckRun, pluginId: string): Promise<RepairTransactionResult> {
		if (this.active) {
			return Promise.resolve(result(
				"blocked",
				pluginId,
				reason("repair-in-progress", "Another repair transaction is already active."),
			));
		}
		this.active = true;
		return this.execute(run, pluginId).finally(() => {
			this.active = false;
		});
	}

	private async execute(
		run: IntegrityCheckRun,
		pluginId: string,
	): Promise<RepairTransactionResult> {
		const now = this.context.now ?? Date.now;
		const sha256 = this.context.sha256 ?? sha256ArrayBuffer;
		let transactionId: string;
		try {
			transactionId = (this.context.createTransactionId ?? createDefaultTransactionId)();
		} catch (error) {
			return result("error", pluginId, reason("repair-id-error", getErrorMessage(error)));
		}

		let open: RepairReceipt | null;
		try {
			open = await this.context.journal.getOpenTransaction();
		} catch (error) {
			return result("error", pluginId, reason("repair-journal-read-error", getErrorMessage(error)), null, transactionId);
		}
		if (open !== null) {
			return result(
				"blocked",
				pluginId,
				reason("repair-journal-open", "A previous repair requires attention before another repair."),
				null,
				transactionId,
			);
		}

		const planned = createRepairPlan(run, pluginId, {
			transactionId,
			ownPluginId: this.context.ownPluginId,
			normalizePath: this.context.normalizePath,
		});
		if (!planned.ok) {
			return result("blocked", pluginId, planned.reason, null, transactionId);
		}
		const plan = planned.plan;
		let receipt = initialReceipt(plan, now());
		const stagedByEngine = new Set<ReleaseAssetName>();

		let authorization: RepairAuthorization | null;
		try {
			authorization = await this.context.approval.requestApproval(approvalRequest(plan));
		} catch (error) {
			return result("error", pluginId, reason("repair-approval-error", getErrorMessage(error)), receipt);
		}
		if (authorization === null) {
			return result("cancelled", pluginId, null, receipt);
		}
		if (!authorizationMatches(plan, authorization)) {
			return result(
				"blocked",
				pluginId,
				reason("repair-authorization-mismatch", "Repair authorization does not exactly match the planned transaction."),
				receipt,
			);
		}

		receipt = updateReceipt(receipt, now(), { phase: "authorized" }, "authorization-recorded");
		try {
			await this.context.journal.create(receipt);
		} catch (error) {
			return result("error", pluginId, reason("repair-journal-create-error", getErrorMessage(error)), receipt);
		}

		const workspace = await createWorkspace(this.context.adapter, plan);
		if (!workspace.ok) {
			return this.finishBeforeMutation("error", plan, receipt, workspace.reason, now, stagedByEngine);
		}
		const staged = await stageArtifacts(plan, this.context, sha256, stagedByEngine);
		if (!staged.ok) {
			return this.finishBeforeMutation("error", plan, receipt, staged.reason, now, stagedByEngine);
		}
		for (const artifact of plan.artifacts) {
			receipt = updateReceiptArtifact(receipt, artifact.assetName, { state: "staged" });
		}
		receipt = updateReceipt(receipt, now(), { phase: "staged" }, "all-artifacts-staged-and-verified");
		try {
			await this.context.journal.update(receipt);
		} catch (error) {
			return this.finishBeforeMutation(
				"error",
				plan,
				receipt,
				reason("repair-journal-update-error", getErrorMessage(error)),
				now,
				stagedByEngine,
			);
		}

		const fresh = await captureFreshGuards(plan, this.context.adapter, sha256);
		if (!fresh.ok) {
			return this.finishBeforeMutation("stale", plan, receipt, fresh.reason, now, stagedByEngine);
		}
		for (const artifact of plan.artifacts) {
			const guard = fresh.guards.get(artifact.assetName);
			if (guard === undefined) {
				return this.finishBeforeMutation(
					"error",
					plan,
					receipt,
					reason("repair-guard-missing", `Fresh guard for ${artifact.assetName} is missing.`),
					now,
					stagedByEngine,
				);
			}
			receipt = updateReceiptArtifact(receipt, artifact.assetName, { original: guard });
		}
		receipt = updateReceipt(receipt, now(), { phase: "applying" }, "fresh-local-evidence-recorded");
		try {
			await this.context.journal.update(receipt);
		} catch (error) {
			return this.finishBeforeMutation(
				"error",
				plan,
				receipt,
				reason("repair-journal-update-error", getErrorMessage(error)),
				now,
				stagedByEngine,
			);
		}

		const applied: AppliedArtifact[] = [];
		for (const artifact of plan.artifacts) {
			const original = fresh.guards.get(artifact.assetName);
			if (original === undefined) {
				return this.rollback(plan, receipt, applied, stagedByEngine, reason("repair-guard-missing", "Repair guard disappeared."), now, sha256);
			}
			const state: AppliedArtifact = {
				plan: artifact,
				original,
				backupMoved: false,
				installed: false,
			};
			applied.push(state);
			const changed = await applyArtifact(state, this.context.adapter, sha256);
			if (!changed.ok) {
				return this.rollback(plan, receipt, applied, stagedByEngine, changed.reason, now, sha256);
			}
			receipt = updateReceiptArtifact(receipt, artifact.assetName, {
				state: "verified",
				backupRetained: original.exists,
			});
			receipt = updateReceipt(receipt, now(), {}, `${artifact.assetName}-installed-and-verified`);
			try {
				await this.context.journal.update(receipt);
			} catch (error) {
				return this.rollback(
					plan,
					receipt,
					applied,
					stagedByEngine,
					reason("repair-journal-update-error", getErrorMessage(error)),
					now,
					sha256,
				);
			}
		}

		receipt = updateReceipt(
			receipt,
			now(),
			{ phase: "committed", finishedAtMs: now(), reason: null },
			"transaction-committed",
		);
		try {
			await this.context.journal.update(receipt);
		} catch (error) {
			return this.rollback(
				plan,
				receipt,
				applied,
				stagedByEngine,
				reason("repair-journal-commit-error", getErrorMessage(error)),
					now,
					sha256,
				);
			}
			await cleanupEmptyWorkspaceDirectories(this.context.adapter, plan);
			const committed = result("committed", pluginId, null, receipt);
		return authorization.reloadAfterCommit === true
			? { ...committed, completionAction: "reload-app" }
			: committed;
	}

	private async finishBeforeMutation(
		status: "error" | "stale",
		plan: RepairPlan,
		receipt: RepairReceipt,
		problem: IntegrityReason,
		now: () => number,
		stagedByEngine: ReadonlySet<ReleaseAssetName>,
	): Promise<RepairTransactionResult> {
		const cleanupProblem = await cleanupStagedFiles(this.context.adapter, plan, stagedByEngine);
		await cleanupEmptyWorkspaceDirectories(this.context.adapter, plan);
		const finalProblem = cleanupProblem ?? problem;
		let finalReceipt = updateReceipt(
			receipt,
			now(),
			{ phase: "rolled-back", finishedAtMs: now(), reason: finalProblem },
			"staged-files-cleaned-without-target-mutation",
		);
		try {
			await this.context.journal.update(finalReceipt);
		} catch (error) {
			const journalProblem = reason("repair-journal-finalize-error", getErrorMessage(error));
			finalReceipt = updateReceipt(
				finalReceipt,
				now(),
				{ phase: "needs-attention", finishedAtMs: now(), reason: journalProblem },
			);
			return result("needs-attention", plan.pluginId, journalProblem, finalReceipt);
		}
		return result(status, plan.pluginId, finalProblem, finalReceipt);
	}

	private async rollback(
		plan: RepairPlan,
		receipt: RepairReceipt,
		applied: readonly AppliedArtifact[],
		stagedByEngine: ReadonlySet<ReleaseAssetName>,
		cause: IntegrityReason,
		now: () => number,
		sha256: Sha256Function,
	): Promise<RepairTransactionResult> {
		let currentReceipt = updateReceipt(
			receipt,
			now(),
			{ phase: "rolling-back", finishedAtMs: null, reason: cause },
			"rollback-started",
		);
		let journalFailed = false;
		try {
			await this.context.journal.update(currentReceipt);
		} catch {
			journalFailed = true;
		}

		let rollbackProblem: IntegrityReason | null = null;
		for (const state of [...applied].reverse()) {
			const rolledBack = await rollbackArtifact(state, this.context.adapter, sha256);
			if (!rolledBack.ok) {
				rollbackProblem ??= rolledBack.reason;
				currentReceipt = updateReceiptArtifact(currentReceipt, state.plan.assetName, {
					state: "needs-attention",
					backupRetained: state.backupMoved,
				});
				continue;
			}
			currentReceipt = updateReceiptArtifact(currentReceipt, state.plan.assetName, {
				state: "rolled-back",
				backupRetained: false,
			});
		}
		const cleanupProblem = await cleanupStagedFiles(this.context.adapter, plan, stagedByEngine);
		await cleanupEmptyWorkspaceDirectories(this.context.adapter, plan);
		rollbackProblem ??= cleanupProblem;
		if (journalFailed) {
			rollbackProblem ??= reason("repair-journal-rollback-error", "Repair journal could not record rollback progress.");
		}

		const needsAttention = rollbackProblem !== null;
		const finalReason = rollbackProblem ?? cause;
		currentReceipt = updateReceipt(
			currentReceipt,
			now(),
			{
				phase: needsAttention ? "needs-attention" : "rolled-back",
				finishedAtMs: now(),
				reason: finalReason,
			},
			needsAttention ? "rollback-needs-attention" : "rollback-completed",
		);
		try {
			await this.context.journal.update(currentReceipt);
		} catch (error) {
			const journalProblem = reason("repair-journal-finalize-error", getErrorMessage(error));
			currentReceipt = updateReceipt(
				currentReceipt,
				now(),
				{ phase: "needs-attention", finishedAtMs: now(), reason: journalProblem },
			);
			return result("needs-attention", plan.pluginId, journalProblem, currentReceipt);
		}
		return result(
			needsAttention ? "needs-attention" : "rolled-back",
			plan.pluginId,
			finalReason,
			currentReceipt,
		);
	}
}
