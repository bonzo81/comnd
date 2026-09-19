import { describe, expect, it } from "vitest";
import type { Command, CommandToken } from "./tauri-api";
import { isChoice, isLit, isPipe, isVar, renderToken } from "./tokens";
import fixtureRaw from "../../src-tauri/tests/kb-schema.fixture.json";

/**
 * KB schema contract (docs/plans/plan-kb-contract-test.md). Pairs with the Rust
 * `mod contract` in src-tauri/src/kb/schema.rs: both sides assert the same fixture,
 * so a Command/CommandToken schema change on either side of the IPC seam fails
 * here until tauri-api.ts and tests/kb-schema.fixture.json are updated in the
 * same commit.
 */

interface Fixture {
  expected_ipc_json: Command[];
  expected_renders: { commandIndex: number; tokenIndex: number; expected: string }[];
}
const fixture = fixtureRaw as unknown as Fixture;

// Keys Rust always serializes on Command (no skip_serializing_if). A key present
// on the wire but not listed here fails until this list and tauri-api.ts are updated.
const REQUIRED_COMMAND_KEYS = [
  "name", "syntax", "description", "category", "mode", "aliases",
  "examples", "versions", "tags", "tokens", "order", "negatable",
];
// Keys Rust omits via skip_serializing_if when absent/false.
const OPTIONAL_COMMAND_KEYS = ["source", "overrides"];
const ALLOWED_COMMAND_KEYS = new Set([...REQUIRED_COMMAND_KEYS, ...OPTIONAL_COMMAND_KEYS]);

// Exact key sets per token kind (Rust serializes every field of each variant).
const TOKEN_KEYS: Record<string, string[]> = {
  lit: ["lit", "optional"],
  choice: ["choice", "descriptions", "optional", "repeatable"],
  var: ["description", "max", "min", "optional", "source", "type", "values", "var"],
  pipe: ["filters", "optional", "pipe", "repeatable"],
};

function kindOf(t: CommandToken): string {
  if (isLit(t)) return "lit";
  if (isChoice(t)) return "choice";
  if (isVar(t)) return "var";
  if (isPipe(t)) return "pipe";
  return "unknown";
}

describe("KB schema contract (Rust IPC ↔ TS)", () => {
  it("every wire key is declared by the TS Command interface", () => {
    for (const cmd of fixture.expected_ipc_json) {
      const keys = Object.keys(cmd);
      for (const key of keys) {
        expect(
          ALLOWED_COMMAND_KEYS.has(key),
          `unknown wire key "${key}" — update tauri-api.ts and the fixture in the same commit`,
        ).toBe(true);
      }
      for (const key of REQUIRED_COMMAND_KEYS) {
        expect(keys, `missing required wire key "${key}"`).toContain(key);
      }
    }
  });

  it("exactly one type guard matches each token", () => {
    fixture.expected_ipc_json.forEach((cmd, ci) => {
      (cmd.tokens ?? []).forEach((t, ti) => {
        const hits = [isLit(t), isChoice(t), isVar(t), isPipe(t)].filter(Boolean).length;
        expect(hits, `token ${ci}:${ti} matched ${hits} guards`).toBe(1);
      });
    });
  });

  it("each token carries exactly the keys its kind declares", () => {
    fixture.expected_ipc_json.forEach((cmd, ci) => {
      (cmd.tokens ?? []).forEach((t, ti) => {
        const kind = kindOf(t);
        expect(kind, `token ${ci}:${ti} matched no guard`).not.toBe("unknown");
        expect(Object.keys(t).sort(), `token ${ci}:${ti} (${kind}) keys drifted`).toEqual(
          [...TOKEN_KEYS[kind]].sort(),
        );
      });
    });
  });

  it("renderToken output matches expected_renders", () => {
    for (const r of fixture.expected_renders) {
      const token = fixture.expected_ipc_json[r.commandIndex].tokens![r.tokenIndex];
      expect(renderToken(token), `render ${r.commandIndex}:${r.tokenIndex}`).toBe(r.expected);
    }
  });
});
