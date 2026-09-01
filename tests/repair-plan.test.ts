import { describe, expect, it } from "vitest";

import type { IntegrityCheckRun } from "../src/check-coordinator";
import { MAX_HASHABLE_ARTIFACT_BYTES } from "../src/integrity-verification";
import { createRepairPlan } from "../src/repair-plan";
import {
	createRepairFixture,
	PLUGIN_ID,
	TRANSACTION_ID,
} from "./repair-fixtures";

const context = {
	transactionId: TRANSACTION_ID,
	ownPluginId: "sync-assets",
	normalizePath: (path: string): string => path.replaceAll("//", "/"),
};

describe("repair plan", () => {
	it("accepts complete startup evidence for the same explicit repair plan", async () => {
		const fixture = await createRepairFixture();
		const planned = createRepairPlan(
			{ ...fixture.run, trigger: "startup" },
			PLUGIN_ID,
			context,
		);
		expect(planned.ok).toBe(true);
		if (planned.ok) {
			expect(planned.plan.runId).toBe(fixture.run.runId);
			expect(planned.plan.pluginId).toBe(PLUGIN_ID);
			expect(planned.plan.pluginName).toBe("Example Plugin");
		}
	});

	it("builds one deterministic all-artifact plan from correlated Stage 5 evidence", async () => {
		const fixture = await createRepairFixture();
		const planned = createRepairPlan(fixture.run, PLUGIN_ID, context);

		expect(planned.ok).toBe(true);
		if (!planned.ok) {
			return;
		}
		expect(planned.plan).toEqual(expect.objectContaining({
			transactionId: TRANSACTION_ID,
			runId: 9,
			pluginId: PLUGIN_ID,
			pluginName: "Example Plugin",
			manifestVersion: "1.2.3",
			releaseId: 44,
			releaseTag: "1.2.3",
			workspacePath: `.obsidian/plugins/sync-assets/.repair/${TRANSACTION_ID}`,
		}));
		expect(planned.plan.artifacts.map(artifact => artifact.assetName)).toEqual([
			"main.js",
			"styles.css",
			"manifest.json",
		]);
		expect(planned.plan.artifacts.find(artifact => artifact.assetName === "manifest.json")?.downloadUrl).toBeNull();
		expect(planned.plan.fingerprint).toContain("repair-plan-v1");
		expect(planned.plan.remoteManifestBytes).not.toBe(
			fixture.run.remote?.records[0]?.status === "resolved"
				? fixture.run.remote.records[0].release.manifestBytes
				: null,
		);
	});

	it("rejects incomplete runs and duplicate or mismatched record sets", async () => {
		const fixture = await createRepairFixture();
		const failedRun: IntegrityCheckRun = { ...fixture.run, status: "failed" };
		const duplicateRun: IntegrityCheckRun = {
			...fixture.run,
			discovery: fixture.run.discovery === null
				? null
				: {
					...fixture.run.discovery,
					plugins: [
						...fixture.run.discovery.plugins,
						fixture.run.discovery.plugins[0]!,
					],
				},
		};
		const missingRemoteRun: IntegrityCheckRun = {
			...fixture.run,
			remote: fixture.run.remote === null
				? null
				: { ...fixture.run.remote, records: [] },
		};

		expect(createRepairPlan(failedRun, PLUGIN_ID, context)).toEqual(expect.objectContaining({ ok: false }));
		const duplicate = createRepairPlan(duplicateRun, PLUGIN_ID, context);
		const missingRemote = createRepairPlan(missingRemoteRun, PLUGIN_ID, context);
		expect(duplicate.ok).toBe(false);
		expect(missingRemote.ok).toBe(false);
		if (!duplicate.ok && !missingRemote.ok) {
			expect(duplicate.reason.code).toBe("repair-duplicate-record");
			expect(missingRemote.reason.code).toBe("repair-record-set-mismatch");
		}
	});

	it("rejects unsafe target paths, wrong release identity, and untrusted URLs", async () => {
		const fixture = await createRepairFixture();
		const plugin = fixture.run.discovery?.plugins[0];
		const remote = fixture.run.remote?.records[0];
		expect(plugin?.status).toBe("discovered");
		expect(remote?.status).toBe("resolved");
		if (plugin?.status !== "discovered" || remote?.status !== "resolved") {
			return;
		}
		const unsafePathRun: IntegrityCheckRun = {
			...fixture.run,
			discovery: {
				...fixture.run.discovery!,
				plugins: [{ ...plugin, pluginPath: ".obsidian/plugins/other" }],
			},
		};
		const wrongTagRun: IntegrityCheckRun = {
			...fixture.run,
			remote: {
				...fixture.run.remote!,
				records: [{
					...remote,
					release: { ...remote.release, tagName: "latest" },
				}],
			},
		};
		const untrustedUrlRun: IntegrityCheckRun = {
			...fixture.run,
			remote: {
				...fixture.run.remote!,
				records: [{
					...remote,
					release: {
						...remote.release,
						assets: remote.release.assets.map(asset => (
							asset.assetName === "main.js"
								? { ...asset, downloadUrl: "https://evil.example/main.js" }
								: asset
						)),
					},
				}],
			},
		};

		const unsafePath = createRepairPlan(unsafePathRun, PLUGIN_ID, context);
		const wrongTag = createRepairPlan(wrongTagRun, PLUGIN_ID, context);
		const untrustedUrl = createRepairPlan(untrustedUrlRun, PLUGIN_ID, context);
		expect(unsafePath.ok).toBe(false);
		expect(wrongTag.ok).toBe(false);
		expect(untrustedUrl.ok).toBe(false);
		if (!unsafePath.ok && !wrongTag.ok && !untrustedUrl.ok) {
			expect(unsafePath.reason.code).toBe("repair-local-target-mismatch");
			expect(wrongTag.reason.code).toBe("repair-release-identity-mismatch");
			expect(untrustedUrl.reason.code).toBe("repair-untrusted-download-url");
		}
	});

	it("rejects non-repairable evidence, Sync Assets itself, and unsafe transaction IDs", async () => {
		const fixture = await createRepairFixture();
		const verification = fixture.run.verification?.records[0];
		expect(verification?.outcome).toBe("evaluated");
		if (verification?.outcome !== "evaluated") {
			return;
		}
		const healthyRun: IntegrityCheckRun = {
			...fixture.run,
			verification: {
				...fixture.run.verification!,
				records: [{
					...verification,
					status: "healthy",
					result: {
						...verification.result,
						status: "healthy",
						repairEligible: false,
						artifacts: verification.result.artifacts.map(artifact => ({
							...artifact,
							repairEligible: false,
						})),
					},
				}],
			},
		};

		expect(createRepairPlan(healthyRun, PLUGIN_ID, context)).toEqual(expect.objectContaining({ ok: false }));
		const selfTarget = createRepairPlan(fixture.run, PLUGIN_ID, { ...context, ownPluginId: PLUGIN_ID });
		const unsafeTransaction = createRepairPlan(fixture.run, PLUGIN_ID, { ...context, transactionId: "../bad" });
		expect(selfTarget.ok).toBe(false);
		expect(unsafeTransaction.ok).toBe(false);
		if (!selfTarget.ok && !unsafeTransaction.ok) {
			expect(selfTarget.reason.code).toBe("invalid-repair-target");
			expect(unsafeTransaction.reason.code).toBe("invalid-repair-transaction-id");
		}
	});

	it("rejects repair-eligible artifacts above the mobile memory limit", async () => {
		const fixture = await createRepairFixture();
		const remote = fixture.run.remote?.records[0];
		const verification = fixture.run.verification?.records[0];
		expect(remote?.status).toBe("resolved");
		expect(verification?.outcome).toBe("evaluated");
		if (remote?.status !== "resolved" || verification?.outcome !== "evaluated") {
			return;
		}
		const oversized = MAX_HASHABLE_ARTIFACT_BYTES + 1;
		const oversizedRun: IntegrityCheckRun = {
			...fixture.run,
			remote: {
				...fixture.run.remote!,
				records: [{
					...remote,
					release: {
						...remote.release,
						assets: remote.release.assets.map(asset => (
							asset.assetName === "main.js" ? { ...asset, sizeBytes: oversized } : asset
						)),
					},
				}],
			},
			verification: {
				...fixture.run.verification!,
				records: [{
					...verification,
					result: {
						...verification.result,
						artifacts: verification.result.artifacts.map(artifact => (
							artifact.assetName === "main.js" && artifact.expected !== null
								? { ...artifact, expected: { ...artifact.expected, sizeBytes: oversized } }
								: artifact
						)),
					},
				}],
			},
		};

		const planned = createRepairPlan(oversizedRun, PLUGIN_ID, context);
		expect(planned.ok).toBe(false);
		if (!planned.ok) {
			expect(planned.reason.code).toBe("repair-artifact-size-limit");
		}
	});
});
