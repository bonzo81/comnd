# 005. Per-platform secret-prompt patterns

Date: 2026-10-18
Status: Approved

## Context
Issue #18 asks netssh to stop retaining typed secrets in the shadow buffer while a remote device is asking for secret input. Today, `SuggestionController` mirrors typed and pasted text, while `LineTracker` detects ordinary prompts using patterns from each platform's `index.yaml`.

Different platforms can use different secret-prompt wording. The platform index already stores prompt patterns, and the knowledge-base schema is documented in `docs/specs/06-knowledge-base.md`.

## Options
- **Add an optional list of regex patterns to each platform's `index.yaml`.** Cost: update the schema, types, docs, and bundled platform indexes; patterns must be checked to avoid false matches.
- **Keep one shared pattern list in code.** Cost: platform-specific wording lives in code and is harder to customize or extend.

## Decision
Add an optional `secret_prompt_patterns` field to each platform's `index.yaml`. The field is a list of regex strings matched against the full prompt line. Keep indexes that omit the field valid, and define platform-specific patterns rather than maintaining one shared list in code.

## Consequences
Platform-specific prompt wording stays with its platform data, and each bundled platform can define suitable patterns. Optionality can keep existing indexes valid. The tradeoff is maintaining and testing patterns across the four bundled platforms and the KB schema.
