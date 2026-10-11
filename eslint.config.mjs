import babelParser from "@babel/eslint-parser";
import eslint from "@eslint/js";

export default [
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          plugins: [
            "@babel/plugin-syntax-jsx",
            ["@babel/plugin-syntax-typescript", { isTSX: true }],
          ],
        },
      },
    },
    rules: {
      // Babel's parser parses TypeScript syntax but does not supply the
      // TypeScript-aware scope analysis required by these core rules.
      "no-undef": "off",
      "no-unused-vars": "off",
      eqeqeq: "error",
      "no-console": "error",
      "no-debugger": "error",
    },
  },
];
