import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

export const REQUIRED_RELEASE_ASSETS = Object.freeze([
	"main.js",
	"manifest.json",
	"styles.css",
]);

const REQUIRED_IGNORE_PATTERNS = Object.freeze([
	"node_modules/",
	"main.js",
	"main.js.map",
	"build/",
	"dist/",
	"coverage/",
	"data.json",
	"data.json.*",
	".repair/",
	"*.bak",
	"*.backup",
	"*.orig",
	"*.rej",
	"*.tmp",
	"*.zip",
	"*.tar",
	"*.tar.gz",
	"*.tgz",
	"*.gz",
	"*.7z",
	"*.rar",
	"*.swp",
]);

const SCAN_EXCLUDED_DIRECTORIES = new Set([
	".agents",
	".codex",
	".git",
	"build",
	"coverage",
	"dist",
	"node_modules",
]);

const BUNDLE_FORBIDDEN_PATTERNS = Object.freeze([
	{ pattern: /sourceMappingURL=/u, label: "source-map reference" },
	{ pattern: /\/Users\/[^/\s"']+/u, label: "personal macOS path" },
	{ pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/u, label: "personal Windows path" },
	{ pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, label: "private key" },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/u, label: "GitHub token" },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u, label: "GitHub fine-grained token" },
	{ pattern: /\bnpm_[A-Za-z0-9]{30,}\b/u, label: "npm token" },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/u, label: "AWS access key" },
	{ pattern: /\bdebugger\b/u, label: "debugger statement" },
	{ pattern: /\b(?:localhost|127\.0\.0\.1)\b/u, label: "local development address" },
]);

const EXPECTED_SCRIPTS = Object.freeze({
	lint: "eslint . --quiet",
	"lint:report": "eslint .",
	"lint:strict": "eslint . --max-warnings 0",
	"release:guard": "node scripts/release-guard.mjs",
	check: "npm run lint:strict && npm run build && npm run test && npm run release:guard",
});

function normalizePath(path) {
	return path.split(sep).join("/");
}

async function readRequiredText(rootDir, relativePath, errors) {
	try {
		return await readFile(join(rootDir, relativePath), "utf8");
	} catch (error) {
		errors.push(`${relativePath}: required file could not be read (${error instanceof Error ? error.message : "unknown error"})`);
		return null;
	}
}

async function readRequiredJson(rootDir, relativePath, errors) {
	const text = await readRequiredText(rootDir, relativePath, errors);
	if (text === null) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		errors.push(`${relativePath}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`);
		return null;
	}
}

function requireEqual(errors, label, actual, expected) {
	if (actual !== expected) {
		errors.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
	}
}

function checkPackageContracts(pkg, manifest, versions, lock, errors) {
	if (pkg !== null) {
		requireEqual(errors, "package.json name", pkg.name, "sync-assets");
		requireEqual(errors, "package.json private", pkg.private, true);
		requireEqual(errors, "package.json license", pkg.license, "MIT");
		for (const [scriptName, expected] of Object.entries(EXPECTED_SCRIPTS)) {
			requireEqual(errors, `package.json scripts.${scriptName}`, pkg.scripts?.[scriptName], expected);
		}
	}
	if (manifest !== null) {
		requireEqual(errors, "manifest.json id", manifest.id, "sync-assets");
		requireEqual(errors, "manifest.json name", manifest.name, "Sync Assets");
	}
	if (pkg !== null && manifest !== null) {
		requireEqual(errors, "package.json and manifest.json version", pkg.version, manifest.version);
		requireEqual(errors, "package.json name and manifest.json id", pkg.name, manifest.id);
	}
	if (pkg !== null && manifest !== null && versions !== null) {
		requireEqual(
			errors,
			"versions.json current minAppVersion",
			versions[pkg.version],
			manifest.minAppVersion,
		);
	}
	if (pkg !== null && lock !== null) {
		const lockRoot = lock.packages?.[""];
		requireEqual(errors, "package-lock.json root name", lockRoot?.name, pkg.name);
		requireEqual(errors, "package-lock.json root version", lockRoot?.version, pkg.version);
	}
}

async function checkReleaseAssets(rootDir, errors) {
	for (const relativePath of REQUIRED_RELEASE_ASSETS) {
		try {
			const fileStat = await stat(join(rootDir, relativePath));
			if (!fileStat.isFile() || fileStat.size === 0) {
				errors.push(`${relativePath}: release artifact must be a non-empty file`);
			}
		} catch (error) {
			errors.push(`${relativePath}: required release artifact is missing (${error instanceof Error ? error.message : "unknown error"})`);
		}
	}
}

function checkLicense(licenseText, errors) {
	if (licenseText === null) {
		return;
	}
	for (const marker of [
		"MIT License",
		"Permission is hereby granted, free of charge",
		"THE SOFTWARE IS PROVIDED \"AS IS\"",
	]) {
		if (!licenseText.includes(marker)) {
			errors.push(`LICENSE: missing required MIT license text ${JSON.stringify(marker)}`);
		}
	}
}

function checkIgnorePolicy(ignoreText, errors) {
	if (ignoreText === null) {
		return;
	}
	const entries = new Set(ignoreText
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#")));
	for (const requiredPattern of REQUIRED_IGNORE_PATTERNS) {
		if (!entries.has(requiredPattern)) {
			errors.push(`.gitignore: missing required pattern ${JSON.stringify(requiredPattern)}`);
		}
	}
}

function isForbiddenWorkspacePath(relativePath) {
	const normalized = normalizePath(relativePath);
	const lower = normalized.toLowerCase();
	const pathBasename = basename(lower);
	const segments = lower.split("/");
	if (segments.includes(".repair") || segments.includes(".cache") || segments.includes("cache")) {
		return true;
	}
	if (pathBasename === "data.json" || pathBasename.startsWith("data.json.")) {
		return true;
	}
	if (/\.(?:7z|bak|backup|gz|orig|rar|rej|swp|tar|tgz|tmp|zip)$/u.test(pathBasename)) {
		return true;
	}
	return /(?:conflict|conflicted)[-_ ]?copy/u.test(pathBasename);
}

async function checkWorkspacePaths(rootDir, errors) {
	const visit = async currentDir => {
		let entries;
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch (error) {
			errors.push(`${normalizePath(relative(rootDir, currentDir)) || "."}: directory could not be read (${error instanceof Error ? error.message : "unknown error"})`);
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			const absolutePath = join(currentDir, entry.name);
			const relativePath = normalizePath(relative(rootDir, absolutePath));
			if (isForbiddenWorkspacePath(relativePath)) {
				errors.push(`${relativePath}: user state, backup, cache, conflict, temporary, or archive paths are forbidden`);
				continue;
			}
			if (entry.isDirectory()) {
				await visit(absolutePath);
			}
		}
	};
	await visit(rootDir);
}

function checkBundle(bundleText, errors) {
	if (bundleText === null) {
		return;
	}
	for (const { pattern, label } of BUNDLE_FORBIDDEN_PATTERNS) {
		if (pattern.test(bundleText)) {
			errors.push(`main.js: contains forbidden ${label}`);
		}
	}
}

export async function inspectRelease(rootDir) {
	const errors = [];
	const [pkg, manifest, versions, lock, licenseText, ignoreText, bundleText] = await Promise.all([
		readRequiredJson(rootDir, "package.json", errors),
		readRequiredJson(rootDir, "manifest.json", errors),
		readRequiredJson(rootDir, "versions.json", errors),
		readRequiredJson(rootDir, "package-lock.json", errors),
		readRequiredText(rootDir, "LICENSE", errors),
		readRequiredText(rootDir, ".gitignore", errors),
		readRequiredText(rootDir, "main.js", errors),
	]);

	checkPackageContracts(pkg, manifest, versions, lock, errors);
	checkLicense(licenseText, errors);
	checkIgnorePolicy(ignoreText, errors);
	checkBundle(bundleText, errors);
	await Promise.all([
		checkReleaseAssets(rootDir, errors),
		checkWorkspacePaths(rootDir, errors),
	]);

	return {
		ok: errors.length === 0,
		errors: Object.freeze([...errors].sort((left, right) => left.localeCompare(right))),
	};
}
