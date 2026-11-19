// `.editorconfig` is editor-only: it shapes what an IDE writes, and nothing
// re-checks the result. This gate enforces the three rules the file actually
// declares, on committed content, for every tracked text file:
//
//   1. end_of_line = lf                 ([*])
//   2. trim_trailing_whitespace = true  ([*]) — exempt for *.md, which the
//      [*.md] section overrides
//   3. insert_final_newline = true      ([*])
//
// Content is read from the git index (`git cat-file --batch` on `:<path>`),
// never from the working tree. A Windows checkout with core.autocrlf=true has
// CRLF working-tree files, so a check reading them would demand CRLF be fixed
// on every Windows machine while the committed content was always LF. Content
// and the working tree therefore diverge on purpose: `git add` before running
// this locally.
//
// Only regular files (index modes 100644 and 100755) are checked. A symlink's
// blob content is its target path, so demanding a final newline there would
// rewrite where the link points; a gitlink is a submodule commit pointer, not
// content at all.
//
// Usage: npm run lint:eol   (= node scripts/check-eol.mjs)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BINARY_PROBE_BYTES = 8000;
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

/**
 * Resolves the `.editorconfig` sections that apply to one path. `[*]` supplies
 * all three checked rules; `[*.md]` overrides only trim_trailing_whitespace.
 * An editorconfig glob with no slash matches the basename at any depth, so
 * `*.md` is every markdown file, including `docs/deep/note.md`.
 */
export function rulesFor(path) {
  return {
    endOfLine: "lf",
    insertFinalNewline: true,
    trimTrailingWhitespace: !/\.md$/.test(path),
  };
}

/** Text vs binary, with the same NUL probe git uses to decide it. */
export function isTextBlob(bytes) {
  return !bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** Problems with one file's committed content, as `path:line: what` lines. */
export function checkFile({ path, text }) {
  const problems = [];
  const rules = rulesFor(path);

  // Nothing to terminate and nothing to trim.
  if (text.length === 0) return problems;

  if (rules.endOfLine === "lf") {
    const carriageReturn = text.indexOf("\r");
    if (carriageReturn !== -1) {
      const line = text.slice(0, carriageReturn).split("\n").length;
      problems.push(
        `${path}:${line}: CRLF line ending; .editorconfig [*] sets end_of_line = lf`,
      );
    }
  }

  const endsWithNewline = text.endsWith("\n");
  if (rules.insertFinalNewline && !endsWithNewline) {
    problems.push(
      `${path}: file does not end with a newline; .editorconfig [*] sets insert_final_newline = true`,
    );
  }

  if (rules.trimTrailingWhitespace) {
    const lines = text.split("\n");
    // A terminated final line contributes an empty tail element, not a line.
    const counted = endsWithNewline ? lines.length - 1 : lines.length;
    for (let index = 0; index < counted; index += 1) {
      const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
      if (/[ \t]$/.test(line)) {
        problems.push(
          `${path}:${index + 1}: trailing whitespace; .editorconfig [*] sets ` +
            "trim_trailing_whitespace = true",
        );
      }
    }
  }

  return problems;
}

/**
 * @param {{ path: string, text: string }[]} files every tracked text file, as
 *   its committed content.
 */
export function checkFiles(files) {
  return { problems: files.flatMap((file) => checkFile(file)), checked: files.length };
}

/** Index modes whose content is a regular file this gate may reformat. */
export function isCheckableMode(mode) {
  return mode === "100644" || mode === "100755";
}

/** Every tracked text file in the index, as `{ path, text }`. */
export function readIndexFiles({ cwd } = {}) {
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], { encoding: "utf8", cwd })
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode] = record.slice(0, tab).split(" ");
      return { mode, path: record.slice(tab + 1) };
    })
    .filter((entry) => isCheckableMode(entry.mode));
  const paths = entries.map((entry) => entry.path);
  if (paths.length === 0) return [];

  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: paths.map((path) => `:${path}`).join("\n") + "\n",
    maxBuffer: MAX_GIT_OUTPUT,
  });

  const files = [];
  let offset = 0;
  for (const path of paths) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error(`truncated git cat-file output at ${path}`);
    const header = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (header[1] !== "blob") {
      throw new Error(`no index blob for ${path}: ${header.join(" ")}`);
    }
    const size = Number(header[2]);
    const content = batch.subarray(headerEnd + 1, headerEnd + 1 + size);
    // Each record is the blob's bytes, then one newline git adds.
    offset = headerEnd + 1 + size + 1;
    if (!isTextBlob(content)) continue;
    files.push({ path, text: content.toString("utf8") });
  }
  return files;
}

/** Checks every tracked text file and exits non-zero on a problem. */
function main() {
  let files;
  try {
    files = readIndexFiles();
  } catch (error) {
    console.error(`cannot read the git index: ${error.message}`);
    return 1;
  }

  const { problems, checked } = checkFiles(files);
  for (const problem of problems) console.error(`FAIL ${problem}`);

  if (problems.length > 0) {
    console.error(
      `\n${problems.length} .editorconfig problem(s) in committed content. The rules ` +
        "are in .editorconfig; run `git add` first, because the index is what this checks.",
    );
    return 1;
  }

  console.log(`eol ok: ${checked} text files checked in the git index`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
