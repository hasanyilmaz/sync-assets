import type { DataAdapter, Stat } from "obsidian";

import { RELEASE_ASSET_NAMES } from "./domain";
import { MAX_MANIFEST_BYTES } from "./local-discovery";
import { validatePluginId } from "./security";
import type { SyncAssetsSettings } from "./settings";

export type LocalFollowUpProbeAdapter = Pick<DataAdapter, "read" | "stat">;

export interface LocalFollowUpProbeContext {
	readonly adapter: LocalFollowUpProbeAdapter;
	readonly configDir: string;
	readonly normalizePath: (path: string) => string;
}

function statFingerprint(stat: Stat | null): string {
	return stat === null
		? "missing"
		: `${stat.type}:${stat.size}:${stat.mtime}`;
}

export async function probeMonitoredLocalAssets(
	settings: SyncAssetsSettings,
	context: LocalFollowUpProbeContext,
): Promise<string | null> {
	const rows: string[] = [];
	for (const mapping of [...settings.repositories].sort((left, right) => (
		left.pluginId.localeCompare(right.pluginId)
	))) {
		const pluginId = validatePluginId(mapping.pluginId, "pluginId");
		if (!pluginId.ok) {
			return null;
		}
		const pluginPath = context.normalizePath(`${context.configDir}/plugins/${pluginId.value}`);
		for (const assetName of RELEASE_ASSET_NAMES) {
			const path = context.normalizePath(`${pluginPath}/${assetName}`);
			let stat: Stat | null;
			try {
				stat = await context.adapter.stat(path);
			} catch {
				return null;
			}
			rows.push(`${pluginId.value}:${assetName}:${statFingerprint(stat)}`);
			if (
				assetName === "manifest.json"
				&& stat?.type === "file"
				&& stat.size >= 1
				&& stat.size <= MAX_MANIFEST_BYTES
			) {
				try {
					rows.push(`manifest:${await context.adapter.read(path)}`);
				} catch {
					return null;
				}
			}
		}
	}
	return JSON.stringify(rows);
}
