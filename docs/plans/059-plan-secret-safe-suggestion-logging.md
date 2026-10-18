# Plan: Secret-Safe Suggestion Logging

**Status: implemented (2026-10-18).**

Origin: GitHub issue [#19](https://github.com/bonzo81/netssh/issues/19),
“Close latent debug-log leak of typed secrets.”

## Goal

Ensure frontend log records do not expose raw shadow-buffer text, including
typed secrets, and redact bare quoted strings in Suggest-tagged messages
before any logger sink receives the record.

## Findings

- `SuggestionController.debounceSuggestionQuery` logs both the scheduled and
  current shadow-buffer contents when its stale-query check detects a change.
- Normal shadow-buffer updates call `debounceSuggestionQuery`, which clears
  the pending timer before scheduling another. This makes the stale-query
  branch unreachable through ordinary buffer updates today.
- The branch is defensive and should remain. The test can exercise it by
  stubbing timer cancellation in that test only, leaving production behavior
  unchanged.
- Logger redaction runs while constructing the record, before it is sent to
  any sink. Existing patterns do not redact an unlabelled quoted string such
  as `('secretvalue' != '')`.

## Changes

1. In `src/lib/suggestion-controller.ts`, change the stale-query message to
   log the scheduled and current text lengths, not their contents. Do not add
   any other shadow-buffer content to a frontend log.
2. In `src/lib/suggestion-controller.test.ts`, use fake timers and a test-only
   no-op `clearTimeout` stub to let an earlier query callback run after the
   buffer changes. Capture Suggest-tagged records and assert none contains
   the synthetic secret substring supplied to the buffer.
3. In `src/lib/logger.ts`, add a redaction rule for non-empty single-quoted
   strings in Suggest-tagged records. Keep it tag-scoped and apply it during
   record construction, before any sink sees the record. Preserve existing
   redaction behavior for other tags.
4. In `src/lib/logger.test.ts`, verify a Suggest message like
   `('secretvalue' != '')` reaches a capture sink with the quoted value
   redacted.

## Scope and risks

Only the four implementation and test files above are in scope. No
dependency or production timer behavior changes are planned. Tag-scoped
quoted-string redaction can also mask harmless quoted text in Suggest
messages; this is preferable to persisting an unlabelled typed value.
`rawArgs` behavior is unchanged; the affected stale-query call passes no
arguments.

## Verification

From the repository root, run:

1. `npm run test`
2. `npm run build`

Both commands exited successfully: `npm run test` (24 files, 321 tests) and
`npm run build` (TypeScript and Vite build). The test run printed jsdom canvas
context warnings; the build printed the existing large-chunk warning.
