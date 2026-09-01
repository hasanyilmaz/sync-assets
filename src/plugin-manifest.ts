import type { IntegrityReason } from "./domain";
import {
	buildReleaseTagCandidates,
	validatePluginId,
} from "./security";

export interface ValidatedPluginManifest {
	readonly id: string;
	readonly name: string;
	readonly author: string;
	readonly version: string;
	readonly minAppVersion: string;
	readonly description: string;
	readonly authorUrl?: string;
	readonly isDesktopOnly: boolean;
}

export type PluginManifestValidationResult =
	| {
		readonly ok: true;
		readonly manifest: ValidatedPluginManifest;
	}
	| {
		readonly ok: false;
		readonly reason: IntegrityReason;
	};

export interface PluginManifestValidationOptions {
	readonly expectedPluginId: string;
	readonly idMismatchCode: string;
	readonly idMismatchMessage: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequiredString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function reason(code: string, message: string): IntegrityReason {
	return { code, message };
}

export function validatePluginManifest(
	value: unknown,
	options: PluginManifestValidationOptions,
): PluginManifestValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: reason("manifest-not-object", "Manifest JSON must contain an object."),
		};
	}

	const requiredFields = [
		"id",
		"name",
		"author",
		"version",
		"minAppVersion",
	] as const;
	for (const field of requiredFields) {
		if (!isRequiredString(value[field])) {
			return {
				ok: false,
				reason: reason(
					"invalid-manifest-field",
					`Manifest field ${field} must be a non-empty string.`,
				),
			};
		}
	}

	if (typeof value.description !== "string") {
		return {
			ok: false,
			reason: reason(
				"invalid-manifest-field",
				"Manifest field description must be a string.",
			),
		};
	}

	if (value.authorUrl !== undefined && typeof value.authorUrl !== "string") {
		return {
			ok: false,
			reason: reason(
				"invalid-manifest-field",
				"Optional manifest field authorUrl must be a string.",
			),
		};
	}

	if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== "boolean") {
		return {
			ok: false,
			reason: reason(
				"invalid-manifest-field",
				"Optional manifest field isDesktopOnly must be a boolean.",
			),
		};
	}

	const pluginIdResult = validatePluginId(value.id, "manifest.id");
	if (!pluginIdResult.ok) {
		return {
			ok: false,
			reason: reason(
				"invalid-manifest-id",
				pluginIdResult.issues[0]?.message ?? "Invalid plugin ID.",
			),
		};
	}

	if (pluginIdResult.value !== options.expectedPluginId) {
		return {
			ok: false,
			reason: reason(options.idMismatchCode, options.idMismatchMessage),
		};
	}

	const versionResult = buildReleaseTagCandidates(value.version, "manifest.version");
	if (!versionResult.ok) {
		return {
			ok: false,
			reason: reason(
				"invalid-manifest-version",
				versionResult.issues[0]?.message ?? "Invalid version.",
			),
		};
	}

	const manifest: ValidatedPluginManifest = {
		id: pluginIdResult.value,
		name: value.name as string,
		author: value.author as string,
		version: value.version as string,
		minAppVersion: value.minAppVersion as string,
		description: value.description,
		isDesktopOnly: value.isDesktopOnly ?? false,
	};
	if (typeof value.authorUrl === "string") {
		return {
			ok: true,
			manifest: { ...manifest, authorUrl: value.authorUrl },
		};
	}

	return { ok: true, manifest };
}
