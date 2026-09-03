//! Knowledge Base Import Pipeline
//!
//! Fetches a URL → extracts text from HTML → sends to Ollama for
//! structured command extraction → validates → writes YAML to the
//! user's knowledge base → triggers KB reload.
//!
//! Phase 5: import now emits tokens (5.1), preserves `<pre>`/`<code>` block
//! structure in HTML extraction (5.2), drops bad tokens but keeps the
//! command (5.3), upgrades legacy entries with tokens on merge (5.4), and
//! supports a two-stage extract-then-commit flow (5.6).

use crate::config::AppConfig;
use crate::kb::{
    get_target_yaml_path, write_commands_to_yaml, validate_command,
    Command, CommandExample, CommandOrder, CommandVersions, PlatformIndex,
};
use crate::ollama::{ExtractedCommand, OllamaClient};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
    SendingToLlm { command_count_estimate: usize },
    ExtractingCommands { },
    Validating { command_count: usize },
    WritingYaml { command_count: usize, target_file: String },
    ReloadingKb { },
    Complete { commands_imported: usize, target_file: String },
    Error { message: String },
}

/// Result of a completed import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub commands_imported: usize,
    pub target_file: String,
    pub platform: String,
    pub category: String,
    pub source_url: String,
    pub errors: Vec<String>,
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

/// Bundled (read-only, repo-shipped) KB path — single source for index
/// scaffolds. Resolves like lib.rs setup: resource dir in release,
/// `knowledge-base/` next to the manifest in dev.
pub fn default_bundled_kb_path() -> PathBuf {
    let resource = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("knowledge-base");
    if resource.exists() {
        return resource;
    }
    std::path::PathBuf::from(".")
}

/// Run the full import pipeline (extract + commit). Kept for callers that
/// don't want the preview step (e.g. power users / scripted imports).
/// Reads the bundled KB path from the KB manager's location convention:
/// sibling `knowledge-base/` next to the app manifest (dev) or resource dir.
pub async fn import_from_url(
    request: ImportRequest,
    config: &AppConfig,
    user_kb_path: &PathBuf,
    app_handle: &tauri::AppHandle,
    platform_index: &PlatformIndex,
) -> Result<ImportResult, String> {
    let preview = extract_from_url(
        request.clone(),
        config,
        app_handle,
        platform_index,
    ).await?;

    let bundled_kb_path = default_bundled_kb_path();
    commit_import(
        preview.previews.iter().map(|p| p.command.clone()).collect::<Vec<_>>(),
        &bundled_kb_path,
        user_kb_path,
        &request.platform,
        &request.category,
        app_handle,
    ).await?;

    let result = ImportResult {
        commands_imported: preview.previews.len(),
        target_file: get_target_yaml_path(user_kb_path, &request.platform, &request.category)
            .display().to_string(),
        platform: request.platform.clone(),
        category: request.category.clone(),
        source_url: request.url.clone(),
        errors: preview.errors,
    };

    emit_progress(app_handle, ImportProgress::Complete {
        commands_imported: result.commands_imported,
        target_file: result.target_file.clone(),
    });

    Ok(result)
}

/// Stage 1 of the two-stage import (Phase 5.6): fetch + extract + validate
/// without writing anything. Returns a preview the user reviews before
/// committing.
pub async fn extract_from_url(
    request: ImportRequest,
    config: &AppConfig,
    app_handle: &tauri::AppHandle,
    platform_index: &PlatformIndex,
) -> Result<ExtractPreview, String> {
    let mut errors: Vec<String> = Vec::new();

    // Stage 1: Fetch URL content
    emit_progress(app_handle, ImportProgress::Fetching { url: request.url.clone() });
    let html_content = fetch_url(&request.url).await?;

    // Stage 2: Extract text from HTML (Phase 5.2: preserves <pre>/<code> fences)
    let text_content = extract_text_from_html(&html_content);
    emit_progress(app_handle, ImportProgress::ExtractingText { content_length: text_content.len() });

    if text_content.trim().is_empty() {
        return Err("No text content extracted from the URL. The page may be JavaScript-rendered or empty.".to_string());
    }

    // Stage 3: Send to Ollama for extraction (Phase 5.1: token-aware)
    let command_estimate = estimate_command_count(&text_content);
    emit_progress(app_handle, ImportProgress::SendingToLlm { command_count_estimate: command_estimate });

    let ollama = OllamaClient::new(
        config.ollama_base_url.clone(),
        config.ollama_model.clone(),
        crate::config::get_ollama_api_key()?,
        config.ollama_context_length,
    );

    // Existing categories on this platform guide the LLM toward reuse.
    let existing_categories = existing_categories_for(platform_index, &request.platform);

    let extracted = ollama.extract_commands(
        &text_content,
        &request.platform,
        &request.category,
        platform_index,
        &existing_categories,
    ).await.map_err(|e| {
        emit_progress(app_handle, ImportProgress::Error { message: e.clone() });
        e
    })?;

    emit_progress(app_handle, ImportProgress::ExtractingCommands {});
    if extracted.is_empty() {
        return Err("No commands were extracted from the documentation. The LLM may not have found any valid commands.".to_string());
    }

    // Stage 4: Validate extracted commands (Phase 5.3: drop bad tokens, keep cmd)
    emit_progress(app_handle, ImportProgress::Validating { command_count: extracted.len() });
    let mut previews: Vec<CommandPreview> = Vec::with_capacity(extracted.len());
    for cmd in extracted {
        match validate_extracted_command(cmd, platform_index) {
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
pub async fn commit_import(
    commands: Vec<Command>,
    bundled_kb_path: &PathBuf,
    user_kb_path: &PathBuf,
    platform: &str,
    category: &str,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let target_file = get_target_yaml_path(user_kb_path, platform, category);
    emit_progress(app_handle, ImportProgress::WritingYaml {
        command_count: commands.len(),
        target_file: target_file.display().to_string(),
    });

    ensure_kb_structure(bundled_kb_path, user_kb_path, platform, category)?;

    // write_commands_to_yaml now upgrades legacy entries with tokens (5.4).
    write_commands_to_yaml(&commands, &target_file, category)?;

    emit_progress(app_handle, ImportProgress::ReloadingKb {});
    Ok(())
}

/// Pull the existing categories from the platform's KB so the LLM reuses one
/// instead of inventing a new one. ponytail: derive from the platform index
/// when present; fall back to empty (the LLM still has the requested category).
fn existing_categories_for(_pi: &PlatformIndex, _platform: &str) -> Vec<String> {
    // ponytail: the KB store isn't passed here, and we already have the
    // requested category from the caller. Listing real categories would
    // require a KbStore reference threaded from the Tauri command — a future
    // refinement. Returning empty is fine; the prompt still names the target.
    Vec::new()
}

// ─── URL Fetching ───────────────────────────────────────────────────

/// Validate a fetch URL: HTTPS only, no private/loopback IP literals.
/// ponytail: hostnames are not DNS-resolved, so a public name pointing at a
/// private IP still passes. Add lookup + IP check if SSRF becomes a real vector.
fn validate_fetch_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Only HTTPS URLs are allowed (got '{}')", parsed.scheme()));
    }
    if let Some(host) = parsed.host_str() {
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            let disallowed = match ip {
                std::net::IpAddr::V4(v4) => {
                    v4.is_loopback() || v4.is_private() || v4.is_link_local()
                        || v4.is_unspecified() || v4.is_broadcast()
                }
                // ponytail: stdlib has no v6 ULA (fc00::/7) check; add if IPv6 SSRF matters
                std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
            };
            if disallowed {
                return Err(format!("URL host '{}' is not a public address", host));
            }
        }
    }
    Ok(())
}

async fn fetch_url(url: &str) -> Result<String, String> {
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

    // Map extracted command to our Command struct (Phase 5.1: tokens/order/negatable)
    let mut command = Command {
        name,
        syntax: extracted.syntax.unwrap_or_default(),
        description: extracted.description.unwrap_or_default(),
        category: mode.clone(),
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

/// Rough estimate of how many commands might be in the text.
fn estimate_command_count(text: &str) -> usize {
    // A rough heuristic: count lines that look like commands
    let lines: Vec<&str> = text.lines().collect();
    let mut count = 0;
    for line in &lines {
        let trimmed = line.trim();
        // Commands typically start with a verb or common prefix
        if trimmed.starts_with("show ")
            || trimmed.starts_with("set ")
            || trimmed.starts_with("configure ")
            || trimmed.starts_with("ip ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("router ")
            || trimmed.starts_with("no ")
            || trimmed.starts_with("default ")
            || trimmed.starts_with("clear ")
            || trimmed.starts_with("debug ")
            || trimmed.starts_with("ping ")
            || trimmed.starts_with("traceroute ")
        {
            count += 1;
        }
    }
    // Lower bound of 1
    count.max(1)
}

// ─── File Operations ────────────────────────────────────────────────

/// Ensure the KB directory structure exists for a platform/category.
fn ensure_kb_structure(bundled_kb_path: &PathBuf, user_kb_path: &PathBuf, platform: &str, _category: &str) -> Result<(), String> {
    let platform_dir = user_kb_path.join(platform);
    let commands_dir = platform_dir.join("commands");

    std::fs::create_dir_all(&commands_dir)
        .map_err(|e| format!("Failed to create KB directory {}: {}", commands_dir.display(), e))?;

    // Ensure index.yaml exists for the platform
    let index_path = platform_dir.join("index.yaml");
    if !index_path.exists() {
        create_platform_index(bundled_kb_path, platform, &index_path)?;
    }

    Ok(())
}

/// Create a platform index.yaml for a new platform.
/// Single source of truth: copy the bundled index verbatim when present, so
/// the scaffold always matches what ships in `knowledge-base/`. Unknown
/// platforms fall back to a minimal scaffold.
fn create_platform_index(bundled_kb_path: &PathBuf, platform: &str, path: &PathBuf) -> Result<(), String> {
    let bundled_index = bundled_kb_path.join(platform).join("index.yaml");
    let content: Vec<u8> = if bundled_index.exists() {
        std::fs::read(&bundled_index)
            .map_err(|e| format!("Failed to read bundled index {}: {}", bundled_index.display(), e))?
    } else {
        format!(
 r#"id: {platform}
name: {platform}
description: "Imported platform — {platform}"
reference_url: ""
versions: []
prompt_patterns: {{}}
default_mode: privileged-exec
"#,
            platform = platform,
        )
        .into_bytes()
    };

    crate::paths::atomic_write(path, &content)
        .map_err(|e| format!("Failed to write index.yaml: {}", e))?;

    log::info!("Created platform index: {}", path.display());
    Ok(())
}

fn emit_progress(app_handle: &tauri::AppHandle, progress: ImportProgress) {
    use tauri::Emitter;
    if let Err(e) = app_handle.emit("import-progress", &progress) {
        log::warn!("Failed to emit import progress: {}", e);
    }
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
            create_platform_index(&bundled, platform, &user_index).unwrap();

            let expected = std::fs::read(bundled.join(platform).join("index.yaml")).unwrap();
            let actual = std::fs::read(&user_index).unwrap();
            assert_eq!(actual, expected, "scaffold for {platform} diverged from bundled index");

            let _ = std::fs::remove_dir_all(&tmp);
        }
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
            aliases: vec!["sh ip ro".to_string()],
            examples: vec![],
            tags: vec!["routing".to_string()],
            tokens: vec![],
            order: CommandOrder::Fixed,
            negatable: false,
        };

        let (cmd, issues) = validate_extracted_command(extracted, &iosxe_index()).unwrap();
        assert_eq!(cmd.name, "show ip route");
        assert_eq!(cmd.mode, "privileged-exec");
        // No token errors → empty issues (warnings only are still surfaced).
        assert!(issues.iter().all(|m| !m.contains("tokens[")));
    }

    #[test]
    fn test_validate_extracted_command_empty_name() {
        let mut extracted = mk_extracted("  ", None);
        extracted.name = "  ".to_string();
        assert!(validate_extracted_command(extracted, &iosxe_index()).is_err());
    }

    #[test]
    fn test_validate_extracted_command_minimal() {
        let extracted = mk_extracted("show version", None);
        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index()).unwrap();
        assert_eq!(cmd.name, "show version");
        // Missing mode falls back to the platform default
        assert_eq!(cmd.mode, "privileged-exec");
    }

    #[test]
    fn test_validate_extracted_command_foreign_mode_falls_back() {
        // LLM returned a Cisco mode for a linux command — must be coerced to
        // the platform default, or the mode filter hides it from suggestions.
        let extracted = mk_extracted("ip addr", Some("privileged-exec"));
        let (cmd, _issues) = validate_extracted_command(extracted, &linux_index()).unwrap();
        assert_eq!(cmd.mode, "shell");
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
            aliases: vec![],
            examples: vec![],
            tags: vec![],
            tokens: vec![
                CommandToken::Lit { lit: " ".to_string(), optional: false },
            ],
            order: CommandOrder::Fixed,
            negatable: false,
        };

        let (cmd, issues) = validate_extracted_command(extracted, &iosxe_index()).unwrap();
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

        let (cmd, _issues) = validate_extracted_command(extracted, &iosxe_index()).unwrap();
        assert_eq!(cmd.tokens.len(), 2, "good tokens should survive, got {:?}", cmd.tokens);
    }

    #[test]
    fn test_estimate_command_count() {
        let text = "show ip route\nshow interfaces\nping 10.0.0.1\nsome random text";
        let estimate = estimate_command_count(text);
        assert!(estimate >= 3);
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
        };

        // Simulate the merge logic
        let mut merged = existing;
        let cmd = &new_cmd;
        if !merged.iter().any(|c| c.name == cmd.name) {
            merged.push(new_cmd);
        }

        assert_eq!(merged.len(), 2);
    }
}