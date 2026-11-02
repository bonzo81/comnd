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
      // Targeted floors, not a global target: each glob covers the modules that
      // issue #86 added behaviour tests for, and each sits below the recorded
      // baseline so a legitimate new defensive branch does not fail the build.
      // Derivation and headroom: docs/plans/065-plan-test-coverage.md
      // §Targeted gates. The globs are explicit, so renaming or moving a file
      // out of one drops it from the group; a glob that matches nothing
      // reports 100% and passes, so keep these lists in step with the tests.
      thresholds: {
        // #86 baseline: 203/204 lines (99.51%).
        "src/lib/{replay,host-filters,session-channel,tauri-api}.ts": {
          lines: 98,
        },
        // #86 baseline: 538/1271 lines (42.33%).
        "src/components/{host-screen,settings-screen}.ts": { lines: 41 },
      },
    },
  },
});
