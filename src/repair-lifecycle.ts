import type { Stat } from "obsidian";

import type { IntegrityCheckRun } from "./check-coordinator";
import {
	OBSIDIAN_NO_SOURCE_MAP_SUFFIX,
	RELEASE_ASSET_NAMES,
	type IntegrityReason,
	type ReleaseAssetName,
} from "./domain";
import {
	sha256ArrayBuffer,
	type Sha256Function,
} from "./integrity-verification";
import {
	type BackupCleanupState,
	type PersistedRepairRecord,
	PersistentDataController,
	type PostRestartHealthyProof,
} from "./persisted-state";
import type {
	RepairAdapter,
	RepairJournal,
	RepairJournalPhase,
	RepairReceipt,
} from "./repair-transaction";

const BLOCKING_PHASES = new Set<RepairJournalPhase>([
	"planned", "authorized", "staged", "applying", "rolling-back", "needs-attention",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<RepairJournalPhase, ReadonlySet<RepairJournalPhase>>> = {
	planned: new Set(["authorized"]),
	authorized: new Set(["authorized", "staged", "rolled-back", "needs-attention"]),
	staged: new Set(["staged", "applying", "rolling-back", "rolled-back", "needs-attention"]),
	applying: new Set(["applying", "committed", "rolling-back", "rolled-back", "needs-attention"]),
	committed: new Set(["committed", "rolling-back", "rolled-back", "needs-attention"]),
	"rolling-back": new Set(["rolling-back", "rolled-back", "needs-attention"]),
	"rolled-back": new Set(["rolled-back"]),
	"needs-attention": new Set(["needs-attention"]),
};

const ALLOWED_CLEANUP_TRANSITIONS: Readonly<Record<PersistedRepairRecord["backupCleanup"]["status"], ReadonlySet<PersistedRepairRecord["backupCleanup"]["status"]>>> = {
	none: new Set(["none"]),
	retained: new Set(["retained", "cleanup-eligible", "needs-attention"]),
	"cleanup-eligible": new Set(["cleanup-eligible", "deleting", "needs-attention"]),
	deleting: new Set(["deleting", "deleted", "needs-attention"]),
	deleted: new Set(["deleted"]),
	"needs-attention": new Set(["needs-attention"]),
};

export interface RepairJournalSnapshot {
	readonly usable: boolean;
	readonly records: readonly PersistedRepairRecord[];
	readonly blockingRecord: PersistedRepairRecord | null;
}

export type HealthyReconciliationResult =
	| { readonly status: "recorded"; readonly record: PersistedRepairRecord }
	| { readonly status: "no-match" | "same-session" | "not-committed" | "persistence-error"; readonly reason: IntegrityReason | null };

export interface HealthyReconciliationAttempt {
	readonly transactionId: string;
	readonly pluginId: string;
	readonly result: HealthyReconciliationResult;
}

export interface AppSessionEvidence {
	readonly sessionId: string;
	/** The document's navigation time origin, which survives plugin reloads. */
	readonly startedAtMs: number;
}

export type BackupCleanupAdapter = Pick<RepairAdapter, "readBinary" | "remove" | "rmdir" | "stat">;

export type BackupCleanupResult =
	| { readonly status: "deleted"; readonly record: PersistedRepairRecord }
	| { readonly status: "cancelled" }
	| { readonly status: "blocked" | "needs-attention"; readonly reason: IntegrityReason };

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function sameRepository(
	left: RepairReceipt["repository"],
	right: RepairReceipt["repository"],
): boolean {
	return left.owner === right.owner && left.repo === right.repo;
}

function receiptIdentityMatches(left: RepairReceipt, right: RepairReceipt): boolean {
	return left.transactionId === right.transactionId
		&& left.planFingerprint === right.planFingerprint
		&& left.runId === right.runId
		&& left.pluginId === right.pluginId
		&& sameRepository(left.repository, right.repository)
		&& left.manifestVersion === right.manifestVersion
		&& left.releaseId === right.releaseId
		&& left.releaseTag === right.releaseTag
		&& left.startedAtMs === right.startedAtMs
		&& left.restartRequired === right.restartRequired
		&& left.artifacts.length === right.artifacts.length
		&& left.artifacts.every((artifact, index) => {
			const other = right.artifacts[index];
			return other !== undefined
				&& artifact.assetName === other.assetName
				&& artifact.targetPath === other.targetPath
				&& artifact.stagedPath === other.stagedPath
				&& artifact.backupPath === other.backupPath
				&& artifact.expected.sizeBytes === other.expected.sizeBytes
				&& artifact.expected.sha256 === other.expected.sha256;
		});
}

export function isRepairRecordBlocking(record: PersistedRepairRecord): boolean {
	return BLOCKING_PHASES.has(record.receipt.phase)
		|| record.backupCleanup.status === "deleting"
		|| record.backupCleanup.status === "needs-attention";
}

function defaultCleanup(receipt: RepairReceipt): BackupCleanupState {
	return {
		status: receipt.artifacts.some(artifact => artifact.backupRetained) ? "retained" : "none",
		deletedAssetNames: [],
		reason: null,
	};
}

export class PersistentRepairJournal implements RepairJournal {
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly persistence: PersistentDataController,
		private readonly sessionId: string,
	) {}

	getSnapshot(): RepairJournalSnapshot {
		const records = this.persistence.getData().repairRecords;
		return {
			usable: this.persistence.isJournalUsable(),
			records,
			blockingRecord: records.find(isRepairRecordBlocking) ?? null,
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		listener();
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	getOpenTransaction(): Promise<RepairReceipt | null> {
		if (!this.persistence.isJournalUsable()) {
			return Promise.reject(new Error("Persisted repair journal is invalid and locked."));
		}
		return Promise.resolve(this.getSnapshot().blockingRecord?.receipt ?? null);
	}

	async create(receipt: RepairReceipt): Promise<void> {
		if (receipt.phase !== "authorized") {
			throw new Error("A persistent repair record must begin in the authorized phase.");
		}
		const result = await this.persistence.mutate(current => {
			if (current.repairRecords.some(record => record.receipt.transactionId === receipt.transactionId)) {
				throw new Error("Repair transaction already exists.");
			}
			if (current.repairRecords.some(isRepairRecordBlocking)) {
				throw new Error("Another repair record is blocking mutations.");
			}
			return {
				...current,
				repairRecords: [...current.repairRecords, {
					receipt,
					originSessionId: this.sessionId,
					healthyProof: null,
					backupCleanup: defaultCleanup(receipt),
				}],
			};
		});
		if (!result.ok) {
			throw new Error(result.issue.message);
		}
		this.emit();
	}

	async update(receipt: RepairReceipt): Promise<void> {
		const result = await this.persistence.mutate(current => {
			const index = current.repairRecords.findIndex(record => record.receipt.transactionId === receipt.transactionId);
			const existing = current.repairRecords[index];
			if (existing === undefined) {
				throw new Error("Repair transaction does not exist.");
			}
			if (!receiptIdentityMatches(existing.receipt, receipt)) {
				throw new Error("Repair receipt immutable identity changed.");
			}
			if (!ALLOWED_TRANSITIONS[existing.receipt.phase].has(receipt.phase)) {
				throw new Error(`Illegal repair phase transition: ${existing.receipt.phase} to ${receipt.phase}.`);
			}
			const records = [...current.repairRecords];
			records[index] = {
				...existing,
				receipt,
				backupCleanup: receipt.phase === "committed" ? defaultCleanup(receipt) : existing.backupCleanup,
			};
			return { ...current, repairRecords: records };
		});
		if (!result.ok) {
			throw new Error(result.issue.message);
		}
		this.emit();
	}

	async updateRecord(
		transactionId: string,
		update: (record: PersistedRepairRecord) => PersistedRepairRecord,
	): Promise<PersistedRepairRecord> {
		let updated: PersistedRepairRecord | null = null;
		const result = await this.persistence.mutate(current => {
			const index = current.repairRecords.findIndex(record => record.receipt.transactionId === transactionId);
			const existing = current.repairRecords[index];
			if (existing === undefined) {
				throw new Error("Repair transaction does not exist.");
			}
			updated = update(existing);
			if (!receiptIdentityMatches(existing.receipt, updated.receipt)) {
				throw new Error("Repair record update changed immutable receipt identity.");
			}
			if (updated.originSessionId !== existing.originSessionId) {
				throw new Error("Repair record update changed its immutable origin session.");
			}
			if (
				existing.healthyProof !== null
				&& JSON.stringify(updated.healthyProof) !== JSON.stringify(existing.healthyProof)
			) {
				throw new Error("Post-restart healthy proof is immutable once recorded.");
			}
			if (!ALLOWED_CLEANUP_TRANSITIONS[existing.backupCleanup.status].has(updated.backupCleanup.status)) {
				throw new Error(`Illegal backup cleanup transition: ${existing.backupCleanup.status} to ${updated.backupCleanup.status}.`);
			}
			const records = [...current.repairRecords];
			records[index] = updated;
			return { ...current, repairRecords: records };
		});
		if (!result.ok || updated === null) {
			throw new Error(result.ok ? "Repair record update failed." : result.issue.message);
		}
		this.emit();
		return structuredClone(updated);
	}

	async removeVerifiedRecord(transactionId: string): Promise<void> {
		const result = await this.persistence.mutate(current => {
			const record = current.repairRecords.find(candidate => (
				candidate.receipt.transactionId === transactionId
			));
			if (record === undefined) {
				throw new Error("Repair record does not exist.");
			}
			if (record.receipt.phase !== "committed" || record.healthyProof === null) {
				throw new Error("Only a verified successful repair record may be removed.");
			}
			const retained = record.receipt.artifacts.filter(artifact => artifact.backupRetained);
			const cleanupComplete = retained.length === 0
				? record.backupCleanup.status === "none"
				: record.backupCleanup.status === "deleted" || (
					record.backupCleanup.status === "deleting"
					&& retained.every(artifact => record.backupCleanup.deletedAssetNames.includes(artifact.assetName))
				);
			if (!cleanupComplete) {
				throw new Error("Verified backups must be removed before their repair record.");
			}
			return {
				...current,
				repairRecords: current.repairRecords.filter(candidate => (
					candidate.receipt.transactionId !== transactionId
				)),
			};
		});
		if (!result.ok) {
			throw new Error(result.issue.message);
		}
		this.emit();
	}
}

function exactHealthyMatch(run: IntegrityCheckRun, receipt: RepairReceipt): boolean {
	if (run.status !== "completed" || run.discovery === null || run.remote === null || run.verification === null) {
		return false;
	}
	const local = run.discovery.plugins.find(record => record.pluginId === receipt.pluginId);
	const remote = run.remote.records.find(record => record.pluginId === receipt.pluginId);
	const verification = run.verification.records.find(record => record.pluginId === receipt.pluginId);
	if (
		local?.status !== "discovered"
		|| local.repository === null
		|| !sameRepository(local.repository, receipt.repository)
		|| local.manifest.version !== receipt.manifestVersion
		|| remote?.status !== "resolved"
		|| remote.release.releaseId !== receipt.releaseId
		|| remote.release.tagName !== receipt.releaseTag
		|| !sameRepository(remote.release.repository, receipt.repository)
		|| verification?.outcome !== "evaluated"
		|| verification.status !== "healthy"
		|| verification.result.status !== "healthy"
	) {
		return false;
	}
	return receipt.artifacts.every(receiptArtifact => {
		const artifact = verification.result.artifacts.find(candidate => candidate.assetName === receiptArtifact.assetName);
		const localSizeMatches = artifact?.local.sizeBytes === receiptArtifact.expected.sizeBytes
			|| (
				artifact?.assetName === "main.js"
				&& artifact.acceptedVariant === "obsidian-nosourcemap-suffix"
				&& artifact.local.sizeBytes === receiptArtifact.expected.sizeBytes + OBSIDIAN_NO_SOURCE_MAP_SUFFIX.length
			);
		return artifact?.status === "healthy"
			&& artifact.expected?.sizeBytes === receiptArtifact.expected.sizeBytes
			&& artifact.expected.sha256 === receiptArtifact.expected.sha256
			&& artifact.local.exists === true
			&& localSizeMatches
			&& artifact.local.sha256 === receiptArtifact.expected.sha256;
	});
}

async function recordCandidateHealthyProof(
	journal: PersistentRepairJournal,
	run: IntegrityCheckRun,
	session: AppSessionEvidence,
	candidate: PersistedRepairRecord,
	nowMs = Date.now(),
): Promise<HealthyReconciliationResult> {
	const { sessionId, startedAtMs } = session;
	if (
		candidate.originSessionId === sessionId
		|| !Number.isFinite(startedAtMs)
		|| startedAtMs <= 0
		|| candidate.receipt.finishedAtMs === null
		|| startedAtMs <= candidate.receipt.finishedAtMs
		|| startedAtMs > nowMs
	) {
		const manifestRepaired = candidate.receipt.artifacts.some(artifact => (
			artifact.assetName === "manifest.json"
		));
		return {
			status: "same-session",
			reason: reason(
				"restart-required",
				manifestRepaired
					? "Restart Obsidian before healthy evidence can unlock repair."
					: "Reload or restart Obsidian before healthy evidence can unlock repair.",
			),
		};
	}
	if (!exactHealthyMatch(run, candidate.receipt)) {
		return { status: "no-match", reason: reason("post-restart-proof-mismatch", "The latest integrity check does not exactly match the committed repair receipt.") };
	}
	const proof: PostRestartHealthyProof = {
		sessionId,
		runId: run.runId,
		verifiedAtMs: nowMs,
		releaseId: candidate.receipt.releaseId,
		releaseTag: candidate.receipt.releaseTag,
	};
	try {
		const record = await journal.updateRecord(candidate.receipt.transactionId, current => ({
			...current,
			healthyProof: proof,
			backupCleanup: {
				...current.backupCleanup,
				status: current.receipt.artifacts.some(artifact => artifact.backupRetained)
					? "cleanup-eligible"
					: "none",
				reason: null,
			},
		}));
		return { status: "recorded", record };
	} catch (error) {
		return { status: "persistence-error", reason: reason("healthy-proof-save-error", error instanceof Error ? error.message : "Could not save healthy proof.") };
	}
}

export async function recordPostRestartHealthyProof(
	journal: PersistentRepairJournal,
	run: IntegrityCheckRun,
	session: AppSessionEvidence,
	nowMs = Date.now(),
): Promise<HealthyReconciliationResult> {
	const candidate = journal.getSnapshot().records.find(record => (
		record.receipt.phase === "committed" && record.healthyProof === null
	));
	return candidate === undefined
		? { status: "not-committed", reason: null }
		: recordCandidateHealthyProof(journal, run, session, candidate, nowMs);
}

export async function recordAllPostRestartHealthyProofs(
	journal: PersistentRepairJournal,
	run: IntegrityCheckRun,
	session: AppSessionEvidence,
	nowMs = Date.now(),
): Promise<readonly HealthyReconciliationAttempt[]> {
	const candidates = journal.getSnapshot().records.filter(record => (
		record.receipt.phase === "committed" && record.healthyProof === null
	));
	const attempts: HealthyReconciliationAttempt[] = [];
	for (const candidate of candidates) {
		attempts.push({
			transactionId: candidate.receipt.transactionId,
			pluginId: candidate.receipt.pluginId,
			result: await recordCandidateHealthyProof(
				journal,
				run,
				session,
				candidate,
				nowMs,
			),
		});
	}
	return attempts;
}

function isValidRepairRootPath(path: string): boolean {
	const segments = path.split("/");
	return path.length > 0
		&& !path.includes("\\")
		&& !path.includes("//")
		&& segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..")
		&& (path === "plugins/sync-assets/.repair" || path.endsWith("/plugins/sync-assets/.repair"));
}

function transactionWorkspacePath(repairRootPath: string, transactionId: string): string {
	return `${repairRootPath}/${transactionId}`;
}

function isValidBackupPath(
	record: PersistedRepairRecord,
	assetName: ReleaseAssetName,
	path: string,
	repairRootPath: string,
): boolean {
	return path === `${transactionWorkspacePath(repairRootPath, record.receipt.transactionId)}/backup/${assetName}`;
}

async function cleanupEmptyTransactionDirectories(
	adapter: BackupCleanupAdapter,
	repairRootPath: string,
	transactionId: string,
): Promise<void> {
	const workspacePath = transactionWorkspacePath(repairRootPath, transactionId);
	for (const path of [`${workspacePath}/staged`, `${workspacePath}/backup`, workspacePath]) {
		try {
			await adapter.rmdir(path, false);
		} catch {
			// Never recursively delete a workspace. Non-empty or externally changed
			// directories remain untouched for manual inspection.
		}
	}
}

function problemFromStat(stat: Stat | null, path: string): IntegrityReason | null {
	if (stat === null) {
		return reason("backup-missing", `Verified backup is missing: ${path}`);
	}
	if (stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0) {
		return reason("backup-not-file", `Verified backup is not a regular file: ${path}`);
	}
	return null;
}

export async function deleteVerifiedBackups(
	journal: PersistentRepairJournal,
	transactionId: string,
	adapter: BackupCleanupAdapter,
	repairRootPath: string,
	approved: boolean,
	sha256: Sha256Function = sha256ArrayBuffer,
): Promise<BackupCleanupResult> {
	if (!approved) {
		return { status: "cancelled" };
	}
	if (!isValidRepairRootPath(repairRootPath)) {
		return { status: "blocked", reason: reason("unsafe-repair-root", "The trusted repair workspace root is invalid.") };
	}
	const snapshot = journal.getSnapshot();
	if (!snapshot.usable || snapshot.blockingRecord !== null) {
		return { status: "blocked", reason: reason("repair-journal-open", "Another incomplete repair or cleanup record holds the global mutation lock.") };
	}
	const record = snapshot.records.find(candidate => candidate.receipt.transactionId === transactionId);
	if (
		record === undefined
		|| record.healthyProof === null
		|| record.receipt.phase !== "committed"
		|| !["none", "cleanup-eligible", "deleted"].includes(record.backupCleanup.status)
	) {
		return { status: "blocked", reason: reason("backup-cleanup-not-eligible", "Only a verified successful repair can be removed.") };
	}
	const backups = RELEASE_ASSET_NAMES.flatMap(assetName => {
		const artifact = record.receipt.artifacts.find(candidate => candidate.assetName === assetName && candidate.backupRetained);
		return artifact === undefined ? [] : [artifact];
	});
	if (backups.length === 0 || record.backupCleanup.status === "deleted") {
		try {
			await cleanupEmptyTransactionDirectories(adapter, repairRootPath, transactionId);
			await journal.removeVerifiedRecord(transactionId);
			return { status: "deleted", record };
		} catch (error) {
			return { status: "needs-attention", reason: reason("repair-record-remove-error", error instanceof Error ? error.message : "Could not remove repair history.") };
		}
	}
	for (const artifact of backups) {
		if (
			!isValidBackupPath(record, artifact.assetName, artifact.backupPath, repairRootPath)
			|| artifact.original?.exists !== true
		) {
			return { status: "blocked", reason: reason("unsafe-backup-path", "Backup path or original fingerprint is unsafe.") };
		}
		try {
			const stat = await adapter.stat(artifact.backupPath);
			const statProblem = problemFromStat(stat, artifact.backupPath);
			if (statProblem !== null || stat === null) {
				return { status: "blocked", reason: statProblem ?? reason("backup-stat-error", "Backup stat failed.") };
			}
			if (stat.size !== artifact.original.sizeBytes) {
				return { status: "blocked", reason: reason("backup-size-mismatch", `Backup size changed: ${artifact.backupPath}`) };
			}
			const bytes = await adapter.readBinary(artifact.backupPath);
			if (bytes.byteLength !== stat.size || (await sha256(bytes)).toLowerCase() !== artifact.original.sha256) {
				return { status: "blocked", reason: reason("backup-digest-mismatch", `Backup digest changed: ${artifact.backupPath}`) };
			}
			const finalStat = await adapter.stat(artifact.backupPath);
			if (
				finalStat === null
				|| finalStat.type !== "file"
				|| finalStat.size !== stat.size
				|| finalStat.mtime !== stat.mtime
			) {
				return { status: "blocked", reason: reason("backup-changed-during-verification", `Backup changed while it was verified: ${artifact.backupPath}`) };
			}
		} catch (error) {
			return { status: "blocked", reason: reason("backup-verification-error", error instanceof Error ? error.message : "Could not verify backup.") };
		}
	}
	try {
		await journal.updateRecord(transactionId, current => ({
			...current,
			backupCleanup: { ...current.backupCleanup, status: "deleting", reason: null },
		}));
	} catch (error) {
		return { status: "needs-attention", reason: reason("backup-cleanup-journal-error", error instanceof Error ? error.message : "Could not start backup cleanup journal.") };
	}
	for (const artifact of backups) {
		try {
			await adapter.remove(artifact.backupPath);
			await journal.updateRecord(transactionId, current => ({
				...current,
				backupCleanup: {
					...current.backupCleanup,
					deletedAssetNames: [...current.backupCleanup.deletedAssetNames, artifact.assetName],
				},
			}));
		} catch (error) {
			const cleanupReason = reason("backup-cleanup-partial", error instanceof Error ? error.message : "Backup cleanup stopped after a partial failure.");
			try {
				await journal.updateRecord(transactionId, current => ({
					...current,
					backupCleanup: { ...current.backupCleanup, status: "needs-attention", reason: cleanupReason },
				}));
			} catch {
				// The persisted deleting state already blocks all future repair.
			}
			return { status: "needs-attention", reason: cleanupReason };
		}
	}
	try {
		await cleanupEmptyTransactionDirectories(adapter, repairRootPath, transactionId);
		await journal.removeVerifiedRecord(transactionId);
		return { status: "deleted", record };
	} catch (error) {
		return { status: "needs-attention", reason: reason("backup-cleanup-finalize-error", error instanceof Error ? error.message : "Could not remove repair history after deleting the verified backup.") };
	}
}

export function createSessionId(): string {
	if (window.crypto?.getRandomValues === undefined) {
		throw new Error("Web Crypto random values are unavailable in this runtime.");
	}
	const bytes = new Uint8Array(16);
	window.crypto.getRandomValues(bytes);
	return `session-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
