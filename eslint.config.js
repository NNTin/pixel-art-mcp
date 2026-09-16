// @ts-check
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig([
  {
    // This ESLint config governs only the new TypeScript monorepo
    // (packages/apps/tools + its own root config files), not the
    // pre-existing Python source tree or its unrelated dev scripts.
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "scripts/**"],
  },
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "tools/**/*.ts", "*.config.js", "*.config.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.js", "*.config.ts"],
          defaultProject: "tsconfig.eslint.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  eslintConfigPrettier,
]);
