import json from "@eslint/json";
import eslint from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import { PlainTextParser } from "./node_modules/eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";

const productionFiles = ["main.ts", "src/**/*.ts"];

const obsidianRecommended = obsidianmd.configs.recommended.map(config => {
	const serializedFiles = JSON.stringify(config.files ?? []);
	if (serializedFiles.includes("package.json")) {
		return config;
	}
	return {
		...config,
		files: productionFiles,
	};
});

const typedRecommended = tseslint.configs.recommendedTypeChecked.map(config => ({
	...config,
	files: ["**/*.ts"],
}));

export default tseslint.config(
	{
		ignores: [
			"eslint.config.mjs",
			"esbuild.config.mjs",
			"main.js",
			"node_modules/**",
			"scripts/**",
			"build/**",
			"dist/**",
			"coverage/**",
		],
	},
	eslint.configs.recommended,
	...obsidianRecommended,
	...typedRecommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/explicit-function-return-type": "error",
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
	{
		files: productionFiles,
		rules: {
			"obsidianmd/no-plugin-as-component": "error",
			"obsidianmd/no-unsupported-api": "error",
			"obsidianmd/no-view-references-in-plugin": "error",
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["Sync Assets", "Obsidian", "GitHub"],
					acronyms: ["API", "ID", "URL", "JSON", "CSS", "SHA"],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
	{
		files: ["manifest.json"],
		language: "json/json",
		plugins: {
			json,
			obsidianmd,
		},
		rules: {
			"no-irregular-whitespace": "off",
			"obsidianmd/validate-manifest": "error",
		},
	},
	{
		files: ["LICENSE"],
		languageOptions: {
			parser: PlainTextParser,
		},
		plugins: {
			obsidianmd,
		},
		rules: {
			"obsidianmd/validate-license": "error",
		},
	},
);
