import {
	RELEASE_ASSET_NAMES,
	type GitHubRepository,
	type IntegrityReason,
	type ReleaseAssetName,
} from "./domain";
import {
	type DiscoveredPluginRecord,
	type LocalDiscoveryResult,
	type LocalPluginRecord,
	MAX_MANIFEST_BYTES,
} from "./local-discovery";
import {
	validatePluginManifest,
	type ValidatedPluginManifest,
} from "./plugin-manifest";
import {
	buildReleaseTagCandidates,
	isReleaseAssetName,
} from "./security";

export const GITHUB_API_VERSION = "2026-03-10";
export const MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const REMOTE_REQUEST_ATTEMPT_TIMEOUT_MS = 8_000;
export const REMOTE_REQUEST_TOTAL_BUDGET_MS = 30_000;
export const REMOTE_REQUEST_RETRY_DELAYS_MS = [3_000, 8_000] as const;

export const REMOTE_FAILURE_KINDS = [
	"connection",
	"timeout",
	"temporary-server",
	"rate-limit",
	"unsupported-response",
	"unexpected",
] as const;

export type RemoteFailureKind = (typeof REMOTE_FAILURE_KINDS)[number];

export interface RemoteHttpRequest {
	readonly url: string;
	readonly method: "GET";
	readonly headers: Readonly<Record<string, string>>;
	readonly throw: false;
}

export interface RemoteHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly arrayBuffer: ArrayBuffer;
	readonly text: string;
}

export type RemoteHttpClient = (
	request: RemoteHttpRequest,
) => Promise<RemoteHttpResponse>;

export interface RemoteResolverContext {
	readonly http: RemoteHttpClient;
	readonly now?: () => number;
	readonly sleep?: (delayMs: number) => Promise<void>;
	readonly runWithTimeout?: <T>(operation: () => Promise<T>, timeoutMs: number) => Promise<T>;
}

export interface RateLimitSnapshot {
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly resetAtMs: number | null;
	readonly retryAtMs: number | null;
}

export interface TrustedReleaseAsset {
	readonly assetId: number;
	readonly assetName: ReleaseAssetName;
	readonly sizeBytes: number;
	readonly sha256: string;
	readonly downloadUrl: string;
}

export interface TrustedRemoteRelease {
	readonly repository: GitHubRepository;
	readonly releaseId: number;
	readonly tagName: string;
	readonly publishedAt: string;
	readonly assets: readonly TrustedReleaseAsset[];
	readonly manifest: ValidatedPluginManifest;
	readonly manifestBytes: ArrayBuffer;
}

interface RemoteResolutionRecordBase {
	readonly pluginId: string;
	readonly repository: GitHubRepository | null;
	readonly manifestVersion: string | null;
	readonly requestCount: number;
	readonly rateLimit: RateLimitSnapshot | null;
}

export interface ResolvedRemoteRecord extends RemoteResolutionRecordBase {
	readonly status: "resolved";
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly release: TrustedRemoteRelease;
	readonly reason: null;
	readonly retryAtMs: null;
}

export interface UnresolvedRemoteRecord extends RemoteResolutionRecordBase {
	readonly status: "unsupported" | "unverifiable" | "error" | "deferred";
	readonly repository: GitHubRepository;
	readonly manifestVersion: string;
	readonly release: null;
	readonly reason: IntegrityReason;
	readonly retryAtMs: number | null;
	readonly failureKind?: RemoteFailureKind;
	readonly technicalMessage?: string | null;
}

export interface SkippedRemoteRecord extends RemoteResolutionRecordBase {
	readonly status: "skipped";
	readonly release: null;
	readonly reason: IntegrityReason;
	readonly retryAtMs: null;
}

export type RemoteResolutionRecord =
	| ResolvedRemoteRecord
	| UnresolvedRemoteRecord
	| SkippedRemoteRecord;

export interface RemoteResolutionBatch {
	readonly status: "completed" | "partial" | "error";
	readonly records: readonly RemoteResolutionRecord[];
	readonly requestCount: number;
	readonly rateLimit: RateLimitSnapshot | null;
	readonly reason: IntegrityReason | null;
}

interface ResolverState {
	requestCount: number;
	rateLimit: RateLimitSnapshot | null;
	rateLimitExhausted: boolean;
	retryAtMs: number | null;
	availabilityFailure: AvailabilityFailure | null;
}

interface AvailabilityFailure {
	readonly kind: "connection" | "timeout" | "temporary-server";
	readonly reason: IntegrityReason;
	readonly technicalMessage: string | null;
}

type RemoteRequestAttemptResult =
	| { readonly ok: true; readonly response: RemoteHttpResponse }
	| { readonly ok: false; readonly failure: AvailabilityFailure };

export class RemoteRequestTimeoutError extends Error {
	constructor() {
		super("The remote request exceeded its time limit.");
		this.name = "RemoteRequestTimeoutError";
	}
}

interface ReleaseMetadata {
	readonly repository: GitHubRepository;
	readonly releaseId: number;
	readonly tagName: string;
	readonly publishedAt: string;
	readonly assets: readonly TrustedReleaseAsset[];
}

type ReleaseMetadataResult =
	| { readonly ok: true; readonly metadata: ReleaseMetadata }
	| {
		readonly ok: false;
		readonly status: "unsupported" | "unverifiable";
		readonly reason: IntegrityReason;
	};

type ManifestDownloadResult =
	| {
		readonly ok: true;
		readonly manifest: ValidatedPluginManifest;
		readonly bytes: ArrayBuffer;
	}
	| {
		readonly ok: false;
		readonly status: "unverifiable" | "error";
		readonly reason: IntegrityReason;
		readonly failureKind?: RemoteFailureKind;
		readonly technicalMessage?: string | null;
	};

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown network error.";
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise(resolve => {
		window.setTimeout(resolve, delayMs);
	});
}

function defaultRunWithTimeout<T>(
	operation: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			reject(new RemoteRequestTimeoutError());
		}, timeoutMs);
		void operation().then(resolve, reject).finally(() => {
			window.clearTimeout(timeoutId);
		});
	});
}

function availabilityFailure(
	kind: AvailabilityFailure["kind"],
	technicalMessage: string | null,
): AvailabilityFailure {
	if (kind === "timeout") {
		return {
			kind,
			reason: reason(
				"github-request-timeout",
				"GitHub did not respond in time, so this plugin was not checked. Try again when your connection is stable.",
			),
			technicalMessage,
		};
	}
	if (kind === "temporary-server") {
		return {
			kind,
			reason: reason(
				"github-temporary-server-error",
				"GitHub is temporarily unavailable, so this plugin was not checked. Try again later.",
			),
			technicalMessage,
		};
	}
	return {
		kind,
		reason: reason(
			"github-connection-unavailable",
			"Sync Assets couldn't reach GitHub, so this plugin was not checked. Check your internet connection, VPN, or Private DNS, then try again.",
		),
		technicalMessage,
	};
}

function isRetryableHttpStatus(status: number): boolean {
	return [408, 425, 500, 502, 503, 504].includes(status);
}

async function requestWithRetry(
	request: RemoteHttpRequest,
	context: RemoteResolverContext,
	state: ResolverState,
): Promise<RemoteRequestAttemptResult> {
	const now = context.now ?? Date.now;
	const sleep = context.sleep ?? defaultSleep;
	const runWithTimeout = context.runWithTimeout ?? defaultRunWithTimeout;
	const deadlineMs = now() + REMOTE_REQUEST_TOTAL_BUDGET_MS;
	let latestFailure = availabilityFailure("connection", null);

	for (let attempt = 0; attempt <= REMOTE_REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
		const remainingMs = deadlineMs - now();
		if (remainingMs <= 0) {
			return { ok: false, failure: latestFailure };
		}
		state.requestCount += 1;
		try {
			const response = await runWithTimeout(
				() => context.http(request),
				Math.min(REMOTE_REQUEST_ATTEMPT_TIMEOUT_MS, remainingMs),
			);
			if (!isRetryableHttpStatus(response.status)) {
				return { ok: true, response };
			}
			latestFailure = availabilityFailure(
				"temporary-server",
				`GitHub request returned HTTP ${response.status}.`,
			);
		} catch (error) {
			latestFailure = error instanceof RemoteRequestTimeoutError
				? availabilityFailure("timeout", getErrorMessage(error))
				: availabilityFailure("connection", getErrorMessage(error));
		}

		const delayMs = REMOTE_REQUEST_RETRY_DELAYS_MS[attempt];
		if (delayMs === undefined || now() + delayMs >= deadlineMs) {
			return { ok: false, failure: latestFailure };
		}
		await sleep(delayMs);
	}

	return { ok: false, failure: latestFailure };
}

function getHeader(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | null {
	const normalizedName = name.toLowerCase();
	for (const [headerName, value] of Object.entries(headers)) {
		if (headerName.toLowerCase() === normalizedName) {
			return value;
		}
	}
	return null;
}

function parseNonNegativeInteger(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) {
		return null;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRetryAtMs(value: string | null, nowMs: number): number | null {
	if (value === null) {
		return null;
	}
	if (/^\d+$/.test(value)) {
		const seconds = Number(value);
		return Number.isSafeInteger(seconds) ? nowMs + (seconds * 1000) : null;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function extractRateLimit(
	response: RemoteHttpResponse,
	nowMs: number,
): RateLimitSnapshot | null {
	const limit = parseNonNegativeInteger(getHeader(response.headers, "x-ratelimit-limit"));
	const remaining = parseNonNegativeInteger(getHeader(response.headers, "x-ratelimit-remaining"));
	const resetSeconds = parseNonNegativeInteger(getHeader(response.headers, "x-ratelimit-reset"));
	const resetAtMs = resetSeconds === null ? null : resetSeconds * 1000;
	const retryAfterMs = parseRetryAtMs(getHeader(response.headers, "retry-after"), nowMs);
	const retryAtMs = retryAfterMs ?? resetAtMs;

	if (
		limit === null
		&& remaining === null
		&& resetAtMs === null
		&& retryAtMs === null
	) {
		return null;
	}

	return { limit, remaining, resetAtMs, retryAtMs };
}

function updateRateLimitState(
	state: ResolverState,
	response: RemoteHttpResponse,
	nowMs: number,
): RateLimitSnapshot | null {
	const snapshot = extractRateLimit(response, nowMs);
	if (snapshot !== null) {
		state.rateLimit = snapshot;
		if (snapshot.remaining === 0) {
			state.rateLimitExhausted = true;
			state.retryAtMs = snapshot.retryAtMs;
		}
	}
	return snapshot;
}

function isRateLimitedResponse(
	response: RemoteHttpResponse,
	snapshot: RateLimitSnapshot | null,
): boolean {
	return response.status === 429 || (
		response.status === 403
		&& snapshot !== null
		&& (snapshot.remaining === 0 || snapshot.retryAtMs !== null)
	);
}

function apiRequest(repository: GitHubRepository, tagName: string): RemoteHttpRequest {
	const owner = encodeURIComponent(repository.owner);
	const repo = encodeURIComponent(repository.repo);
	const tag = encodeURIComponent(tagName);
	return {
		url: `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
		method: "GET",
		throw: false,
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "Sync-Assets-Obsidian",
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
		},
	};
}

function assetRequest(downloadUrl: string): RemoteHttpRequest {
	return {
		url: downloadUrl,
		method: "GET",
		throw: false,
		headers: {
			Accept: "application/octet-stream",
			"User-Agent": "Sync-Assets-Obsidian",
		},
	};
}

function parseJsonResponse(
	response: RemoteHttpResponse,
	maximumBytes: number,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: IntegrityReason } {
	if (response.arrayBuffer.byteLength > maximumBytes) {
		return {
			ok: false,
			reason: reason("response-too-large", `Response exceeds the ${maximumBytes}-byte safety limit.`),
		};
	}

	try {
		return { ok: true, value: JSON.parse(response.text) as unknown };
	} catch {
		return {
			ok: false,
			reason: reason("response-invalid-json", "Response contains invalid JSON."),
		};
	}
}

export function isTrustedReleaseAssetDownloadUrl(
	value: string,
	repository: GitHubRepository,
	tagName: string,
	assetName: ReleaseAssetName,
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}

	if (
		parsed.protocol !== "https:"
		|| parsed.hostname !== "github.com"
		|| parsed.port !== ""
		|| parsed.username !== ""
		|| parsed.password !== ""
		|| parsed.search !== ""
		|| parsed.hash !== ""
	) {
		return false;
	}

	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(parsed.pathname);
	} catch {
		return false;
	}
	const segments = decodedPath.split("/");
	return segments.length === 7
		&& segments[1]?.toLowerCase() === repository.owner.toLowerCase()
		&& segments[2]?.toLowerCase() === repository.repo.toLowerCase()
		&& segments[3] === "releases"
		&& segments[4] === "download"
		&& segments[5] === tagName
		&& segments[6] === assetName;
}

function validateReleaseAsset(
	value: Record<string, unknown>,
	assetName: ReleaseAssetName,
	repository: GitHubRepository,
	tagName: string,
): { readonly ok: true; readonly asset: TrustedReleaseAsset } | { readonly ok: false; readonly reason: IntegrityReason } {
	if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
		return { ok: false, reason: reason("invalid-asset-id", `Release asset ${assetName} has an invalid ID.`) };
	}
	if (value.state !== "uploaded") {
		return { ok: false, reason: reason("asset-not-uploaded", `Release asset ${assetName} is not uploaded.`) };
	}
	if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
		return { ok: false, reason: reason("invalid-asset-size", `Release asset ${assetName} has an invalid size.`) };
	}
	if (
		(assetName === "main.js" || assetName === "manifest.json")
		&& (value.size as number) === 0
	) {
		return { ok: false, reason: reason("empty-required-asset", `Required release asset ${assetName} is empty.`) };
	}
	if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.digest)) {
		return { ok: false, reason: reason("invalid-asset-digest", `Release asset ${assetName} lacks a valid SHA-256 digest.`) };
	}
	if (
		typeof value.browser_download_url !== "string"
		|| !isTrustedReleaseAssetDownloadUrl(
			value.browser_download_url,
			repository,
			tagName,
			assetName,
		)
	) {
		return { ok: false, reason: reason("invalid-asset-download-url", `Release asset ${assetName} has an untrusted download URL.`) };
	}

	return {
		ok: true,
		asset: {
			assetId: value.id as number,
			assetName,
			sizeBytes: value.size as number,
			sha256: value.digest.toLowerCase(),
			downloadUrl: value.browser_download_url,
		},
	};
}

function parseReleaseMetadata(
	value: unknown,
	repository: GitHubRepository,
	requestedTag: string,
): ReleaseMetadataResult {
	if (!isRecord(value)) {
		return { ok: false, status: "unverifiable", reason: reason("invalid-release-response", "Release response must be an object.") };
	}
	if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
		return { ok: false, status: "unverifiable", reason: reason("invalid-release-id", "Release response has an invalid ID.") };
	}
	if (value.tag_name !== requestedTag) {
		return { ok: false, status: "unverifiable", reason: reason("release-tag-mismatch", "Release tag does not exactly match the requested tag.") };
	}
	if (value.draft !== false) {
		return { ok: false, status: "unsupported", reason: reason("draft-release-unsupported", "Draft releases are not supported.") };
	}
	if (value.prerelease !== false) {
		return { ok: false, status: "unsupported", reason: reason("prerelease-unsupported", "Prereleases are not supported.") };
	}
	if (
		typeof value.published_at !== "string"
		|| Number.isNaN(Date.parse(value.published_at))
	) {
		return { ok: false, status: "unverifiable", reason: reason("invalid-release-published-at", "Release response has an invalid publication time.") };
	}
	if (!Array.isArray(value.assets)) {
		return { ok: false, status: "unverifiable", reason: reason("invalid-release-assets", "Release response assets must be an array.") };
	}

	const trustedAssets = new Map<ReleaseAssetName, TrustedReleaseAsset>();
	for (const rawAsset of value.assets) {
		if (!isRecord(rawAsset) || typeof rawAsset.name !== "string") {
			continue;
		}
		if (!isReleaseAssetName(rawAsset.name)) {
			continue;
		}
		if (trustedAssets.has(rawAsset.name)) {
			return {
				ok: false,
				status: "unverifiable",
				reason: reason("duplicate-release-asset", `Release contains duplicate ${rawAsset.name} assets.`),
			};
		}

		const assetResult = validateReleaseAsset(
			rawAsset,
			rawAsset.name,
			repository,
			requestedTag,
		);
		if (!assetResult.ok) {
			return { ok: false, status: "unverifiable", reason: assetResult.reason };
		}
		trustedAssets.set(rawAsset.name, assetResult.asset);
	}

	for (const requiredAsset of ["main.js", "manifest.json"] as const) {
		if (!trustedAssets.has(requiredAsset)) {
			return {
				ok: false,
				status: "unsupported",
				reason: reason("required-release-asset-missing", `Release does not contain ${requiredAsset}.`),
			};
		}
	}

	return {
		ok: true,
		metadata: {
			repository,
			releaseId: value.id as number,
			tagName: requestedTag,
			publishedAt: value.published_at,
			assets: RELEASE_ASSET_NAMES.flatMap(assetName => {
				const asset = trustedAssets.get(assetName);
				return asset === undefined ? [] : [asset];
			}),
		},
	};
}

async function downloadRemoteManifest(
	target: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	metadata: ReleaseMetadata,
	context: RemoteResolverContext,
	state: ResolverState,
): Promise<ManifestDownloadResult> {
	const manifestAsset = metadata.assets.find(asset => asset.assetName === "manifest.json");
	if (
		manifestAsset === undefined
		|| manifestAsset.sizeBytes < 1
		|| manifestAsset.sizeBytes > MAX_MANIFEST_BYTES
	) {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason(
				"remote-manifest-size-out-of-range",
				`Remote manifest must be between 1 and ${MAX_MANIFEST_BYTES} bytes.`,
			),
		};
	}

	const attempted = await requestWithRetry(
		assetRequest(manifestAsset.downloadUrl),
		context,
		state,
	);
	if (!attempted.ok) {
		state.availabilityFailure = attempted.failure;
		return {
			ok: false,
			status: "error",
			reason: attempted.failure.reason,
			failureKind: attempted.failure.kind,
			technicalMessage: attempted.failure.technicalMessage,
		};
	}
	const { response } = attempted;

	if (response.status !== 200) {
		return {
			ok: false,
			status: "error",
			reason: reason("remote-manifest-http-error", `Remote manifest request returned HTTP ${response.status}.`),
		};
	}
	if (response.arrayBuffer.byteLength !== manifestAsset.sizeBytes) {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("remote-manifest-size-mismatch", "Remote manifest byte length does not match release metadata."),
		};
	}

	let decodedManifest: string;
	try {
		decodedManifest = new TextDecoder("utf-8", { fatal: true }).decode(response.arrayBuffer);
	} catch {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("remote-manifest-invalid-utf8", "Remote manifest is not valid UTF-8."),
		};
	}

	let parsedManifest: unknown;
	try {
		parsedManifest = JSON.parse(decodedManifest) as unknown;
	} catch {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("remote-manifest-invalid-json", "Remote manifest contains invalid JSON."),
		};
	}

	const validation = validatePluginManifest(parsedManifest, {
		expectedPluginId: target.pluginId,
		idMismatchCode: "remote-manifest-id-mismatch",
		idMismatchMessage: "Remote manifest plugin ID does not match the local target.",
	});
	if (!validation.ok) {
		return { ok: false, status: "unverifiable", reason: validation.reason };
	}
	if (validation.manifest.version !== target.manifest.version) {
		return {
			ok: false,
			status: "unverifiable",
			reason: reason("remote-manifest-version-mismatch", "Remote manifest version does not match the local manifest version."),
		};
	}

	return {
		ok: true,
		manifest: validation.manifest,
		bytes: response.arrayBuffer.slice(0),
	};
}

function recordBase(
	target: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	state: ResolverState,
	requestCount: number,
): Pick<UnresolvedRemoteRecord, "pluginId" | "repository" | "manifestVersion" | "requestCount" | "rateLimit"> {
	return {
		pluginId: target.pluginId,
		repository: target.repository,
		manifestVersion: target.manifest.version,
		requestCount,
		rateLimit: state.rateLimit,
	};
}

function deferredRecord(
	target: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	state: ResolverState,
	requestCount: number,
): UnresolvedRemoteRecord {
	return {
		...recordBase(target, state, requestCount),
		status: "deferred",
		release: null,
		reason: reason("github-rate-limit-exhausted", "GitHub rate limit is exhausted; no automatic retry was scheduled."),
		retryAtMs: state.retryAtMs,
		failureKind: "rate-limit",
		technicalMessage: null,
	};
}

function availabilityDeferredRecord(
	target: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	state: ResolverState,
): UnresolvedRemoteRecord {
	const failure = state.availabilityFailure;
	if (failure === null) {
		throw new Error("Availability circuit breaker has no failure.");
	}
	return {
		...recordBase(target, state, 0),
		status: "deferred",
		release: null,
		reason: failure.reason,
		retryAtMs: null,
		failureKind: failure.kind,
		technicalMessage: failure.technicalMessage,
	};
}

async function resolveTarget(
	target: DiscoveredPluginRecord & { readonly repository: GitHubRepository },
	context: RemoteResolverContext,
	state: ResolverState,
): Promise<ResolvedRemoteRecord | UnresolvedRemoteRecord> {
	const startRequestCount = state.requestCount;
	const candidatesResult = buildReleaseTagCandidates(target.manifest.version);
	if (!candidatesResult.ok) {
		return {
			...recordBase(target, state, 0),
			status: "unverifiable",
			release: null,
			reason: reason("invalid-local-manifest-version", "Local manifest version cannot produce exact release tags."),
			retryAtMs: null,
		};
	}

	for (const [candidateIndex, tagName] of candidatesResult.value.entries()) {
		const attempted = await requestWithRetry(
			apiRequest(target.repository, tagName),
			context,
			state,
		);
		if (!attempted.ok) {
			state.availabilityFailure = attempted.failure;
			return {
				...recordBase(target, state, state.requestCount - startRequestCount),
				status: "error",
				release: null,
				reason: attempted.failure.reason,
				retryAtMs: null,
				failureKind: attempted.failure.kind,
				technicalMessage: attempted.failure.technicalMessage,
			};
		}
		const { response } = attempted;

		const snapshot = updateRateLimitState(
			state,
			response,
			(context.now ?? Date.now)(),
		);
		if (isRateLimitedResponse(response, snapshot)) {
			state.rateLimitExhausted = true;
			state.retryAtMs = snapshot?.retryAtMs ?? null;
			return deferredRecord(
				target,
				state,
				state.requestCount - startRequestCount,
			);
		}

		if (response.status === 404) {
			if (state.rateLimitExhausted) {
				return deferredRecord(
					target,
					state,
					state.requestCount - startRequestCount,
				);
			}
			if (candidateIndex === candidatesResult.value.length - 1) {
				return {
					...recordBase(target, state, state.requestCount - startRequestCount),
					status: "unsupported",
					release: null,
					reason: reason("exact-release-not-found", "Neither exact release tag exists in the configured repository."),
					retryAtMs: null,
				};
			}
			continue;
		}

		if (response.status !== 200) {
			return {
				...recordBase(target, state, state.requestCount - startRequestCount),
				status: "error",
				release: null,
				reason: reason("github-http-error", `GitHub release request returned HTTP ${response.status}.`),
				retryAtMs: null,
				failureKind: "unexpected",
				technicalMessage: `GitHub request returned HTTP ${response.status}.`,
			};
		}

		const parsedResponse = parseJsonResponse(response, MAX_RELEASE_RESPONSE_BYTES);
		if (!parsedResponse.ok) {
			return {
				...recordBase(target, state, state.requestCount - startRequestCount),
				status: "unverifiable",
				release: null,
				reason: parsedResponse.reason,
				retryAtMs: null,
				failureKind: "unsupported-response",
				technicalMessage: null,
			};
		}

		const metadataResult = parseReleaseMetadata(
			parsedResponse.value,
			target.repository,
			tagName,
		);
		if (!metadataResult.ok) {
			return {
				...recordBase(target, state, state.requestCount - startRequestCount),
				status: metadataResult.status,
				release: null,
				reason: metadataResult.reason,
				retryAtMs: null,
				failureKind: "unsupported-response",
				technicalMessage: null,
			};
		}

		const manifestResult = await downloadRemoteManifest(
			target,
			metadataResult.metadata,
			context,
			state,
		);
		if (!manifestResult.ok) {
			return {
				...recordBase(target, state, state.requestCount - startRequestCount),
				status: manifestResult.status,
				release: null,
				reason: manifestResult.reason,
				retryAtMs: null,
				failureKind: manifestResult.failureKind ?? "unsupported-response",
				technicalMessage: manifestResult.technicalMessage ?? null,
			};
		}

		return {
			...recordBase(target, state, state.requestCount - startRequestCount),
			status: "resolved",
				release: {
					...metadataResult.metadata,
					manifest: manifestResult.manifest,
					manifestBytes: manifestResult.bytes,
				},
			reason: null,
			retryAtMs: null,
		};
	}

	return {
		...recordBase(target, state, state.requestCount - startRequestCount),
		status: "unsupported",
		release: null,
		reason: reason("exact-release-not-found", "Exact release was not found."),
		retryAtMs: null,
	};
}

function skippedRecord(plugin: LocalPluginRecord): SkippedRemoteRecord {
	const manifestVersion = plugin.status === "discovered"
		? plugin.manifest.version
		: null;
	const skipReason = plugin.status === "discovered"
		? reason("repository-not-configured", "Plugin has no trusted GitHub repository mapping.")
		: reason(`local-${plugin.status}`, "Plugin is not eligible for remote resolution because local discovery did not succeed.");

	return {
		status: "skipped",
		pluginId: plugin.pluginId,
		repository: plugin.repository,
		manifestVersion,
		requestCount: 0,
		rateLimit: null,
		release: null,
		reason: skipReason,
		retryAtMs: null,
	};
}

function isEligibleTarget(
	plugin: LocalPluginRecord,
): plugin is DiscoveredPluginRecord & { readonly repository: GitHubRepository } {
	return plugin.status === "discovered" && plugin.repository !== null;
}

export async function resolveRemoteReleases(
	discovery: LocalDiscoveryResult,
	context: RemoteResolverContext,
): Promise<RemoteResolutionBatch> {
	if (discovery.status === "error") {
		return {
			status: "error",
			records: discovery.plugins.map(skippedRecord),
			requestCount: 0,
			rateLimit: null,
			reason: reason("local-discovery-error", "Remote resolution requires a completed local discovery result."),
		};
	}

	const state: ResolverState = {
		requestCount: 0,
		rateLimit: null,
		rateLimitExhausted: false,
		retryAtMs: null,
		availabilityFailure: null,
	};
	const records: RemoteResolutionRecord[] = [];
	const sortedPlugins = [...discovery.plugins]
		.sort((left, right) => left.pluginId.localeCompare(right.pluginId));

	for (const plugin of sortedPlugins) {
		if (!isEligibleTarget(plugin)) {
			records.push(skippedRecord(plugin));
			continue;
		}
		if (state.availabilityFailure !== null) {
			records.push(availabilityDeferredRecord(plugin, state));
			continue;
		}
		if (state.rateLimitExhausted) {
			records.push(deferredRecord(plugin, state, 0));
			continue;
		}

		records.push(await resolveTarget(plugin, context, state));
	}

	const hasPartialResult = records.some(record => (
		record.status === "error" || record.status === "deferred"
	));
	return {
		status: hasPartialResult ? "partial" : "completed",
		records,
		requestCount: state.requestCount,
		rateLimit: state.rateLimit,
		reason: null,
	};
}
