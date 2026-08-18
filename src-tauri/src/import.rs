//! Knowledge Base Import Pipeline
//!
//! Fetches a URL → extracts text from HTML → sends to Ollama for
//! structured command extraction → validates → writes YAML to the
//! user's knowledge base → triggers KB reload.

use crate::config::AppConfig;
use crate::kb::{get_target_yaml_path, write_commands_to_yaml, Command, CommandExample, CommandVersions, PlatformIndex};
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

// ─── Pipeline ───────────────────────────────────────────────────────

/// Run the full import pipeline.
pub async fn import_from_url(
    request: ImportRequest,
    config: &AppConfig,
    user_kb_path: &PathBuf,
    app_handle: &tauri::AppHandle,
    platform_index: &PlatformIndex,
) -> Result<ImportResult, String> {
    let mut errors: Vec<String> = Vec::new();

    // Stage 1: Fetch URL content
    emit_progress(app_handle, ImportProgress::Fetching { url: request.url.clone() });
    let html_content = fetch_url(&request.url).await?;

    // Stage 2: Extract text from HTML
    let text_content = extract_text_from_html(&html_content);
    emit_progress(app_handle, ImportProgress::ExtractingText { content_length: text_content.len() });

    if text_content.trim().is_empty() {
        return Err("No text content extracted from the URL. The page may be JavaScript-rendered or empty.".to_string());
    }

    // Stage 3: Send to Ollama for extraction
    let command_estimate = estimate_command_count(&text_content);
    emit_progress(app_handle, ImportProgress::SendingToLlm { command_count_estimate: command_estimate });

    let ollama = OllamaClient::new(
        config.ollama_base_url.clone(),
        config.ollama_model.clone(),
        config.ollama_api_key.clone(),
        config.ollama_context_length,
    );

    let extracted = ollama.extract_commands(
        &text_content,
        &request.platform,
        &request.category,
    ).await.map_err(|e| {
        emit_progress(app_handle, ImportProgress::Error { message: e.clone() });
        e
    })?;

    emit_progress(app_handle, ImportProgress::ExtractingCommands {});
    if extracted.is_empty() {
        return Err("No commands were extracted from the documentation. The LLM may not have found any valid commands.".to_string());
    }

    // Stage 4: Validate extracted commands
    emit_progress(app_handle, ImportProgress::Validating { command_count: extracted.len() });
    let valid_commands: Vec<Command> = extracted
        .into_iter()
        .filter_map(|cmd| {
            match validate_extracted_command(cmd, platform_index) {
                Ok(command) => Some(command),
                Err(e) => {
                    log::warn!("Skipping invalid command: {}", e);
                    errors.push(e);
                    None
                }
            }
        })
        .collect();

    if valid_commands.is_empty() {
        return Err("All extracted commands failed validation. Check the LLM output quality.".to_string());
    }

    // Stage 5: Write to YAML
    let target_file = get_target_yaml_path(user_kb_path, &request.platform, &request.category);
    emit_progress(app_handle, ImportProgress::WritingYaml {
        command_count: valid_commands.len(),
        target_file: target_file.display().to_string(),
    });

    // Ensure directory structure exists
    ensure_kb_structure(user_kb_path, &request.platform, &request.category)?;

    // Write commands to YAML file
    write_commands_to_yaml(&valid_commands, &target_file, &request.category)?;

    // Stage 6: Reload KB
    emit_progress(app_handle, ImportProgress::ReloadingKb {});
    // The reload will be triggered by the Tauri command handler after this returns

    let result = ImportResult {
        commands_imported: valid_commands.len(),
        target_file: target_file.display().to_string(),
        platform: request.platform.clone(),
        category: request.category.clone(),
        source_url: request.url.clone(),
        errors,
    };

    emit_progress(app_handle, ImportProgress::Complete {
        commands_imported: result.commands_imported,
        target_file: result.target_file.clone(),
    });

    Ok(result)
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
    // Recursively extract text, skipping elements with tag names in remove_tags list.
    // This uses scraper's traversal to skip unwanted elements entirely.
    fn collect_text(element: &scraper::ElementRef, skip_tags: &std::collections::HashSet<&str>) -> String {
        let tag = element.value().name();
        if skip_tags.contains(tag) {
            return String::new();
        }
        let mut parts = Vec::new();
        for child in element.children() {
            if let Some(child_el) = scraper::ElementRef::wrap(child) {
                let text = collect_text(&child_el, skip_tags);
                if !text.is_empty() {
                    parts.push(text);
                }
            } else {
                // Text node
                let text = child.value().as_text().map(|t| t.trim()).unwrap_or("");
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
        parts.join(" ")
    }

    let skip_tags: std::collections::HashSet<&str> = remove_tags.iter().cloned().collect();
    collect_text(element, &skip_tags)
}

// ─── Validation ─────────────────────────────────────────────────────

fn validate_extracted_command(extracted: ExtractedCommand, platform_index: &PlatformIndex) -> Result<Command, String> {
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
        .filter(|m| {
            platform_index.prompt_patterns.contains_key(m) || *m == platform_index.default_mode
        })
        .unwrap_or_else(|| platform_index.default_mode.clone());

    // Map extracted command to our Command struct
    let command = Command {
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
    };

    Ok(command)
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
fn ensure_kb_structure(user_kb_path: &PathBuf, platform: &str, _category: &str) -> Result<(), String> {
    let platform_dir = user_kb_path.join(platform);
    let commands_dir = platform_dir.join("commands");

    std::fs::create_dir_all(&commands_dir)
        .map_err(|e| format!("Failed to create KB directory {}: {}", commands_dir.display(), e))?;

    // Ensure index.yaml exists for the platform
    let index_path = platform_dir.join("index.yaml");
    if !index_path.exists() {
        create_platform_index(platform, &index_path)?;
    }

    Ok(())
}

/// Create a minimal platform index.yaml for a new platform.
fn create_platform_index(platform: &str, path: &PathBuf) -> Result<(), String> {
    // Known platform templates — embedded directly for reliability
    let index_content = match platform {
        "cisco-iosxe" => CISCO_IOSXE_INDEX.to_string(),
        "cisco-nxos" => CISCO_NXOS_INDEX.to_string(),
        "f5-tmos" => F5_TMOS_INDEX.to_string(),
        "linux-bash" => LINUX_BASH_INDEX.to_string(),
        _ => format!(
r#"id: {platform}
name: {platform}
description: "Imported platform — {platform}"
reference_url: ""
versions: []
prompt_patterns: {{}}
default_mode: privileged-exec
"#,
            platform = platform,
        ),
    };

    std::fs::write(path, &index_content)
        .map_err(|e| format!("Failed to write index.yaml: {}", e))?;

    log::info!("Created platform index: {}", path.display());
    Ok(())
}

// Platform index templates
const CISCO_IOSXE_INDEX: &str = r#"id: cisco-iosxe
name: Cisco IOS-XE
description: Cisco IOS-XE for routers and enterprise switches
reference_url: "https://www.cisco.com/c/en/us/support/ios-nx-os-software/ios-xe-17/series.html"
versions:
  - "15.x"
  - "16.x"
  - "17.x"
prompt_patterns:
  user-exec: '^[\w\-]+>'
  privileged-exec: '^[\w\-]+#'
  global-config: '^[\w\-]+\(config\)#'
  interface-config: '^[\w\-]+\(config-if\)#'
  routing-config: '^[\w\-]+\(config-router\)#'
  line-config: '^[\w\-]+\(config-line\)#'
default_mode: privileged-exec
"#;

const CISCO_NXOS_INDEX: &str = r#"id: cisco-nxos
name: Cisco NX-OS
description: Cisco NX-OS for Nexus data-center switches
reference_url: "https://www.cisco.com/c/en/us/support/switches/nexus-9000-series-switches/series.html"
versions:
  - "9.x"
  - "10.x"
prompt_patterns:
  user-exec: '^[\w\-]+>'
  privileged-exec: '^[\w\-]+#'
  global-config: '^[\w\-]+\(config\)#'
  interface-config: '^[\w\-]+\(config-if\)#'
  routing-config: '^[\w\-]+\(config-router\)#'
default_mode: privileged-exec
"#;

const F5_TMOS_INDEX: &str = r#"id: f5-tmos
name: F5 TMOS
description: F5 BIG-IP TMOS for load balancers
reference_url: "https://clouddocs.f5.com/"
versions:
  - "15.x"
  - "16.x"
  - "17.x"
prompt_patterns:
  tmsh-root: '^\S+@\S+\(.*\)\(tmos\)#'
  ltm: '^\S+@\S+\(.*\)\(tmos.ltm\)#'
  net: '^\S+@\S+\(.*\)\(tmos.net\)#'
  sys: '^\S+@\S+\(.*\)\(tmos.sys\)#'
  bash: '^\S+:\S+:\S+@'
default_mode: tmsh-root
"#;

const LINUX_BASH_INDEX: &str = r#"id: linux-bash
name: Linux Bash
description: GNU Bash shell on Linux — core utilities, networking, system administration
reference_url: "https://www.gnu.org/software/bash/manual/"
versions: []
prompt_patterns:
  shell: '^\$|^.*[\$#]\s*$'
default_mode: shell
"#;

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
        };

        let cmd = validate_extracted_command(extracted, &iosxe_index()).unwrap();
        assert_eq!(cmd.name, "show ip route");
        assert_eq!(cmd.mode, "privileged-exec");
    }

    #[test]
    fn test_validate_extracted_command_empty_name() {
        let extracted = ExtractedCommand {
            name: "  ".to_string(),
            syntax: None,
            description: None,
            mode: None,
            aliases: vec![],
            examples: vec![],
            tags: vec![],
        };

        assert!(validate_extracted_command(extracted, &iosxe_index()).is_err());
    }

    #[test]
    fn test_validate_extracted_command_minimal() {
        let extracted = ExtractedCommand {
            name: "show version".to_string(),
            syntax: None,
            description: None,
            mode: None,
            aliases: vec![],
            examples: vec![],
            tags: vec![],
        };

        let cmd = validate_extracted_command(extracted, &iosxe_index()).unwrap();
        assert_eq!(cmd.name, "show version");
        // Missing mode falls back to the platform default
        assert_eq!(cmd.mode, "privileged-exec");
    }

    #[test]
    fn test_validate_extracted_command_foreign_mode_falls_back() {
        // LLM returned a Cisco mode for a linux command — must be coerced to
        // the platform default, or the mode filter hides it from suggestions.
        let extracted = ExtractedCommand {
            name: "ip addr".to_string(),
            syntax: None,
            description: None,
            mode: Some("privileged-exec".to_string()),
            aliases: vec![],
            examples: vec![],
            tags: vec![],
        };

        let cmd = validate_extracted_command(extracted, &linux_index()).unwrap();
        assert_eq!(cmd.mode, "shell");
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