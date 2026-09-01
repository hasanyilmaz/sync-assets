import type { DataAdapter, Stat } from "obsidian";

import { MAX_MANIFEST_BYTES } from "./local-discovery";
import { validatePluginId } from "./security";

export type PluginDisplayNameAdapter = Pick<DataAdapter, "read" | "stat">;

export interface PluginDisplayNameContext {
	readonly adapter: PluginDisplayNameAdapter;
	readonly configDir: string;
	readonly normalizePath: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readInstalledPluginDisplayName(
	pluginId: string,
	context: PluginDisplayNameContext,
): Promise<string | null> {
	const validatedId = validatePluginId(pluginId, "pluginId");
	if (!validatedId.ok) {
		return null;
	}
	const manifestPath = context.normalizePath(
		`${context.configDir}/plugins/${validatedId.value}/manifest.json`,
	);
	let stat: Stat | null;
	try {
		stat = await context.adapter.stat(manifestPath);
	} catch {
		return null;
	}
	if (
		stat === null
		|| stat.type !== "file"
		|| stat.size < 1
		|| stat.size > MAX_MANIFEST_BYTES
	) {
		return null;
	}
	let raw: string;
	try {
		raw = await context.adapter.read(manifestPath);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (
		!isRecord(parsed)
		|| parsed.id !== validatedId.value
		|| typeof parsed.name !== "string"
		|| parsed.name.trim().length === 0
	) {
		return null;
	}
	return parsed.name;
}
