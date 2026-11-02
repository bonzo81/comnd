// Per-area Rust line floors. cargo-llvm-cov 0.9.1 only has a global
// --fail-under-lines (and a per-file --fail-under-file-lines, which is not the
// policy), so this sums the files each area names from `report --json
// --summary-only`. Floors and their derivation are in
// docs/plans/065-plan-test-coverage.md.
//
// Usage (after `cargo llvm-cov --no-report` in src-tauri/):
//   cargo llvm-cov report --json --summary-only --output-path target/coverage.json
//   node scripts/check-rust-coverage.mjs src-tauri/target/coverage.json

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const AREAS = [
  {
    name: "rust core stores (hosts.rs + replay.rs + config.rs)",
    files: ["src/hosts.rs", "src/replay.rs", "src/config.rs"],
    floor: 65,
  },
  {
    name: "tauri command layer (lib.rs)",
    files: ["src/lib.rs"],
    floor: 35,
  },
];

/**
 * Sum the line counts each area names. A configured file that is missing from
 * the report (or matched twice) is a hard problem, not a low score: a rename
 * would otherwise shrink the area and quietly inflate its percentage.
 */
export function summariseAreas(report, areas = AREAS) {
  const files = (report?.data ?? []).flatMap((entry) =>
    (entry.files ?? []).map((file) => ({
      path: file.filename.replace(/\\/g, "/"),
      covered: file.summary.lines.covered,
      count: file.summary.lines.count,
    })),
  );

  const problems = [];
  const results = areas.map((area) => {
    let covered = 0;
    let count = 0;

    for (const rel of area.files) {
      const suffix = `/src-tauri/${rel}`;
      const matches = files.filter((file) => file.path.endsWith(suffix));
      if (matches.length !== 1) {
        problems.push(
          `${area.name}: expected exactly one report entry for ${rel}, found ${matches.length}`,
        );
        continue;
      }
      covered += matches[0].covered;
      count += matches[0].count;
    }

    const percent = count === 0 ? 100 : (covered / count) * 100;
    const needed = Math.ceil((area.floor / 100) * count);
    return {
      name: area.name,
      floor: area.floor,
      covered,
      count,
      percent,
      needed,
      ok: percent >= area.floor,
    };
  });

  return { results, problems };
}

function main(argv) {
  const reportPath = argv[2] ?? "src-tauri/target/coverage.json";

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(
      `cannot read coverage report at ${reportPath}: ${error.message}\n` +
        "Run `cargo llvm-cov --no-report` then `cargo llvm-cov report --json " +
        "--summary-only --output-path target/coverage.json` in src-tauri/ first.",
    );
    return 1;
  }

  if (process.platform !== "linux") {
    console.log(
      `note: the floors are measured on ubuntu-22.04; this run is ${process.platform} ` +
        "and #[cfg] changes which lines exist, so the numbers are indicative only.",
    );
  }

  const { results, problems } = summariseAreas(report);

  for (const result of results) {
    const status = result.ok ? "ok" : "BELOW FLOOR";
    console.log(
      `${result.name}: ${result.covered}/${result.count} = ` +
        `${result.percent.toFixed(2)}% (floor ${result.floor.toFixed(2)}%) ${status}`,
    );
  }

  const below = results.filter((result) => !result.ok);
  for (const result of below) {
    const short = result.needed - result.covered;
    console.error(
      `\nFAIL ${result.name}: ${result.covered}/${result.count} = ` +
        `${result.percent.toFixed(2)}% is below the floor of ${result.floor.toFixed(2)}% ` +
        `(${result.needed} covered lines needed, ${short} short).`,
    );
  }

  for (const problem of problems) console.error(`\nFAIL ${problem}`);

  if (below.length > 0) {
    console.error(
      "\nAdd a test, or lower the floor in the same PR with the derivation " +
        "recorded in docs/plans/065-plan-test-coverage.md.",
    );
  }

  return below.length > 0 || problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
