import tseslint from "typescript-eslint";

/**
 * Deliberately small rule set: the four classes tsc cannot see. Type-aware
 * linting uses the root tsconfig.json (its `include` is the lint set), so no
 * second project file exists. No Prettier: formatting stays out of the gate.
 */
export default tseslint.config(
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // `_` marks a signature placeholder, e.g. a mock that must keep the
      // real API's arity (tests/harness.ts).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  {
    // The one console sink; every other module logs through this file.
    files: ["src/lib/logger.ts"],
    rules: { "no-console": "off" },
  },
);
