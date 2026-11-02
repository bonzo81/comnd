import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      // Vitest only reports files a test imported unless `include` is set, so
      // an untested module would vanish from the report instead of showing 0%.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        // Entry point: wires modules together, has no behaviour of its own.
        "src/main.ts",
      ],
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      clean: true,
      // Two per-area line floors, no global target and no per-file check. Each
      // floor sits below the #86 baseline by the headroom recorded in
      // docs/plans/065-plan-test-coverage.md, which also holds the derivation.
      thresholds: {
        "src/lib/**": { lines: 78 },
        "src/components/**": { lines: 29 },
      },
    },
  },
});
