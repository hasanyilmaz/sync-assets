import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const typedRecommended = tseslint.configs.recommendedTypeChecked.map(config => ({
	...config,
	files: ["**/*.ts"],
}));

export default tseslint.config(
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"build/**",
			"dist/**",
			"coverage/**",
		],
	},
	eslint.configs.recommended,
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
);
