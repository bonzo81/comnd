import { describe, expect, it } from "vitest";

import { summariseAreas } from "./check-rust-coverage.mjs";

const entry = (path, covered, count) => ({
  filename: path,
  summary: { lines: { covered, count } },
});

const report = (files) => ({ data: [{ files }] });

// The #86 baseline per-file counts, so these tests double as the arithmetic
// the floors were derived from (docs/plans/065-plan-test-coverage.md).
const baseline = report([
  entry("/w/comnd/src-tauri/src/hosts.rs", 517, 728),
  entry("/w/comnd/src-tauri/src/replay.rs", 200, 225),
  entry("/w/comnd/src-tauri/src/config.rs", 393, 689),
  entry("/w/comnd/src-tauri/src/lib.rs", 202, 484),
  entry("/w/comnd/src-tauri/tests/session.rs", 10, 10),
]);

describe("summariseAreas", () => {
  it("sums the area's files and ignores everything else", () => {
    const { results, problems } = summariseAreas(baseline);

    expect(problems).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ covered: 1110, count: 1642, needed: 1068, ok: true });
    expect(results[0].percent).toBeCloseTo(67.6, 2);
    expect(results[1]).toMatchObject({ covered: 202, count: 484, needed: 170, ok: true });
  });

  it("normalises Windows separators", () => {
    const { results, problems } = summariseAreas(
      report([
        entry("F:\\w\\comnd\\src-tauri\\src\\hosts.rs", 517, 728),
        entry("F:\\w\\comnd\\src-tauri\\src\\replay.rs", 200, 225),
        entry("F:\\w\\comnd\\src-tauri\\src\\config.rs", 393, 689),
        entry("F:\\w\\comnd\\src-tauri\\src\\lib.rs", 202, 484),
      ]),
    );

    expect(problems).toEqual([]);
    expect(results[0]).toMatchObject({ covered: 1110, count: 1642, ok: true });
    expect(results[1]).toMatchObject({ covered: 202, count: 484, ok: true });
  });

  it("flags an area below its floor and counts the covered lines it is short", () => {
    const dropped = report([
      entry("/w/comnd/src-tauri/src/hosts.rs", 517, 728),
      entry("/w/comnd/src-tauri/src/replay.rs", 200, 225),
      entry("/w/comnd/src-tauri/src/config.rs", 300, 689),
      entry("/w/comnd/src-tauri/src/lib.rs", 202, 484),
    ]);

    const { results } = summariseAreas(dropped);

    expect(results[0]).toMatchObject({ covered: 1017, count: 1642, needed: 1068, ok: false });
    expect(results[1].ok).toBe(true);
  });

  it("treats a missing configured file as a problem, not a pass", () => {
    const renamed = report([
      entry("/w/comnd/src-tauri/src/hosts.rs", 517, 728),
      entry("/w/comnd/src-tauri/src/replay-store.rs", 200, 225),
      entry("/w/comnd/src-tauri/src/config.rs", 393, 689),
      entry("/w/comnd/src-tauri/src/lib.rs", 202, 484),
    ]);

    const { problems } = summariseAreas(renamed);

    expect(problems).toEqual([
      "rust core stores (hosts.rs + replay.rs + config.rs): expected exactly one report entry for src/replay.rs, found 0",
    ]);
  });

  it("treats a doubly matched file as a problem", () => {
    const twice = report([
      entry("/w/comnd/src-tauri/src/hosts.rs", 517, 728),
      entry("/w/comnd/src-tauri/src/replay.rs", 200, 225),
      entry("/w/comnd/src-tauri/src/config.rs", 393, 689),
      entry("/w/comnd/src-tauri/src/lib.rs", 202, 484),
      entry("/other/src-tauri/src/lib.rs", 202, 484),
    ]);

    const { problems } = summariseAreas(twice);

    expect(problems).toEqual([
      "tauri command layer (lib.rs): expected exactly one report entry for src/lib.rs, found 2",
    ]);
  });
});
