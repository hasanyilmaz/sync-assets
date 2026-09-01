import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectRelease } from "./release-guard-core.mjs";

export async function runReleaseGuard(rootDir = process.cwd()) {
	const result = await inspectRelease(resolve(rootDir));
	if (!result.ok) {
		for (const error of result.errors) {
			console.error(`Release Guard: ${error}`);
		}
		return 1;
	}
	console.log("Release Guard: passed (3 release artifacts verified).");
	return 0;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await runReleaseGuard();
}
