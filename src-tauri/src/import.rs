//! Knowledge Base Import Pipeline
//!
//! Fetches a URL → extracts text from HTML → sends to the configured LLM for
//! structured command extraction → validates → writes YAML to the
//! user's knowledge base → triggers KB reload.
//!
//! Phase 5: import now emits tokens (5.1), preserves `<pre>`/`<code>` block
//! structure in HTML extraction (5.2), drops bad tokens but keeps the
//! command (5.3), upgrades legacy entries with tokens on merge (5.4), and
//! supports a two-stage extract-then-commit flow (5.6).

use crate::config::AppConfig;
use crate::kb::{
    get_target_yaml_path, write_commands_to_yaml, validate_command, KbStore,
    KbManager, Command, CommandExample, CommandOrder, CommandVersions, PlatformIndex,
};
use crate::llm::{ExtractedCommand, LlmClient};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::state::AppState;
use tauri::{Emitter, Manager};

/// Progress callback for the import pipeline. The Tauri layer provides an
/// adapter that emits a frontend event and writes a log line; tests supply
/// a recorder.
pub type ProgressFn<'a> = dyn Fn(&ImportProgress) + Send + Sync + 'a;
// ─── Types ──────────────────────────────────────────────────────────

/// Parameters for a KB import request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRequest {
    pub url: String,
    pub platform: String,
    pub category: String,
}

/// Progress events emitted during import (sent to frontend via Tauri events).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", content = "detail")]
pub enum ImportProgress {
    Fetching { url: String },
    ExtractingText { content_length: usize },
    SendingToLlm { },
    /// Streaming: chars of LLM output received so far + rolling tail of the
    /// raw output text (live view in the job modal).
    LlmOutput { chars: usize, tail: String },
    /// Chunked extraction progress for large source pages.
    ExtractingChunk { chunk: usize, total: usize },
    ExtractingCommands { },
    Validating { command_count: usize },
    WritingYaml { command_count: usize, target_file: String },
    ReloadingKb { },
    Complete { commands_imported: usize, target_file: String },
    Error { message: String },
}

/// Preview of an extracted command before it is written to YAML (Phase 5.6).
/// Mirrors the fields a reviewer needs: name, mode badge, tokenized syntax.
/// The full `Command` is sent so the same UI code can render the tokenized
/// syntax the KB viewer uses (Phase 5.7).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPreview {
    pub command: Command,
    /// "ok" if all token checks pass; "warn" if tokens were dropped (5.3).
    pub status: String,
    /// Human-readable issues (empty when status is "ok").
    pub issues: Vec<String>,
    /// True when the command name exists in the bundled-only KB — drives the
    /// "New command" vs "Overrides built-in entry" label in the review UI.
    #[serde(default)]
    pub in_bundled: bool,
    /// The bundled command with the same name, when `in_bundled` — powers the
    /// side-by-side compare in the review UI (docs/10 § Part 4).
    #[serde(default)]
    pub bundled: Option<Command>,
}

/// Result of the preview stage (Phase 5.6). Returned by `extract_from_url`
/// without writing anything; the frontend shows a review dialog and then
/// calls `commit_kb_import` to persist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractPreview {
    pub previews: Vec<CommandPreview>,
    pub platform: String,
    pub category: String,
    pub source_url: String,
    pub errors: Vec<String>,
}

// ─── Pipeline ───────────────────────────────────────────────────────

/// Max source-text chars per LLM extraction call. Output JSON grows with the
/// commands in the chunk; 12k input chars keeps each call's output a few
/// thousand tokens — safely under typical model output limits. Pages larger
/// than this are split into chunks (see `split_text_chunks`).
const CHUNK_EXTRACTION_CHARS: usize = 12_000;

/// Split source text into chunks of at most `max` chars at line boundaries
/// (the HTML extractor emits one command-syntax block per line). An
/// individual line longer than `max` is hard-split by chars. Small pages are
/// returned as a single chunk (no behavior change).
fn split_text_chunks(text: &str, max: usize) -> Vec<String> {
    if text.chars().count() <= max {
        return vec![text.to_string()];
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.split('\n') {
        let line_len = line.chars().count();
        if line_len > max {
            // Monster line — hard-split by chars so no chunk exceeds `max`.
            if !current.trim().is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            let mut buf = String::new();
            for ch in line.chars() {
                if buf.chars().count() + 1 > max {
                    chunks.push(std::mem::take(&mut buf));
                }
                buf.push(ch);
            }
            current = buf;
            continue;
        }
        if current.chars().count() + line_len + 1 > max && !current.trim().is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Resolve the bundled (read-only, repo-shipped) KB root for this app instance —
/// release-correct via `resource_dir`, dev fallback preserved. Thin adapter over
/// [`crate::paths::bundled_kb_path`], which owns the logic so startup and import
/// share one source of truth.
fn bundled_kb_root(app_handle: &tauri::AppHandle) -> PathBuf {
    let resource = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    crate::paths::bundled_kb_path(&resource)
}

/// Stage 1 of the two-stage import (Phase 5.6): fetch + extract + validate
/// without writing anything. Returns a preview the user reviews before
/// committing.
pub async fn extract_from_url(
    request: ImportRequest,
    config: &AppConfig,
    progress: &ProgressFn<'_>,
    platform_index: &PlatformIndex,
    allowed_categories: &[String],
    bundled_kb_path: &Path,
) -> Result<ExtractPreview, String> {
    progress(&ImportProgress::Fetching { url: request.url.clone() });
    let html_content = real_http_fetch(&request.url).await?;

    // Stage 2: Extract text from HTML (Phase 5.2: preserves <pre>/<code> fences)
    let text_content = extract_text_from_html(&html_content);
    extract_from_text(request, text_content, config, progress, platform_index, allowed_categories, bundled_kb_path).await
}

/// Variant of `extract_from_url` for pre-fetched text (paste-text import):
/// the user's browser did the fetching, so stages 2–4 run on the given text.
pub async fn extract_from_text(
    request: ImportRequest,
    text_content: String,
    config: &AppConfig,
    progress: &ProgressFn<'_>,
    platform_index: &PlatformIndex,
    allowed_categories: &[String],
    bundled_kb_path: &Path,
) -> Result<ExtractPreview, String> {
    let mut errors: Vec<String> = Vec::new();

    progress(&ImportProgress::ExtractingText { content_length: text_content.len() });

    if text_content.trim().is_empty() {
        return Err("No text content was provided. Paste the page text (Ctrl+A, Ctrl+C in your browser, then paste here) and try again.".to_string());
    }

    // Stage 3: Send to the configured LLM for extraction (Phase 5.1: token-aware)
    progress(&ImportProgress::SendingToLlm { });

    let llm = LlmClient::new(
        config.llm_base_url.clone(),
        config.llm_model.clone(),
        crate::config::get_llm_api_key()?,
        config.llm_context_length,
        config.llm_api_format.clone(),
    );

    // Allowed categories (from the KB + frontend) injected into the prompt so
    // the LLM can pick the best fit per command instead of one forced bucket.
    let existing_categories = allowed_categories.to_vec();

    // Streaming: report received LLM output so the UI shows liveness.
    let on_output = |chars: usize, tail: &str| {
        progress(&ImportProgress::LlmOutput { chars, tail: tail.to_string() });
    };

    // Chunked extraction (docs/10): large pages produce oversized JSON that
    // exceeds the model's output-token limit (truncated mid-string). Split
    // the source text so each call's output stays well under the limit.
    let chunks = split_text_chunks(&text_content, CHUNK_EXTRACTION_CHARS);
    let mut extracted: Vec<ExtractedCommand> = Vec::new();

    if chunks.len() == 1 {
        extracted = llm.extract_commands(
            &chunks[0],
            &request.platform,
            &request.category,
            platform_index,
            &existing_categories,
            &on_output,
        ).await.map_err(|e| {
            progress(&ImportProgress::Error { message: e.clone() });
            e
        })?;
    } else {
        // One failing chunk doesn't kill the import — collect its error and
        // continue; the user still gets the commands the other chunks found.
        let total = chunks.len();
        let mut chunk_errors: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (i, chunk) in chunks.iter().enumerate() {
            progress(&ImportProgress::ExtractingChunk { chunk: i + 1, total });
            match llm.extract_commands(
                chunk,
                &request.platform,
                &request.category,
                platform_index,
                &existing_categories,
                &on_output,
            ).await {
                Ok(cmds) => {
                    for cmd in cmds {
                        if seen.insert(cmd.name.clone()) {
                            extracted.push(cmd);
                        } else {
                            log::info!("Chunk {}: deduped duplicate command from earlier chunk", i + 1);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Chunk {}/{} extraction failed: {}", i + 1, total, e);
                    chunk_errors.push(format!("chunk {}/{}: {}", i + 1, total, e));
                }
            }
        }
        if extracted.is_empty() {
            let msg = format!(
                "All {} extraction chunks failed. Last error: {}",
                total,
                chunk_errors.last().map(|s| s.as_str()).unwrap_or("unknown")
            );
            progress(&ImportProgress::Error { message: msg.clone() });
            return Err(msg);
        }
        if !chunk_errors.is_empty() {
            errors.push(format!(
                "{} of {} extraction chunks failed ({}); the remaining chunks were imported",
                chunk_errors.len(),
                total,
                chunk_errors.join("; ")
            ));
        }
        log::info!("Chunked extraction: {} chunks, {} deduped commands", total, extracted.len());
    }

    progress(&ImportProgress::ExtractingCommands {});
    if extracted.is_empty() {
        return Err("No commands were extracted from the documentation. The LLM may not have found any valid commands.".to_string());
    }

    // Stage 4: Validate extracted commands (Phase 5.3: drop bad tokens, keep cmd)
    progress(&ImportProgress::Validating { command_count: extracted.len() });
    let mut previews: Vec<CommandPreview> = Vec::with_capacity(extracted.len());
    for cmd in extracted {
        match validate_extracted_command(cmd, platform_index, allowed_categories, &request.category) {
            Ok((command, issues)) => {
                let has_token_error = issues.iter().any(|i| i.contains("tokens[") && i.contains("error"));
                let status = if has_token_error { "warn" } else { "ok" };
                if has_token_error {
                    let warn = format!("Command '{}' imported with token issues: tokens dropped", command.name);
                    errors.push(warn);
                }
                previews.push(CommandPreview {
                    command,
                    status: status.to_string(),
                    issues,
                    in_bundled: false,
                    bundled: None,
                });
            }
            Err(e) => {
                log::warn!("Skipping invalid command: {}", e);
                errors.push(e);
            }
        }
    }

    if previews.is_empty() {
        return Err("All extracted commands failed validation. Check the LLM output quality.".to_string());
    }

    // Flag which names already exist in the bundled-only KB (docs/10 § 4.1)
    // and carry the bundled command for the compare UI. Load bypasses the
    // merge so the check is against bundled, not the merged store. A missing
    // bundled platform (custom platform) simply means everything is new.
    let mut bundled_by_name: std::collections::HashMap<String, Command> =
        KbStore::load(&request.platform, bundled_kb_path)
            .map(|s| {
                s.commands
                    .into_iter()
                    .map(|c| (c.name.clone(), c))
                    .collect()
            })
            .unwrap_or_default();
    for preview in &mut previews {
        preview.bundled = bundled_by_name.remove(&preview.command.name);
        preview.in_bundled = preview.bundled.is_some();
    }

    Ok(ExtractPreview {
        previews,
        platform: request.platform.clone(),
        category: request.category.clone(),
        source_url: request.url.clone(),
        errors,
    })
}

/// Stage 2 of the two-stage import (Phase 5.6): write the user-approved
/// commands to YAML and trigger a reload. Does not re-extract.
///
/// Invariant: LLM import writes ONLY to the custom (user) KB — never the
/// bundled KB; see docs/specs/10-custom-knowledge-base.md.
pub async fn commit_import(
    commands: Vec<Command>,
    bundled_kb_path: &PathBuf,
    user_kb_path: &PathBuf,
    platform: &str,
    category: &str,
    progress: &ProgressFn<'_>,
    platform_name: Option<&str>,
) -> Result<(), String> {
    if commands.is_empty() {
        return Err("no commands selected".to_string());
    }

    // Commands may carry different categories (LLM per-command picks) —
    // group them so each lands in its own category YAML file.
    let mut by_category: std::collections::BTreeMap<String, Vec<Command>> = std::collections::BTreeMap::new();
    for cmd in &commands {
        let cat = if cmd.category.trim().is_empty() { category.to_string() } else { cmd.category.clone() };
        by_category.entry(cat).or_default().push(cmd.clone());
    }

    let mut primary_target = None;
    for (cat, cmds) in &by_category {
        let target_file = get_target_yaml_path(user_kb_path, platform, cat)?;
        if primary_target.is_none() {
            primary_target = Some(target_file.clone());
        }
        log::info!("Import commit: writing {} command(s) to {}", cmds.len(), target_file.display());
        // write_commands_to_yaml now upgrades legacy entries with tokens (5.4).
        write_commands_to_yaml(cmds, &target_file)?;
    }

    let target_file = primary_target.ok_or_else(|| "no commands selected".to_string())?;
    progress(&ImportProgress::WritingYaml {
        command_count: commands.len(),
        target_file: target_file.display().to_string(),
    });

    ensure_kb_structure(bundled_kb_path, user_kb_path, platform, category, platform_name)?;

    progress(&ImportProgress::ReloadingKb {});

    // Final event — the title-bar indicator clears on this.
    progress(&ImportProgress::Complete {
        commands_imported: commands.len(),
        target_file: target_file.display().to_string(),
    });
    Ok(())
}

// ─── URL Fetching ───────────────────────────────────────────────────

/// Validate a fetch URL: HTTPS only, no private/loopback IP literals
/// (v4 and v6, including ULA, link-local, and IPv4-mapped addresses).
/// ponytail: hostnames are still not DNS-resolved and redirects are followed
/// by reqwest, so a public name resolving to (or redirecting to) a private
/// IP passes. Accepted risk: the URL is user-supplied and the response only
/// feeds the LLM. Add post-redirect IP re-checks if SSRF becomes a real vector.
fn validate_fetch_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Only HTTPS URLs are allowed (got '{}')", parsed.scheme()));
    }
    if let Some(host) = parsed.host_str() {
        // IPv6 hosts serialize as "[...]" — strip the brackets before parsing.
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
            let disallowed = match ip {
                std::net::IpAddr::V4(v4) => {
                    v4.is_loopback() || v4.is_private() || v4.is_link_local()
                        || v4.is_unspecified() || v4.is_broadcast()
                }
                std::net::IpAddr::V6(v6) => {
                    // ULA fc00::/7 and link-local fe80::/10 — std has no
                    // stable predicates for these, so bit-check the segments.
                    let s = v6.segments();
                    let ula = (s[0] & 0xfe00) == 0xfc00;
                    let link_local = (s[0] & 0xffc0) == 0xfe80;
                    // IPv4-mapped (::ffff:a.b.c.d) must face the same v4 checks.
                    let mapped_private = v6
                        .to_ipv4_mapped()
                        .map(|v4| {
                            v4.is_loopback() || v4.is_private() || v4.is_link_local()
                                || v4.is_unspecified() || v4.is_broadcast()
                        })
                        .unwrap_or(false);
                    v6.is_loopback() || v6.is_unspecified() || ula || link_local || mapped_private
                }
            };
            if disallowed {
                return Err(format!("URL host '{}' is not a public address", host));
            }
        }
    }
    Ok(())
}

async fn real_http_fetch(url: &str) -> Result<String, String> {
    validate_fetch_url(url)?;
    log::info!("Fetching URL: {}", url);

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.5".parse().unwrap());

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        log::warn!("HTTP {} for {}: {}", status, url, status.canonical_reason().unwrap_or("Unknown"));
        let friendly = match status.as_u16() {
            403 => format!(
                "HTTP 403 Forbidden — The server at '{}' blocked this request. This often happens with Cisco and other vendor documentation sites. Try a different URL (e.g., a raw GitHub-hosted doc or a different vendor page), or wait and retry later.",
                url.split('/').nth(2).unwrap_or(url)
            ),
            404 => format!(
                "HTTP 404 Not Found — The page '{}' no longer exists or the URL has moved. Check the URL and try again.",
                url
            ),
            401 | 407 => format!(
                "HTTP {} — This URL requires authentication or a proxy. Try a different publicly accessible URL.",
                status
            ),
            429 => format!(
                "HTTP 429 Too Many Requests — You've been rate-limited. Wait a minute and try again, or use a different URL."
            ),
            _ => format!("HTTP {}: {}", status, status.canonical_reason().unwrap_or("Unknown")),
        };
        return Err(friendly);
    }

    let content = response.text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    log::info!("Fetched {} bytes from {}", content.len(), url);
    Ok(content)
}

// ─── HTML → Text Extraction ─────────────────────────────────────────

/// Extract readable text from HTML. Phase 5.2: wrap `<pre>`/`<code>` block
/// text in ``` fences so the LLM sees command syntax as distinct monospace
/// blocks and maps them to `tokens` more reliably. Inline `<code>` is also
/// fenced when it sits on its own line (matches a common docs pattern).
fn extract_text_from_html(html: &str) -> String {
    use scraper::{Html, Selector};

    let document = Html::parse_document(html);

    // Remove scripts, styles, nav, footer — we only want content
    let remove_selectors = ["script", "style", "nav", "footer", "header", "noscript"];
    let mut text_parts: Vec<String> = Vec::new();

    // Try to find main content area first
    let main_selectors = ["main", "article", "[role='main']", ".content", "#content", ".documentation", "#main"];

    for selector_str in &main_selectors {
        if let Ok(selector) = Selector::parse(selector_str) {
            for element in document.select(&selector) {
                let text = clean_element_text(&element, &remove_selectors);
                if !text.trim().is_empty() {
                    text_parts.push(text);
                }
            }
        }
    }

    // If no main content found, use body
    if text_parts.is_empty() {
        if let Ok(selector) = Selector::parse("body") {
            for element in document.select(&selector) {
                let text = clean_element_text(&element, &remove_selectors);
                if !text.trim().is_empty() {
                    text_parts.push(text);
                }
            }
        }
    }

    let result = text_parts.join("\n\n");

    // Clean up: collapse multiple blank lines, trim whitespace
    let cleaned = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<&str>>()
        .join("\n");

    cleaned
}

fn clean_element_text(element: &scraper::ElementRef, remove_tags: &[&str]) -> String {
    // Recursively extract text, skipping elements with tag names in remove_tags.
    // Phase 5.2: `<pre>` and `<code>` blocks emit fenced text so the LLM sees
    // command syntax as distinct monospace blocks (Cisco/F5/Juniper docs put
    // command syntax in `<pre>`).
    fn collect_text(element: &scraper::ElementRef, skip_tags: &std::collections::HashSet<&str>) -> String {
        let tag = element.value().name();
        if skip_tags.contains(tag) {
            return String::new();
        }
        // Fence <pre>/<code> blocks so the LLM sees the structural cue that
        // "this monospace block is a command, this paragraph is description".
        let is_pre = tag == "pre" || tag == "code";
        let mut parts = Vec::new();
        for child in element.children() {
            if let Some(child_el) = scraper::ElementRef::wrap(child) {
                let text = collect_text(&child_el, skip_tags);
                if !text.is_empty() {
                    parts.push(text);
                }
            } else {
                // Text node
                let raw = child.value().as_text().map(|t| t.trim()).unwrap_or("");
                if !raw.is_empty() {
                    parts.push(raw.to_string());
                }
            }
        }
        let joined = parts.join(if is_pre { "\n" } else { " " });
        if is_pre && !joined.trim().is_empty() {
            // Wrap block content in a ``` fence. The newline preserves block
            // boundaries when the surrounding context joins with spaces.
            format!("```\n{}\n```", joined.trim())
        } else {
            joined
        }
    }

    let skip_tags: std::collections::HashSet<&str> = remove_tags.iter().cloned().collect();
    collect_text(element, &skip_tags)
}

// ─── Validation ─────────────────────────────────────────────────────

/// Validate an extracted command. Phase 5.3: maps the LLM's tokens/order/
/// negatable into the KB `Command`, runs the validator, and — if any token
/// has an `error`-severity issue — drops the tokens (keeps the command as a
/// legacy entry) so the import doesn't fail on one malformed token while
/// still surfacing the warning.
///
/// Returns `(Command, Vec<String>)` where the strings are human-readable
/// validation issue messages (empty when clean).
fn validate_extracted_command(
    extracted: ExtractedCommand,
    platform_index: &PlatformIndex,
    allowed_categories: &[String],
    default_category: &str,
) -> Result<(Command, Vec<String>), String> {
    if extracted.name.trim().is_empty() {
        return Err("Command name is empty".to_string());
    }

    // Clean up the name
    let name = extracted.name.trim().to_lowercase();

    // Validate it looks like a command (not random text)
    if name.len() < 2 {
        return Err(format!("Command name too short: '{}'", name));
    }

    // Mode must be one this platform actually has, otherwise the suggestion
    // engine's mode filter silently hides the command. LLM output is unreliable
    // here, so unknown/missing modes fall back to the platform default.
    let mode = extracted
        .mode
        .as_deref()
        .filter(|m| {
            platform_index.prompt_patterns.contains_key(*m) || *m == platform_index.default_mode
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| platform_index.default_mode.clone());

    // Category: the LLM may pick per-command from the allowed list (a page
    // can cover several categories). Unknown/missing → requested category.
    let category = extracted
        .category
        .as_deref()
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty() && allowed_categories.iter().any(|a| a == c))
        .unwrap_or_else(|| default_category.to_string());

    // Map extracted command to our Command struct (Phase 5.1: tokens/order/negatable)
    let mut command = Command {
        name,
        syntax: extracted.syntax.unwrap_or_default(),
        description: extracted.description.unwrap_or_default(),
        category: category.clone(),
        mode,
        aliases: extracted.aliases,
        examples: extracted.examples.into_iter().map(|ex| CommandExample {
            command: ex.command,
            description: ex.description,
        }).collect(),
        versions: CommandVersions {
            introduced: None,
            deprecated: None,
            notes: None,
        },
        tags: extracted.tags,
        tokens: extracted.tokens,
        order: extracted.order,
        negatable: extracted.negatable,
        source: None,
        overrides: false,
    };

    // Phase 5.3: run the validator. Any error-severity issue touching `tokens`
    // means the tokens are unusable — drop them and downgrade the command to a
    // legacy entry (still valid for name-prefix matching). Keep the command;
    // surface a warning so the review dialog can flag it.
    let issues = validate_command(&command);
    let token_errors: Vec<String> = issues.iter()
        .filter(|i| i.severity == "error" && i.message.contains("tokens["))
        .map(|i| i.message.clone())
        .collect();

    let final_issues: Vec<String> = if !token_errors.is_empty() {
        log::warn!("Command '{}' had token errors; dropping tokens: {:?}", command.name, token_errors);
        command.tokens.clear();
        command.order = CommandOrder::Fixed;
        command.negatable = false;
        issues.into_iter()
            .filter(|i| !(i.severity == "error" && i.message.contains("tokens[")))
            .map(|i| i.message)
            .chain(token_errors.iter().cloned())
            .collect()
    } else {
        issues.into_iter().map(|i| i.message).collect()
    };

    Ok((command, final_issues))
}

// ─── File Operations ────────────────────────────────────────────────

/// Ensure the KB directory structure exists for a platform/category.
fn ensure_kb_structure(bundled_kb_path: &PathBuf, user_kb_path: &PathBuf, platform: &str, _category: &str, platform_name: Option<&str>) -> Result<(), String> {
    let platform_dir = user_kb_path.join(platform);
    let commands_dir = platform_dir.join("commands");

    std::fs::create_dir_all(&commands_dir)
        .map_err(|e| format!("Failed to create KB directory {}: {}", commands_dir.display(), e))?;

    // Ensure index.yaml exists for the platform
    let index_path = platform_dir.join("index.yaml");
    if !index_path.exists() {
        create_platform_index(bundled_kb_path, platform, &index_path, platform_name)?;
    }

    Ok(())
}

/// Single source of truth for what a truly-new (user's other software)
/// platform looks like: single-mode, no prompt patterns — the prompt detector
/// falls back to `default_mode` and suggestions are unfiltered by mode.
/// Used both for the extract-stage placeholder index and the on-disk scaffold.
pub fn new_platform_index(id: &str, name: &str) -> PlatformIndex {
    PlatformIndex {
        id: id.to_string(),
        name: name.to_string(),
        description: format!("Imported platform — {name}"),
        reference_url: String::new(),
        versions: vec![],
        prompt_patterns: std::collections::HashMap::new(),
        default_mode: "default".to_string(),
        negation_prefix: None,
        prefix_commands: std::collections::HashMap::new(),
    }
}

/// Create a platform index.yaml for a new platform.
/// Single source of truth: copy the bundled index verbatim when present, so
/// the scaffold always matches what ships in `knowledge-base/`. Truly-new
/// platforms (user's other software, docs/10 § Part 5) get the
/// `new_platform_index` scaffold; no prompt-pattern authoring UI this phase —
/// users who want modes edit `index.yaml` by hand.
fn create_platform_index(bundled_kb_path: &PathBuf, platform: &str, path: &PathBuf, platform_name: Option<&str>) -> Result<(), String> {
    let bundled_index = bundled_kb_path.join(platform).join("index.yaml");
    let content: Vec<u8> = if bundled_index.exists() {
        std::fs::read(&bundled_index)
            .map_err(|e| format!("Failed to read bundled index {}: {}", bundled_index.display(), e))?
    } else {
        let index = new_platform_index(platform, platform_name.unwrap_or(platform));
        serde_yml::to_string(&index)
            .map_err(|e| format!("Failed to serialize new platform index: {}", e))?
            .into_bytes()
    };

    crate::paths::atomic_write(path, &content)
        .map_err(|e| format!("Failed to write index.yaml: {}", e))?;

    log::info!("Created platform index: {}", path.display());
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_platform_index_matches_bundled() {
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("knowledge-base");

        for platform in ["cisco-iosxe", "cisco-nxos", "f5-tmos", "linux-bash"] {
            let tmp = std::env::temp_dir().join(format!(
                "netssh-idx-test-{}-{}",
                std::process::id(),
                platform
            ));
            let _ = std::fs::remove_dir_all(&tmp);
            std::fs::create_dir_all(&tmp).unwrap();

            let user_index = tmp.join("index.yaml");
            create_platform_index(&bundled, platform, &user_index, None).unwrap();

            let expected = std::fs::read(bundled.join(platform).join("index.yaml")).unwrap();
            let actual = std::fs::read(&user_index).unwrap();
            assert_eq!(actual, expected, "scaffold for {platform} diverged from bundled index");

            let _ = std::fs::remove_dir_all(&tmp);
        }
    }

    #[test]
    fn test_create_platform_index_new_platform_scaffold() {
        // Truly-new platform (docs/10 § Part 5): minimal single-mode scaffold
        // with the user-supplied display name and default_mode "default".
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("knowledge-base");
        let tmp = std::env::temp_dir().join(format!(
            "netssh-idx-new-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let user_index = tmp.join("index.yaml");
        create_platform_index(&bundled, "my-nos", &user_index, Some("My NOS")).unwrap();

        let content = std::fs::read_to_string(&user_index).unwrap();
        assert!(content.contains("id: my-nos"));
        assert!(content.contains("name: My NOS"));
        assert!(content.contains("prompt_patterns: {}"));
        assert!(content.contains("default_mode: default"));

        // The scaffold parses as a PlatformIndex and has no modes.
        let index: PlatformIndex = serde_yml::from_str(&content).unwrap();
        assert!(index.prompt_patterns.is_empty());
        assert_eq!(index.default_mode, "default");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_extract_text_from_html_basic() {
        let html = r#"
            <html>
                <body>
                    <main>
                        <h1>show ip route</h1>
                        <p>Displays the IP routing table.</p>
                        <p>Syntax: show ip route [network]</p>
                    </main>
                </body>
            </html>
        "#;
        let text = extract_text_from_html(html);
        assert!(!text.is_empty());
        assert!(text.contains("show ip route"));
    }

    #[test]
    fn test_extract_text_preserves_pre_blocks() {
        // Phase 5.2: <pre>/<code> content is fenced so the LLM sees command
        // syntax as a distinct monospace block.
        let html = r#"
            <html><body><main>
                <p>Syntax:</p>
                <pre>show ip route [network]</pre>
                <p>Displays the IP routing table.</p>
            </main></body></html>
        "#;
        let text = extract_text_from_html(html);
        assert!(text.contains("```"), "pre block not fenced: {}", text);
        assert!(text.contains("show ip route [network]"));
    }

    #[test]
    fn test_extract_text_removes_scripts() {
        let html = r#"
            <html>
                <body>
                    <script>var x = 1;</script>
                    <main>
                        <p>Command: show version</p>
                    </main>
                </body>
            </html>
        "#;
        let text = extract_text_from_html(html);
        assert!(!text.contains("var x"));
        assert!(text.contains("show version"));
    }

    fn iosxe_index() -> PlatformIndex {
        let mut prompt_patterns = std::collections::HashMap::new();
        prompt_patterns.insert("privileged-exec".to_string(), "^[\\w\\-]+#".to_string());
        prompt_patterns.insert("global-config".to_string(), "^[\\w\\-]+\\(config\\)#".to_string());
        PlatformIndex {
            id: "cisco-iosxe".to_string(),
            name: "Cisco IOS-XE".to_string(),
            description: String::new(),
            reference_url: String::new(),
            versions: vec![],
            prompt_patterns,
            default_mode: "privileged-exec".to_string(),
            negation_prefix: Some("no ".to_string()),
            prefix_commands: std::collections::HashMap::new(),
        }
    }

    fn linux_index() -> PlatformIndex {
        let mut prompt_patterns = std::collections::HashMap::new();
        prompt_patterns.insert("shell".to_string(), "^.*[\\$#]\\s*$".to_string());
        PlatformIndex {
            id: "linux-bash".to_string(),
            name: "Linux Bash".to_string(),
            description: String::new(),
            reference_url: String::new(),
            versions: vec![],
            prompt_patterns,
            default_mode: "shell".to_string(),
            negation_prefix: None,
            prefix_commands: std::collections::HashMap::new(),
        }
    }

    // Helper: build an ExtractedCommand with the new optional fields defaulted.
    fn mk_extracted(name: &str, mode: Option<&str>) -> ExtractedCommand {
        ExtractedCommand {
            name: name.to_string(),
            syntax: None,
            description: None,
            mode: mode.map(|s| s.to_string()),
            category: None,
            aliases: vec![],
            examples: vec![],
            tags: vec![],
            tokens: vec![],
            order: CommandOrder::Fixed,
            negatable: false,
        }
    }

    #[test]
    fn test_validate_extracted_command_valid() {
        let extracted = ExtractedCommand {
            name: "show ip route".to_string(),
            syntax: Some("show ip route [network]".to_string()),
            description: Some("Displays the routing table.".to_string()),
            mode: Some("privileged-exec".to_string()),
            category: None,
            aliases: vec!["sh ip ro".to_string()],
            examples: vec![],
            tags: vec!["routing".to_string()],
            tokens: vec![],
            order: CommandOrder::Fixed,
            negatable: false,
        };

        let (cmd, issues) = validate_extracted_command(extracted, &iosxe_index(), &[], "networking").unwrap();
        assert_eq!(cmd.name, "show ip route");
        assert_eq!(cmd.mode, "privileged-exec");
        assert_eq!(cmd.category, "networking");
        // No token errors → empty issues (warnings only are still surfaced).
        assert!(issues.iter().all(|m| !m.contains("tokens[")));
    }

    #[test]
    fn test_validate_extracted_command_empty_name() {
        let mut extracted = mk_extracted("  ", None);
        extracted.name = "  ".to_string();
        assert!(validate_extracted_command(extracted, &iosxe_index(), &[], "networking").is_err());
    }

    #[test]
    fn test_validate_extracted_command_minimal() {
        let extracted = mk_extracted("show version", None);
        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index(), &[], "networking").unwrap();
        assert_eq!(cmd.name, "show version");
        // Missing mode falls back to the platform default
        assert_eq!(cmd.mode, "privileged-exec");
    }

    #[test]
    fn test_validate_extracted_command_foreign_mode_falls_back() {
        // LLM returned a Cisco mode for a linux command — must be coerced to
        // the platform default, or the mode filter hides it from suggestions.
        let extracted = mk_extracted("ip addr", Some("privileged-exec"));
        let (cmd, _issues) = validate_extracted_command(extracted, &linux_index(), &[], "networking").unwrap();
        assert_eq!(cmd.mode, "shell");
    }

    #[test]
    fn test_validate_extracted_command_llm_category_used_when_allowed() {
        // LLM picks a different category from the allowed list — kept.
        let mut extracted = mk_extracted("show ip route", None);
        extracted.category = Some("routing".to_string());
        let allowed = vec!["networking".to_string(), "routing".to_string()];
        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index(), &allowed, "networking").unwrap();
        assert_eq!(cmd.category, "routing");
    }

    #[test]
    fn test_validate_extracted_command_llm_category_unknown_falls_back() {
        // LLM invents a category — coerced to the requested one.
        let mut extracted = mk_extracted("show ip route", None);
        extracted.category = Some("made-up".to_string());
        let allowed = vec!["networking".to_string(), "routing".to_string()];
        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index(), &allowed, "networking").unwrap();
        assert_eq!(cmd.category, "networking");
    }

    #[test]
    fn test_validate_extracted_command_drops_bad_tokens_keeps_command() {
        // Phase 5.3: a malformed token (empty lit) should drop the tokens but
        // keep the command as a legacy entry.
        use crate::kb::CommandToken;
        let extracted = ExtractedCommand {
            name: "show ip route".to_string(),
            syntax: Some("show ip route".to_string()),
            description: None,
            mode: Some("privileged-exec".to_string()),
            category: None,
            aliases: vec![],
            examples: vec![],
            tags: vec![],
            tokens: vec![
                CommandToken::Lit { lit: " ".to_string(), optional: false },
            ],
            order: CommandOrder::Fixed,
            negatable: false,
        };

        let (cmd, issues) = validate_extracted_command(extracted, &iosxe_index(), &[], "networking").unwrap();
        // Command kept
        assert_eq!(cmd.name, "show ip route");
        // Tokens dropped (downgraded to legacy)
        assert!(cmd.tokens.is_empty(), "tokens should be dropped, got {:?}", cmd.tokens);
        assert!(matches!(cmd.order, CommandOrder::Fixed));
        // Issue surfaced
        assert!(issues.iter().any(|m| m.contains("tokens[")), "expected token issue in {:?}", issues);
    }

    #[test]
    fn test_validate_extracted_command_passes_good_tokens() {
        use crate::kb::CommandToken;
        let extracted = ExtractedCommand {
            name: "show ip interface brief".to_string(),
            syntax: Some("show ip interface [brief]".to_string()),
            description: None,
            mode: Some("privileged-exec".to_string()),
            category: None,
            aliases: vec![],
            examples: vec![],
            tags: vec![],
            tokens: vec![
                CommandToken::Lit { lit: "show ip interface".to_string(), optional: false },
                CommandToken::Choice { choice: vec!["brief".to_string()], optional: true, repeatable: false, descriptions: Default::default() },
            ],
            order: CommandOrder::Fixed,
            negatable: false,
        };

        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index(), &[], "networking").unwrap();
        assert_eq!(cmd.tokens.len(), 2, "good tokens should survive, got {:?}", cmd.tokens);
    }

    #[test]
    fn test_split_text_chunks_small_page_single_chunk() {
        let text = "show ip route\nshow version\nping 10.0.0.1";
        let chunks = split_text_chunks(text, 12_000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], text);
    }

    #[test]
    fn test_split_text_chunks_respects_limit() {
        let line = "show ip route — displays the routing table and forwarding state"; // ~64 chars
        let text = std::iter::repeat(line).take(300).collect::<Vec<_>>().join("\n");
        assert!(text.chars().count() > 12_000, "test text must exceed the chunk limit");

        let chunks = split_text_chunks(&text, 12_000);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.chars().count() <= 12_000, "chunk is {} chars, exceeds limit", c.chars().count());
            assert!(!c.trim().is_empty());
        }
        // No content lost: every line appears across the chunks.
        let joined = chunks.join("\n");
        assert_eq!(joined.split('\n').count(), 300);
    }

    #[test]
    fn test_split_text_chunks_monster_line_hard_split() {
        // A single 25k-char line with no newlines must hard-split by chars.
        let text = "x".repeat(25_000);
        let chunks = split_text_chunks(&text, 12_000);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.chars().count() <= 12_000);
        }
        let total: usize = chunks.iter().map(|c| c.chars().count()).sum();
        assert_eq!(total, 25_000);
    }

    #[test]
    fn test_merge_commands_adds_new() {
        let existing = vec![Command {
            name: "show ip route".to_string(),
            syntax: "show ip route".to_string(),
            description: "Routing table".to_string(),
            category: String::new(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens: vec![],
            order: Default::default(),
            negatable: false,
            source: None,
            overrides: false,
        }];

        let new_cmd = Command {
            name: "show version".to_string(),
            syntax: "show version".to_string(),
            description: "System version".to_string(),
            category: String::new(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens: vec![],
            order: Default::default(),
            negatable: false,
            source: None,
            overrides: false,
        };

        // Simulate the merge logic
        let mut merged = existing;
        let cmd = &new_cmd;
        if !merged.iter().any(|c| c.name == cmd.name) {
            merged.push(new_cmd);
        }

        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn test_validate_fetch_url() {
        // accepts public HTTPS
        assert!(validate_fetch_url("https://example.com/page").is_ok());
        assert!(validate_fetch_url("https://93.184.216.34/").is_ok());
        // rejects non-HTTPS
        assert!(validate_fetch_url("http://example.com").is_err());
        assert!(validate_fetch_url("ftp://example.com").is_err());
        // rejects private IPs
        assert!(validate_fetch_url("https://192.168.1.1/").is_err());
        assert!(validate_fetch_url("https://10.0.0.1/").is_err());
        assert!(validate_fetch_url("https://172.16.0.1/").is_err());
        // rejects loopback, link-local, unspecified
        assert!(validate_fetch_url("https://127.0.0.1/").is_err());
        assert!(validate_fetch_url("https://169.254.1.1/").is_err());
        assert!(validate_fetch_url("https://0.0.0.0/").is_err());

        // IPv6: ULA, link-local, loopback, mapped-v4 rejected; public v6 ok
        assert!(validate_fetch_url("https://[fd12:3456::1]/").is_err());
        assert!(validate_fetch_url("https://[fe80::1]/").is_err());
        assert!(validate_fetch_url("https://[::1]/").is_err());
        assert!(validate_fetch_url("https://[::ffff:10.0.0.1]/").is_err());
        assert!(validate_fetch_url("https://[2606:4700::1111]/").is_ok());
        // rejects invalid URLs
        assert!(validate_fetch_url("not a url").is_err());
        assert!(validate_fetch_url("").is_err());
    }

    // ─── Pipeline tests (step 4) ──────────────────────────────────────

    use crate::llm::sse_test_mock::sse_mock_n;

    fn sse_json(commands: &[&str]) -> String {
        let cmds: Vec<serde_json::Value> = commands
            .iter()
            .map(|name| serde_json::json!({
                "name": name,
                "syntax": null,
                "description": format!("Desc for {}", name),
                "mode": null,
                "category": null,
                "aliases": [],
                "examples": [],
                "tags": [],
                "tokens": [],
                "order": "fixed",
                "negatable": false
            }))
            .collect();
        let payload = serde_json::json!({"commands": cmds});
        let chunk = serde_json::json!({"choices":[{"delta":{"content": payload.to_string()}}]});
        format!("data: {}\n\ndata: [DONE]\n\n", chunk)
    }

    fn test_config(base_url: &str) -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.llm_base_url = base_url.to_string();
        cfg
    }

    #[tokio::test]
    async fn test_extract_single_chunk_happy_path() {
        let sse_body = sse_json(&["show ip route", "show version"]);
        let addr = sse_mock_n(vec![Some(sse_body)]);
        let base_url = format!("http://{}", addr);

        let request = ImportRequest {
            url: "http://example.com/docs".to_string(),
            platform: "cisco-iosxe".to_string(),
            category: "networking".to_string(),
        };
        let text = "show ip route\nshow version\nsome documentation text";
        let config = test_config(&base_url);
        let index = iosxe_index();
        let progress: &ProgressFn<'_> = &|_| {};

        let bundled = crate::paths::bundled_kb_path(Path::new(""));
        let result = extract_from_text(request, text.to_string(), &config, progress, &index, &[], &bundled).await;
        assert!(result.is_ok(), "extract failed: {:?}", result.err());
        let preview = result.unwrap();
        assert_eq!(preview.previews.len(), 2);
        assert_eq!(preview.previews[0].command.name, "show ip route");
        assert_eq!(preview.previews[1].command.name, "show version");
        assert!(preview.previews.iter().all(|p| p.status == "ok"));
    }

    #[tokio::test]
    async fn test_extract_multi_chunk_partial_failure() {
        // 3 chunks: need text > 24K chars (CHUNK_EXTRACTION_CHARS = 12_000)
        let filler = "lorem ipsum dolor sit amet ";
        let text = std::iter::repeat(filler).take(1000).collect::<String>();
        assert!(text.len() > 24_000, "text too short: {}", text.len());

        let sse_a = sse_json(&["show ip route"]);
        let sse_b = sse_json(&["show version"]);
        // chunk 1 ok, chunk 2 fails (HTTP 500), chunk 3 ok
        let addr = sse_mock_n(vec![Some(sse_a), None, Some(sse_b)]);
        let base_url = format!("http://{}", addr);

        let request = ImportRequest {
            url: "http://example.com/big-docs".to_string(),
            platform: "cisco-iosxe".to_string(),
            category: "networking".to_string(),
        };
        let config = test_config(&base_url);
        let index = iosxe_index();
        let progress: &ProgressFn<'_> = &|_| {};

        let bundled = crate::paths::bundled_kb_path(Path::new(""));
        let result = extract_from_text(request, text, &config, progress, &index, &[], &bundled).await;
        assert!(result.is_ok(), "extract failed: {:?}", result.err());
        let preview = result.unwrap();
        // Commands from chunks 1 and 3 survive; chunk 2 error is surfaced
        assert_eq!(preview.previews.len(), 2);
        assert_eq!(preview.previews[0].command.name, "show ip route");
        assert_eq!(preview.previews[1].command.name, "show version");
        assert_eq!(preview.errors.len(), 1);
        assert!(preview.errors[0].contains("chunk 2/3"), "unexpected error: {}", preview.errors[0]);
    }
}

// Tauri Commands (moved from lib.rs)

fn tauri_progress(app_handle: &tauri::AppHandle) -> impl Fn(&ImportProgress) + '_ {
    move |p: &ImportProgress| {
        log::info!("import progress: {:?}", p);
        let _ = app_handle.emit("import-progress", p);
    }
}

/// Resolve the platform index and the allowed-category list for an extract
/// request. When the platform has no KB yet and `platform_name` is set (the
/// user chose "New platform..." in the import dialog), a placeholder
/// single-mode index is unlocked; without it the error passes through
/// (guards against platform-id typos). A platform with no categories yet
/// falls back to the requested category so validation doesn't reject every
/// LLM-picked category.
fn resolve_index_and_categories(
    kb: &mut KbManager,
    platform: &str,
    category: &str,
    platform_name: Option<&str>,
) -> Result<(PlatformIndex, Vec<String>), String> {
    let idx = match kb.get_platform_index(platform) {
        Ok(idx) => idx,
        Err(e) => match platform_name {
            Some(name) => {
                log::info!("Import: using placeholder single-mode index for new platform '{}'", platform);
                new_platform_index(platform, name)
            }
            None => return Err(e),
        },
    };
    let cats = kb.categories_for_platform(platform);
    let allowed = if cats.is_empty() {
        vec![category.to_string()]
    } else {
        cats
    };
    Ok((idx, allowed))
}

/// Phase 5.6: Stage 1 of the two-stage import ÔÇö extract + validate without
/// writing. Returns a preview the user reviews before committing.
///
/// `platformName` is supplied only when the user chose "New platformÔÇª" in the
/// import dialog (docs/10 ┬º Part 5): it unlocks a placeholder single-mode
/// index for platforms with no bundled/user KB yet. Without it, unknown
/// platforms still fail extraction (guards against platform-id typos).
#[tauri::command]
pub async fn extract_kb_preview(
    url: String,
    platform: String,
    category: String,
    platform_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExtractPreview, String> {
    let request = ImportRequest { url, platform, category };

    let config_ref = state.config.lock().map_err(|e| e.to_string())?.get().clone();

    let (platform_index, allowed_categories) = {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        resolve_index_and_categories(
            &mut kb,
            &request.platform,
            &request.category,
            platform_name.as_deref(),
        )?
    };

    let progress = tauri_progress(&app_handle);

    let bundled_kb_path = bundled_kb_root(&app_handle);
    let preview = extract_from_url(
        request,
        &config_ref,
        &progress,
        &platform_index,
        &allowed_categories,
        &bundled_kb_path,
    ).await?;

    Ok(preview)
}

/// Paste-text import: same pipeline as `extract_kb_preview` but the source is
/// user-provided page text (their browser did the fetching ÔÇö sidesteps bot
/// blocks and JS-rendered pages).
#[tauri::command]
pub async fn extract_kb_preview_from_text(
    text: String,
    source_url: Option<String>,
    platform: String,
    category: String,
    platform_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExtractPreview, String> {
    let request = ImportRequest {
        url: source_url.unwrap_or_default(),
        platform,
        category,
    };

    let config_ref = state.config.lock().map_err(|e| e.to_string())?.get().clone();

    let (platform_index, allowed_categories) = {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        resolve_index_and_categories(
            &mut kb,
            &request.platform,
            &request.category,
            platform_name.as_deref(),
        )?
    };

    let progress = tauri_progress(&app_handle);

    let bundled_kb_path = bundled_kb_root(&app_handle);
    extract_from_text(request, text, &config_ref, &progress, &platform_index, &allowed_categories, &bundled_kb_path).await
}

/// Phase 5.6: Stage 2 of the two-stage import ÔÇö write the user-approved
/// commands to YAML and reload. Does not re-extract.
///
/// The frontend sends ONLY the accepted previews; committing zero commands
/// is an error. `platformName` names a truly-new platform scaffold (docs/10
/// ┬º Part 5).
#[tauri::command]
pub async fn commit_kb_import(
    previews: Vec<CommandPreview>,
    platform: String,
    category: String,
    platform_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let user_kb_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.user_kb_path()
    };

    let commands: Vec<Command> = previews.into_iter().map(|p| p.command).collect();
    let count = commands.len();

    let progress = tauri_progress(&app_handle);
    let bundled_kb_path = bundled_kb_root(&app_handle);

    commit_import(
        commands,
        &bundled_kb_path,
        &user_kb_path,
        &platform,
        &category,
        &progress,
        platform_name.as_deref(),
    ).await?;

    // Reload KB stores so new commands are immediately available
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }
    state.platforms.lock().map_err(|e| e.to_string())?.rescan();

    Ok(count)
}
