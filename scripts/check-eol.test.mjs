import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkFile,
  checkFiles,
  isCheckableMode,
  isTextBlob,
  readIndexFiles,
  rulesFor,
} from "./check-eol.mjs";

function problems(path, text) {
  return checkFile({ path, text });
}

describe("rulesFor", () => {
  it("applies all three rules to a non-markdown file", () => {
    expect(rulesFor("src/lib/a.ts")).toEqual({
      endOfLine: "lf",
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
    });
  });

  it("lifts only the trailing whitespace rule for markdown", () => {
    expect(rulesFor("docs/deep/note.md").trimTrailingWhitespace).toBe(false);
    expect(rulesFor("docs/deep/note.md").insertFinalNewline).toBe(true);
  });
});

describe("isTextBlob", () => {
  it("treats a NUL byte as binary", () => {
    expect(isTextBlob(Buffer.from("a\0b"))).toBe(false);
  });

  it("treats NUL-free content as text", () => {
    expect(isTextBlob(Buffer.from("a b\n"))).toBe(true);
  });
});

describe("isCheckableMode", () => {
  it("checks regular files, executable or not", () => {
    expect(isCheckableMode("100644")).toBe(true);
    expect(isCheckableMode("100755")).toBe(true);
  });

  it("skips symlinks and submodules", () => {
    expect(isCheckableMode("120000")).toBe(false);
    expect(isCheckableMode("160000")).toBe(false);
  });
});

describe("readIndexFiles", () => {
  it("skips a tracked symlink and gitlink and keeps the regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-eol-"));
    try {
      const git = (args, input) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", input }).trim();
      git(["init", "--quiet"]);
      writeFileSync(join(dir, "note.txt"), "hello\n");
      git(["add", "note.txt"]);

      // A symlink's blob content is its target path, which has no final newline.
      const target = git(["hash-object", "-w", "--stdin"], "note.txt");
      git(["update-index", "--add", "--cacheinfo", `120000,${target},link-to-note`]);
      // A gitlink has no blob at all: cat-file would fail on it.
      const commit = "0123456789abcdef0123456789abcdef01234567";
      git(["update-index", "--add", "--cacheinfo", `160000,${commit},modules/thing`]);

      expect(readIndexFiles({ cwd: dir })).toEqual([{ path: "note.txt", text: "hello\n" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkFile", () => {
  it("passes a clean file", () => {
    expect(problems("src/a.ts", "const a = 1;\n")).toEqual([]);
  });

  it("passes an empty file", () => {
    expect(problems("src/a.ts", "")).toEqual([]);
  });

  it("reports a missing final newline", () => {
    expect(problems("src/a.ts", "const a = 1;")).toEqual([
      "src/a.ts: file does not end with a newline; .editorconfig [*] sets insert_final_newline = true",
    ]);
  });

  it("reports trailing whitespace with its line number", () => {
    expect(problems("src/a.ts", "const a = 1; \nconst b = 2;\t\n")).toEqual([
      "src/a.ts:1: trailing whitespace; .editorconfig [*] sets trim_trailing_whitespace = true",
      "src/a.ts:2: trailing whitespace; .editorconfig [*] sets trim_trailing_whitespace = true",
    ]);
  });

  it("reports both a trailing space and a missing newline on an unterminated last line", () => {
    expect(problems("src/a.ts", "const a = 1;\nconst b = 2; ")).toHaveLength(2);
  });

  it("reports CRLF as an end_of_line violation", () => {
    expect(problems("src/a.ts", "const a = 1;\r\nconst b = 2;\r\n")).toEqual([
      "src/a.ts:1: CRLF line ending; .editorconfig [*] sets end_of_line = lf",
    ]);
  });

  it("still reports trailing whitespace before a CRLF ending", () => {
    expect(problems("src/a.ts", "const a = 1; \r\n")).toEqual([
      "src/a.ts:1: CRLF line ending; .editorconfig [*] sets end_of_line = lf",
      "src/a.ts:1: trailing whitespace; .editorconfig [*] sets trim_trailing_whitespace = true",
    ]);
  });

  it("allows trailing whitespace in a markdown file", () => {
    expect(problems("docs/note.md", "two spaces  \n")).toEqual([]);
  });

  it("still requires a final newline in a markdown file", () => {
    expect(problems("docs/note.md", "# Title")).toEqual([
      "docs/note.md: file does not end with a newline; .editorconfig [*] sets insert_final_newline = true",
    ]);
  });
});

describe("checkFiles", () => {
  it("counts the files it checked and aggregates their problems", () => {
    const result = checkFiles([
      { path: "src/a.ts", text: "a\n" },
      { path: "src/b.ts", text: "b" },
    ]);
    expect(result.checked).toBe(2);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("src/b.ts");
  });
});
