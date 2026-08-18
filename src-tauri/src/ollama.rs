//! Ollama REST client — chat API with JSON mode for structured extraction.
//!
//! Supports both local Ollama (http://localhost:11434) and Ollama Cloud
//! (https://ollama.com/api with API key).

use serde::{Deserialize, Serialize};
use std::time::Duration;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OllamaClient {
    base_url: String,
    model: String,
    api_key: Option<String>,
    context_length: u32,
    http_client: reqwest::Client,
}

/// Request body for /api/chat endpoint.
#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<serde_json::Value>,
    stream: bool,
    options: ChatOptions,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatOptions {
    num_ctx: u32,
}

/// Response body from /api/chat endpoint (non-streaming).
#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: String,
}

/// Error response from Ollama API.
#[derive(Debug, Deserialize)]
struct OllamaError {
    error: String,
}

// ─── Extracted Command Schema ──────────────────────────────────────

/// Structured output schema for command extraction.
/// This is what the LLM returns for each extracted command.
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

impl OllamaClient {
    /// Create a new Ollama client.
    pub fn new(
        base_url: String,
        model: String,
        api_key: Option<String>,
        context_length: u32,
    ) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300)) // 5-minute timeout for large extractions
            .build()
            .unwrap_or_default();

        OllamaClient {
            base_url,
            model,
            api_key,
            context_length,
            http_client,
        }
    }

    /// Extract commands from text content using Ollama chat API.
    /// Returns a list of extracted commands in structured form.
    pub async fn extract_commands(
        &self,
        content: &str,
        platform: &str,
        category: &str,
    ) -> Result<Vec<ExtractedCommand>, String> {
        let system_prompt = build_system_prompt(platform, category);
        let user_prompt = build_user_prompt(content, platform, category);

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ];

        // JSON schema for structured output
        let schema = serde_json::json!({
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
                            "tags": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["name"]
                    }
                }
            },
            "required": ["commands"]
        });

        let request = ChatRequest {
            model: self.model.clone(),
            messages,
            format: Some(schema),
            stream: false,
            options: ChatOptions {
                num_ctx: self.context_length,
            },
        };

        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));

        log::info!("Ollama request: model={} url={} content_len={}", self.model, url, content.len());

        let mut http_req = self.http_client
            .post(&url)
            .json(&request);

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
                    format!("Ollama connection refused at {} — is Ollama running?", self.base_url)
                } else if msg.contains("timed out") {
                    format!("Ollama request timed out after 5 minutes — the model may be slow to respond or the server is overloaded")
                } else {
                    format!("Ollama request failed: {}", msg)
                }
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // Try to extract Ollama's error JSON and surface it
            if let Ok(err_resp) = serde_json::from_str::<OllamaError>(&body) {
                return Err(format!("Ollama error: {}", err_resp.error));
            }
            return Err(format!("Ollama API error ({}): {}", status, body));
        }

        let chat_resp: ChatResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

        // Parse the LLM's JSON output
        let extraction: ExtractionResult = serde_json::from_str(&chat_resp.message.content)
            .map_err(|e| {
                log::error!("LLM output was not valid JSON: {}", chat_resp.message.content.chars().take(500).collect::<String>());
                format!("Failed to parse LLM output as structured commands: {}. Output preview: {}", e, chat_resp.message.content.chars().take(200).collect::<String>())
            })?;

        log::info!("Ollama extracted {} commands", extraction.commands.len());
        Ok(extraction.commands)
    }

    /// List available models from Ollama.
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/api/tags", self.base_url.trim_end_matches('/'));

        let mut http_req = self.http_client
            .get(&url)
            .timeout(Duration::from_secs(5));

        if let Some(ref key) = self.api_key {
            http_req = http_req.header("Authorization", format!("Bearer {}", key));
        }

        let response = http_req
            .send()
            .await
            .map_err(|e| format!("Ollama unreachable: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Ollama returned status {}", response.status()));
        }

        #[derive(Deserialize)]
        struct TagsResponse {
            models: Vec<ModelEntry>,
        }
        #[derive(Deserialize)]
        struct ModelEntry {
            name: String,
        }

        let tags: TagsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse models list: {}", e))?;

        Ok(tags.models.into_iter().map(|m| m.name).collect())
    }
}

// ─── Prompt Engineering ─────────────────────────────────────────────

fn build_system_prompt(platform: &str, category: &str) -> String {
    format!(
r#"You are a network operating system command reference extraction tool. Your job is to read documentation or web pages about {platform} commands and extract structured command data.

You MUST output valid JSON matching the provided schema. Each command must have:
- "name": The exact command string (e.g., "show ip interface brief")
- "syntax": The command syntax with parameter placeholders in angle brackets and optional parts in square brackets (e.g., "show ip interface [brief | <interface-name>]")
- "description": A practical multi-line description of what the command does and when to use it
- "mode": The CLI mode where this command is valid. Common modes for {platform}:
  - Cisco IOS-XE: user-exec, privileged-exec, global-config, interface-config, routing-config, line-config
  - Cisco NX-OS: user-exec, privileged-exec, global-config, interface-config, routing-config
  - F5 TMOS: tmsh-root, ltm, net, sys, bash
  - Linux Bash: shell
- "aliases": Common abbreviations engineers actually type (e.g., "sh ip int br" for "show ip interface brief")
- "examples": Array of {{ "command": "...", "description": "..." }} objects with practical usage examples
- "tags": Relevant keywords for search (protocol, category, use case)

IMPORTANT RULES:
1. Only extract actual commands — not UI elements, navigation items, or descriptive text
2. The "name" field must be the full command string as typed in the CLI
3. The "mode" field must match the platform's valid modes listed above
4. If you cannot determine a field with confidence, omit it rather than guessing
5. Category for these commands: {category}
6. Extract ALL commands found in the documentation — be thorough
7. Descriptions should be practical and useful for a network engineer"#,
        platform = platform,
        category = category,
    )
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

    #[test]
    fn test_build_system_prompt_contains_platform() {
        let prompt = build_system_prompt("cisco-iosxe", "networking");
        assert!(prompt.contains("cisco-iosxe"));
        assert!(prompt.contains("networking"));
        assert!(prompt.contains("privileged-exec"));
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
    }

    #[test]
    fn test_extracted_command_minimal() {
        let json = r#"{
            "commands": [
                {
                    "name": "show version"
                }
            ]
        }"#;

        let result: ExtractionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].name, "show version");
        assert!(result.commands[0].syntax.is_none());
        assert!(result.commands[0].description.is_none());
    }

    #[test]
    fn test_ollama_client_construction() {
        let client = OllamaClient::new(
            "http://localhost:11434".to_string(),
            "llama3.2".to_string(),
            None,
            64000,
        );
        assert_eq!(client.base_url, "http://localhost:11434");
        assert_eq!(client.model, "llama3.2");
        assert!(client.api_key.is_none());
    }

    #[test]
    fn test_ollama_client_with_api_key() {
        let client = OllamaClient::new(
            "https://ollama.com/api".to_string(),
            "llama3.2".to_string(),
            Some("sk-test-key".to_string()),
            64000,
        );
        assert_eq!(client.api_key, Some("sk-test-key".to_string()));
    }
}