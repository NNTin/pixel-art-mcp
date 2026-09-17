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
    files: [
      "packages/**/*.ts",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "tools/**/*.ts",
      "*.config.js",
      "*.config.ts",
    ],
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
    rules: {
      // Numbers (and, for error-message formatting, `string | undefined` covered by an
      // explicit `??`) are always safe to interpolate; the default is overly strict for a
      // codebase built around formatting Pydantic-style validation messages.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowNullish: true },
      ],
      // Standard convention for a deliberately-discarded destructured binding
      // (e.g. `const { views: _views, ...rest } = data`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
]);
