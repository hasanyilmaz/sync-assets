import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "node:process";

const mode = process.argv[2] ?? "development";
if (mode !== "development" && mode !== "production") {
	throw new Error(`Unsupported build mode: ${mode}`);
}

const production = mode === "production";
const context = await esbuild.context({
	entryPoints: ["main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map(moduleName => `node:${moduleName}`),
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	minify: production,
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
