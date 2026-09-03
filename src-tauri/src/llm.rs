//! Generic LLM REST client — chat API with JSON mode for structured extraction.
//!
//! Two API formats cover essentially every provider:
//! - `openai`    — `/v1/chat/completions` + `/v1/models` (OpenAI, Gemini OpenAI
//!   compat, Ollama `/v1`, llama.cpp, vLLM, LM Studio, Unsloth, Groq, Mistral,
//!   OpenRouter, DeepSeek, …)
//! - `anthropic` — `/v1/messages` + `/v1/models` (Claude and gateways speaking
//!   the Anthropic wire format)
//!
//! Any provider is reachable by pointing `base_url` at it.

use serde::{Deserialize, Serialize};
use std::time::Duration;

// Reuse the KB token schema so the LLM's JSON output maps directly to the
// structs `kb.rs` serialises to YAML. Phase 5.1.
use crate::kb::{CommandToken, CommandOrder};

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LlmClient {
    base_url: String,
    model: String,
    api_key: Option<String>,
    context_length: u32,
    api_format: String,
    http_client: reqwest::Client,
}

/// Message shape shared by both wire formats.
#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

// ─── Extracted Command Schema ──────────────────────────────────────

/// Structured output schema for command extraction.
/// This is what the LLM returns for each extracted command.
///
/// Phase 5.1: `tokens`/`order`/`negatable` mirror `kb::Command` so the LLM's
/// JSON output maps directly into the YAML the engine matches against.
/// Without this, every imported command is a legacy entry and the token
/// schema is unused on the import growth path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedCommand {
    pub name: String,
    #[serde(default)]
    pub syntax: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub examples: Vec<ExtractedExample>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Ordered token list. Empty = legacy command (name-prefix matching).
    #[serde(default)]
    pub tokens: Vec<CommandToken>,
    /// Token matching order. Default `fixed`.
    #[serde(default)]
    pub order: CommandOrder,
    /// True if the platform's negation prefix applies to this command.
    #[serde(default)]
    pub negatable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedExample {
    pub command: String,
    #[serde(default)]
    pub description: String,
}

/// Wrapper for the LLM response — an array of extracted commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub commands: Vec<ExtractedCommand>,
}

// ─── Client Implementation ─────────────────────────────────────────

impl LlmClient {
    /// Create a new LLM client. `api_format` is `"openai"` or `"anthropic"`.
    pub fn new(
        base_url: String,
        model: String,
        api_key: Option<String>,
        context_length: u32,
        api_format: String,
    ) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300)) // 5-minute timeout for large extractions
            .build()
            .unwrap_or_default();

        LlmClient {
            base_url,
            model,
            api_key,
            context_length,
            api_format,
            http_client,
        }
    }

    fn is_anthropic(&self) -> bool {
        self.api_format.eq_ignore_ascii_case("anthropic")
    }

    /// Extract commands from text content using the configured LLM API.
    /// Returns a list of extracted commands in structured form.
    ///
    /// Phase 5.1: takes the platform's `PlatformIndex` (real mode vocabulary,
    /// default mode, negation prefix) and the existing category list, so the
    /// LLM's prompt matches reality instead of a hardcoded cheat sheet.
    pub async fn extract_commands(
        &self,
        content: &str,
        platform: &str,
        category: &str,
        platform_index: &crate::kb::PlatformIndex,
        existing_categories: &[String],
    ) -> Result<Vec<ExtractedCommand>, String> {
        let system_prompt = build_system_prompt(platform, category, platform_index, existing_categories);
        let user_prompt = build_user_prompt(content, platform, category);

        // The full JSON schema goes into the system prompt — this works on
        // every provider. OpenAI-compatible servers additionally get a
        // `response_format: json_object` nudge.
        let schema = extraction_json_schema();
        let system_prompt = format!(
            "{system}\n\nYou MUST respond with ONLY a JSON object conforming to this schema (no prose, no markdown fences):\n{schema}",
            system = system_prompt,
            schema = serde_json::to_string(&schema).unwrap_or_default(),
        );

        let content_text = if self.is_anthropic() {
            self.anthropic_chat(&system_prompt, &user_prompt).await?
        } else {
            self.openai_chat(&system_prompt, &user_prompt).await?
        };

        // Parse the LLM's JSON output (strip markdown fences some models add)
        let cleaned = strip_code_fences(&content_text);
        let extraction: ExtractionResult = serde_json::from_str(&cleaned)
            .map_err(|e| {
                log::error!("LLM output was not valid JSON: {}", content_text.chars().take(500).collect::<String>());
                format!("Failed to parse LLM output as structured commands: {}. Output preview: {}", e, content_text.chars().take(200).collect::<String>())
            })?;

        log::info!("LLM extracted {} commands", extraction.commands.len());
        Ok(extraction.commands)
    }

    /// Chat via an OpenAI-compatible server: `POST {base}/v1/chat/completions`.
    async fn openai_chat(&self, system: &str, user: &str) -> Result<String, String> {
        let url = format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'));

        let messages = vec![
            ChatMessage { role: "system".to_string(), content: system.to_string() },
            ChatMessage { role: "user".to_string(), content: user.to_string() },
        ];
        let request = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
        });

        log::info!("LLM request: format=openai model={} url={} ", self.model, url);

        let mut http_req = self.http_client.post(&url).json(&request);
        if let Some(ref key) = self.api_key {
            http_req = http_req.header("Authorization", format!("Bearer {}", key));
        }

        let response = http_req
            .send()
            .await
            .map_err(|e| {
                let msg = e.to_string();
                // Detect connection refused / timeout — common proxy/network issues
                if msg.contains("connection refused") {
                    format!("Connection refused at {} — is the LLM server running?", self.base_url)
                } else if msg.contains("timed out") {
                    format!("LLM request timed out after 5 minutes — the model may be slow to respond or the server is overloaded")
                } else {
                    format!("LLM request failed: {}", msg)
                }
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct OpenAiResponse {
            choices: Vec<OpenAiChoice>,
        }
        #[derive(Deserialize)]
        struct OpenAiChoice {
            message: OpenAiMessage,
        }
        #[derive(Deserialize)]
        struct OpenAiMessage {
            content: Option<String>,
        }

        let resp: OpenAiResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        resp.choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| "LLM returned no choices".to_string())
    }

    /// Chat via the Anthropic wire format: `POST {base}/v1/messages`.
    async fn anthropic_chat(&self, system: &str, user: &str) -> Result<String, String> {
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));

        let request = serde_json::json!({
            "model": self.model,
            "max_tokens": self.context_length.max(4096),
            "system": system,
            "messages": [
                { "role": "user", "content": user }
            ],
            "stream": false,
        });

        log::info!("LLM request: format=anthropic model={} url={}", self.model, url);

        let mut http_req = self.http_client
            .post(&url)
            .json(&request)
            .header("anthropic-version", "2023-06-01");
        if let Some(ref key) = self.api_key {
            http_req = http_req.header("x-api-key", key);
        }

        let response = http_req
            .send()
            .await
            .map_err(|e| format!("LLM request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct AnthropicResponse {
            content: Vec<AnthropicBlock>,
        }
        #[derive(Deserialize)]
        struct AnthropicBlock {
            #[serde(rename = "type")]
            block_type: String,
            #[serde(default)]
            text: Option<String>,
        }

        let resp: AnthropicResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        Ok(resp
            .content
            .into_iter()
            .filter(|b| b.block_type == "text")
            .filter_map(|b| b.text)
            .collect::<Vec<_>>()
            .join(""))
    }

    /// List available models. Both wire formats expose `GET {base}/v1/models`.
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/v1/models", self.base_url.trim_end_matches('/'));

        let mut http_req = self.http_client
            .get(&url)
            .timeout(Duration::from_secs(5));

        if self.is_anthropic() {
            if let Some(ref key) = self.api_key {
                http_req = http_req.header("x-api-key", key);
            }
            http_req = http_req.header("anthropic-version", "2023-06-01");
        } else if let Some(ref key) = self.api_key {
            http_req = http_req.header("Authorization", format!("Bearer {}", key));
        }

        let response = http_req
            .send()
            .await
            .map_err(|e| format!("LLM server unreachable: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("LLM server returned status {}", response.status()));
        }

        // OpenAI: { "data": [ { "id": ... } ] }; Anthropic: { "data": [ { "id": ... } ] }
        #[derive(Deserialize)]
        struct ModelsResponse {
            data: Vec<ModelEntry>,
        }
        #[derive(Deserialize)]
        struct ModelEntry {
            id: String,
        }

        let models: ModelsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse models list: {}", e))?;

        Ok(models.data.into_iter().map(|m| m.id).collect())
    }
}

/// Strip ```json / ``` markdown fences some models wrap JSON in.
fn strip_code_fences(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
        let rest = rest.trim_start_matches(['\r', '\n']);
        match rest.rfind("```") {
            Some(end) => return rest[..end].trim().to_string(),
            // Unclosed fence (truncated output) — still strip the opening.
            None => return rest.trim().to_string(),
        }
    }
    t.to_string()
}

// ─── Prompt Engineering ─────────────────────────────────────────────

/// Build the system prompt from the platform's real vocabulary rather than a
/// hardcoded cheat sheet. Phase 5.1: injects `prompt_patterns` keys (valid
/// modes), `default_mode`, `negation_prefix`, and existing categories so the
/// LLM uses an existing category rather than inventing one.
fn build_system_prompt(
    platform: &str,
    category: &str,
    platform_index: &crate::kb::PlatformIndex,
    existing_categories: &[String],
) -> String {
    let modes: Vec<&str> = platform_index.prompt_patterns.keys().map(|s| s.as_str()).collect();
    let modes_list = if modes.is_empty() {
        platform_index.default_mode.clone()
    } else {
        modes.join(", ")
    };

    let negation_line = match platform_index.negation_prefix.as_deref() {
        Some(np) => format!(
            "\nNegation: this platform negates commands with the prefix '{np}'. \
             Set \"negatable\": true on any command that accepts this prefix \
             (e.g. configuration commands that have a 'no' inverse).",
            np = np
        ),
        None => String::new(),
    };

    let categories_line = if existing_categories.is_empty() {
        String::new()
    } else {
        format!(
            "\nExisting categories for this platform: {cats}. \
             Use one of these for the \"category\" if known; otherwise the \
             importer will fall back to '{category}'.",
            cats = existing_categories.join(", "),
            category = category,
        )
    };

    format!(
        r#"You are a network operating system command reference extraction tool. Your job is to read documentation or web pages about {platform} commands and extract structured command data.

You MUST output valid JSON matching the provided schema. Each command must have:
- "name": The exact command string (e.g., "show ip interface brief")
- "syntax": The command syntax with parameter placeholders in angle brackets and optional parts in square brackets (e.g., "show ip interface [brief | <interface-name>]")
- "description": A practical multi-line description of what the command does and when to use it
- "mode": The CLI mode where this command is valid. Valid modes for {platform}: {modes_list}
- "aliases": Common abbreviations engineers actually type (e.g., "sh ip int br" for "show ip interface brief")
- "examples": Array of {{ "command": "...", "description": "..." }} objects with practical usage examples
- "tags": Relevant keywords for search (protocol, category, use case)
- "tokens": an ordered list describing the command's syntax so the suggestion engine can match past the command name. Each element is one of:
  - {{"lit": "show ip interface"}}                          # fixed literal (may be multi-word)
  - {{"choice": ["permit","deny"], "optional": true}}        # keyword choice
  - {{"var": "interface-name", "type": "enumerable", "source": "device", "optional": true}}  # variable slot
  - {{"pipe": true, "filters": [{{"lit":"section","var":"regex","type":"free"}}], "optional": true}}  # pipe filter
  Optional fields: "optional": true, "repeatable": true (choice only), "type": "free"|"enumerable"|"numeric"|"choice", "source": "device"|"kb"|"none", "values": [...], "min": N, "max": N (numeric only)
- "order": "fixed" (default; tokens match in order), "flags-anywhere" (required stem first, optional flags anywhere), or "free" (required stem first, key/value filters in any order)
- "negatable": true if this command accepts the platform's negation prefix (default false)

Worked example (show ip interface brief):
{{
  "name": "show ip interface brief",
  "syntax": "show ip interface [brief | <interface-name>]",
  "mode": "privileged-exec",
  "tokens": [
    {{"lit": "show ip interface"}},
    {{"choice": ["brief"], "optional": true}},
    {{"var": "interface-name", "type": "enumerable", "source": "device", "optional": true}}
  ],
  "order": "fixed"
}}

"syntax" is the human-readable display string derived from "tokens" — keep them consistent.
{negation}{categories}

IMPORTANT RULES:
1. Only extract actual commands — not UI elements, navigation items, or descriptive text
2. The "name" field must be the full command string as typed in the CLI
3. The "mode" field must be one of the valid modes listed above
4. If you cannot determine a field with confidence, omit it rather than guessing
5. Category for these commands: {category}
6. Extract ALL commands found in the documentation — be thorough
7. Descriptions should be practical and useful for a network engineer
8. "tokens" should be empty [] only for trivial commands; prefer one {{lit: ...}} token over empty"#,
        platform = platform,
        modes_list = modes_list,
        negation = negation_line,
        categories = categories_line,
        category = category,
    )
}

/// JSON schema for the extraction result (embedded in the system prompt and
/// sent as Ollama-style structured output where supported).
fn extraction_json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "commands": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "syntax": { "type": "string" },
                        "description": { "type": "string" },
                        "mode": { "type": "string" },
                        "aliases": { "type": "array", "items": { "type": "string" } },
                        "examples": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "command": { "type": "string" },
                                    "description": { "type": "string" }
                                },
                                "required": ["command"]
                            }
                        },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "tokens": token_json_schema(),
                        "order": { "type": "string", "enum": ["fixed", "flags-anywhere", "free"] },
                        "negatable": { "type": "boolean" }
                    },
                    "required": ["name"]
                }
            }
        },
        "required": ["commands"]
    })
}

/// JSON schema fragment for one token element (used in the structured
/// output schema). Servers with structured-output mode enforce this shape;
/// for others it is guidance embedded in the prompt.
fn token_json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "array",
        "items": {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "lit": { "type": "string" },
                        "optional": { "type": "boolean" }
                    },
                    "required": ["lit"]
                },
                {
                    "type": "object",
                    "properties": {
                        "choice": { "type": "array", "items": { "type": "string" } },
                        "optional": { "type": "boolean" },
                        "repeatable": { "type": "boolean" }
                    },
                    "required": ["choice"]
                },
                {
                    "type": "object",
                    "properties": {
                        "var": { "type": "string" },
                        "type": { "type": "string", "enum": ["free", "enumerable", "numeric", "choice"] },
                        "source": { "type": "string", "enum": ["device", "kb", "none"] },
                        "optional": { "type": "boolean" },
                        "values": { "type": "array", "items": { "type": "string" } },
                        "min": { "type": "integer" },
                        "max": { "type": "integer" }
                    },
                    "required": ["var"]
                },
                {
                    "type": "object",
                    "properties": {
                        "pipe": { "type": "boolean" },
                        "filters": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "lit": { "type": "string" },
                                    "var": { "type": "string" },
                                    "type": { "type": "string", "enum": ["free", "enumerable", "numeric", "choice"] }
                                },
                                "required": ["lit"]
                            }
                        },
                        "optional": { "type": "boolean" },
                        "repeatable": { "type": "boolean" }
                    },
                    "required": ["pipe"]
                }
            ]
        }
    })
}

fn build_user_prompt(content: &str, platform: &str, category: &str) -> String {
    // For very long content, truncate to avoid exceeding context window
    // A rough estimate: 1 token ≈ 4 chars, with 64k context we allow ~200k chars
    // but leave room for system prompt and output
    let max_content_chars = 180_000;
    let truncated_content = if content.len() > max_content_chars {
        log::warn!("Content truncated from {} to {} chars", content.len(), max_content_chars);
        // Truncate by character count, not byte index, to avoid splitting UTF-8 multi-byte chars
        let cut = content.char_indices().nth(max_content_chars).map(|(i, _)| i).unwrap_or(content.len());
        &content[..cut]
    } else {
        content
    };

    format!(
r#"Extract all {platform} {category} commands from the following documentation page.

Return a JSON object with a "commands" array containing each command found.

Documentation content:
```
{truncated_content}
```"#,
        platform = platform,
        category = category,
        truncated_content = truncated_content,
    )
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn iosxe_platform_index() -> crate::kb::PlatformIndex {
        let mut prompt_patterns = std::collections::HashMap::new();
        prompt_patterns.insert("privileged-exec".to_string(), "^[\\w\\-]+#".to_string());
        prompt_patterns.insert("global-config".to_string(), "^[\\w\\-]+\\(config\\)#".to_string());
        crate::kb::PlatformIndex {
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

    #[test]
    fn test_build_system_prompt_contains_platform() {
        let pi = iosxe_platform_index();
        let prompt = build_system_prompt("cisco-iosxe", "networking", &pi, &[]);
        assert!(prompt.contains("cisco-iosxe"));
        assert!(prompt.contains("networking"));
        assert!(prompt.contains("privileged-exec"));
        // Phase 5.1: real mode vocabulary from the platform index
        assert!(prompt.contains("global-config"));
        // Negation prefix is injected
        assert!(prompt.contains("negatable"));
        assert!(prompt.contains("no "));
    }

    #[test]
    fn test_build_system_prompt_injects_existing_categories() {
        let pi = iosxe_platform_index();
        let cats = vec!["networking".to_string(), "system".to_string()];
        let prompt = build_system_prompt("cisco-iosxe", "routing", &pi, &cats);
        assert!(prompt.contains("networking"));
        assert!(prompt.contains("system"));
    }

    #[test]
    fn test_build_user_prompt_truncation() {
        let long_content = "x".repeat(200_000);
        let prompt = build_user_prompt(&long_content, "cisco-iosxe", "routing");
        // Should be truncated, not 200k chars long in the prompt
        assert!(prompt.len() < 200_000 + 500); // +500 for prompt template
    }

    #[test]
    fn test_extracted_command_deserialization() {
        let json = r#"{
            "commands": [
                {
                    "name": "show ip route",
                    "syntax": "show ip route [<network>]",
                    "description": "Displays the IP routing table.",
                    "mode": "privileged-exec",
                    "aliases": ["sh ip ro"],
                    "examples": [{"command": "show ip route", "description": "Full routing table"}],
                    "tags": ["routing", "troubleshooting"]
                }
            ]
        }"#;

        let result: ExtractionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].name, "show ip route");
        assert_eq!(result.commands[0].aliases.len(), 1);
        // tokens default to empty when the LLM omits them
        assert!(result.commands[0].tokens.is_empty());
        assert!(!result.commands[0].negatable);
    }

    #[test]
    fn test_extracted_command_with_tokens_round_trips() {
        // Phase 5.1: a token-bearing extracted command maps cleanly to kb::Command.
        let json = r#"{
            "commands": [
                {
                    "name": "show ip interface brief",
                    "syntax": "show ip interface [brief | <interface-name>]",
                    "mode": "privileged-exec",
                    "tokens": [
                        {"lit": "show ip interface"},
                        {"choice": ["brief"], "optional": true},
                        {"var": "interface-name", "type": "enumerable", "source": "device", "optional": true}
                    ],
                    "order": "fixed"
                }
            ]
        }"#;

        let result: ExtractionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.commands.len(), 1);
        let cmd = &result.commands[0];
        assert_eq!(cmd.tokens.len(), 3);
        // Tag round-trips through the kb::CommandToken variants.
        match &cmd.tokens[1] {
            CommandToken::Choice { choice, optional, repeatable, .. } => {
                assert_eq!(choice, &vec!["brief".to_string()]);
                assert!(optional);
                assert!(!repeatable);
            }
            other => panic!("expected Choice, got {:?}", other),
        }
        assert!(matches!(cmd.order, CommandOrder::Fixed));
    }

    #[test]
    fn test_llm_client_construction() {
        let client = LlmClient::new(
            "http://localhost:11434".to_string(),
            "llama3.2".to_string(),
            None,
            64000,
            "openai".to_string(),
        );
        assert_eq!(client.base_url, "http://localhost:11434");
        assert_eq!(client.model, "llama3.2");
        assert!(client.api_key.is_none());
        assert!(!client.is_anthropic());
    }

    #[test]
    fn test_llm_client_with_api_key() {
        let client = LlmClient::new(
            "https://api.anthropic.com".to_string(),
            "claude-sonnet-4-5".to_string(),
            Some("sk-test-key".to_string()),
            64000,
            "anthropic".to_string(),
        );
        assert_eq!(client.api_key, Some("sk-test-key".to_string()));
        assert!(client.is_anthropic());
    }

    #[test]
    fn test_strip_code_fences() {
        assert_eq!(strip_code_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fences("```\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fences("  {\"a\":1}  "), "{\"a\":1}");
        assert_eq!(strip_code_fences("```json\n{\"a\":1}"), "{\"a\":1}");
    }
}
