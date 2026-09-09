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
    /// LLM-chosen category. The prompt supplies the allowed list; the
    /// importer keeps it only when it's on the list, else the requested one.
    #[serde(default)]
    pub category: Option<String>,
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

/// Max silence between stream chunks. This replaces a total request timeout:
/// a slow-but-working model streams continuously and never trips it; a hung
/// server or dropped connection fails after this idle window.
const CHAT_IDLE_TIMEOUT_SECS: u64 = 120;
/// Report received-output size to the UI every N chars.
const OUTPUT_REPORT_INTERVAL: usize = 250;
/// Rolling tail of streamed output sent to the UI (live view in the modal).
const OUTPUT_TAIL_CHARS: usize = 400;

/// Normalize the stored Base URL so endpoint building is uniform:
/// strip trailing slashes AND a trailing `/v1` — the client appends
/// `/v1/chat/completions` etc. itself. Handles users pasting full API roots
/// like `https://api.openai.com/v1` (and accidental `.../v1/`).
fn normalize_base_url(base_url: &str) -> String {
    let mut url = base_url.trim().trim_end_matches('/').to_string();
    if url.ends_with("/v1") {
        url.truncate(url.len() - 3);
    }
    url
}

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
            .connect_timeout(Duration::from_secs(30))
            // No total timeout — chat uses streaming with per-chunk idle
            // timeouts; list_models sets its own short per-request timeout.
            .build()
            .unwrap_or_default();

        LlmClient {
            base_url: normalize_base_url(&base_url),
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
        on_output: impl Fn(usize, &str) + Send + Sync,
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
            self.anthropic_chat(&system_prompt, &user_prompt, &on_output).await?
        } else {
            self.openai_chat(&system_prompt, &user_prompt, &on_output).await?
        };

        // Parse the LLM's JSON output (strip markdown fences some models add)
        let cleaned = strip_code_fences(&content_text);
        let extraction: ExtractionResult = serde_json::from_str(&cleaned)
            .map_err(|e| {
                log::error!("LLM output was not valid JSON: {}", content_text.chars().take(500).collect::<String>());
                if e.is_io() {
                    // EOF mid-string = truncated JSON. The stream ended cleanly
                    // but early — the model hit its output-token limit (large
                    // page + "extract ALL" prompt) or the server cut generation.
                    format!(
                        "LLM output was truncated at {} chars — the model likely hit its output-token limit while writing JSON for too many commands. Try a documentation page covering fewer commands, or a model/server with a higher output limit.",
                        cleaned.chars().count()
                    )
                } else {
                    format!("Failed to parse LLM output as structured commands: {}. Output preview: {}", e, content_text.chars().take(200).collect::<String>())
                }
            })?;

        log::info!("LLM extracted {} commands", extraction.commands.len());
        Ok(extraction.commands)
    }

    /// Read an SSE stream, invoking `handle` per `data:` payload line.
    /// `handle` returns Ok(false) to stop cleanly (stream terminator) or
    /// Err to abort. Chunks read with an idle timeout: a hung server or
    /// dropped connection errors out instead of waiting forever.
    async fn read_sse_stream(
        response: &mut reqwest::Response,
        mut handle: impl FnMut(&str) -> Result<bool, String>,
    ) -> Result<(), String> {
        let mut buf = String::new();
        loop {
            let chunk = tokio::time::timeout(
                Duration::from_secs(CHAT_IDLE_TIMEOUT_SECS),
                response.chunk(),
            )
            .await
            .map_err(|_| format!(
                "LLM stream stalled for {} seconds with no data — the server may have hung. Cancel and retry.",
                CHAT_IDLE_TIMEOUT_SECS
            ))?
            .map_err(|e| format!("LLM stream read failed: {} — connection may have dropped", e))?;

            match chunk {
                None => return Ok(()), // stream ended
                Some(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        let line = line.trim_end();
                        if let Some(data) = line.strip_prefix("data:") {
                            let data = data.trim();
                            if data.is_empty() {
                                continue; // keepalive comment
                            }
                            if !handle(data)? {
                                return Ok(());
                            }
                        }
                        // Non-data lines (event:, :, empty) are ignored.
                    }
                }
            }
        }
    }

    /// Shared chat-response handling: stream SSE deltas via `on_data` (which
    /// appends text into `content`), fall back to a plain body read when the
    /// server ignores the stream request, report progress/tail via
    /// `on_output`, and flush at the end. Returns the full content.
    async fn read_chat_response(
        mut response: reqwest::Response,
        on_output: &impl Fn(usize, &str),
        mut on_data: impl FnMut(&str, &mut String) -> Result<bool, String>,
    ) -> Result<String, String> {
        // Some servers ignore "stream": true and answer with a normal JSON
        // body. Detect via Content-Type and fall back to a plain read so the
        // output still arrives (without live streaming).
        let is_sse = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/event-stream"))
            .unwrap_or(false);

        let mut content = String::new();
        let mut reported = 0usize;
        let mut tail = String::new();

        if is_sse {
            Self::read_sse_stream(&mut response, |data| {
                let before = content.chars().count();
                let keep = on_data(data, &mut content)?;
                let after = content.chars().count();
                if after > before {
                    let appended: String = content.chars().skip(before).collect();
                    push_tail(&mut tail, &appended);
                    if after - reported >= OUTPUT_REPORT_INTERVAL {
                        reported = after;
                        on_output(after, &tail);
                    }
                }
                Ok(keep)
            })
            .await?;
        } else {
            log::info!("LLM server ignored stream request — falling back to non-streaming read");
            content = response
                .text()
                .await
                .map_err(|e| format!("LLM stream read failed: {} — connection may have dropped", e))?;
        }

        // Final flush: guarantee the UI sees the output even for short
        // responses that never cross the report interval.
        let n = content.chars().count();
        if n > reported {
            if tail.is_empty() {
                push_tail(&mut tail, &content);
            }
            on_output(n, &tail);
        }

        if content.is_empty() {
            return Err("LLM stream completed with no content".to_string());
        }
        Ok(content)
    }

    /// Chat via an OpenAI-compatible server: `POST {base}/v1/chat/completions`.
    /// Streams SSE deltas and reports received-output size via `on_output`.
    async fn openai_chat(&self, system: &str, user: &str, on_output: &impl Fn(usize, &str)) -> Result<String, String> {
        let url = format!("{}/v1/chat/completions", self.base_url);

        let messages = vec![
            ChatMessage { role: "system".to_string(), content: system.to_string() },
            ChatMessage { role: "user".to_string(), content: user.to_string() },
        ];
        let request = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            "response_format": { "type": "json_object" },
            // Output cap. Servers that need more ignore or clamp it; servers
            // with smaller limits accept it as a no-op ceiling. Without this,
            // server defaults apply (e.g. Ollama) or generation is unbounded.
            "max_tokens": self.context_length.min(8192).max(1024),
        });

        log::info!("LLM request: format=openai model={} url={} (streaming)", self.model, url);

        let mut http_req = self.http_client.post(&url).json(&request);
        if let Some(ref key) = self.api_key {
            http_req = http_req.header("Authorization", format!("Bearer {}", key));
        }

        let response = http_req
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() {
                    format!("Connection refused at {} — is the LLM server running?", self.base_url)
                } else if e.is_timeout() {
                    "LLM connection timed out after 30s — server not accepting connections".to_string()
                } else {
                    // Include the source chain: reqwest hides the real cause
                    // (DNS, TLS, reset) below the generic "error sending request".
                    let mut msg = format!("LLM request failed: {}", e);
                    let mut src = std::error::Error::source(&e);
                    while let Some(s) = src {
                        msg.push_str(&format!(" — caused by: {}", s));
                        src = s.source();
                    }
                    msg
                }
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, body));
        }

        Self::read_chat_response(response, on_output, |data, content| {
            if data == "[DONE]" {
                return Ok(false);
            }
            #[derive(Deserialize)]
            struct OpenAiChunk {
                #[serde(default)]
                choices: Vec<OpenAiChunkChoice>,
            }
            #[derive(Deserialize)]
            struct OpenAiChunkChoice {
                #[serde(default)]
                delta: OpenAiChunkDelta,
            }
            #[derive(Deserialize, Default)]
            struct OpenAiChunkDelta {
                #[serde(default)]
                content: Option<String>,
            }
            if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                if let Some(text) = chunk.choices.into_iter().next().and_then(|c| c.delta.content) {
                    content.push_str(&text);
                }
            }
            // Unparseable lines (e.g. provider keepalives) are ignored.
            Ok(true)
        })
        .await
    }

    /// Chat via the Anthropic wire format: `POST {base}/v1/messages`.
    /// Streams SSE deltas and reports received-output size via `on_output`.
    async fn anthropic_chat(&self, system: &str, user: &str, on_output: &impl Fn(usize, &str)) -> Result<String, String> {
        let url = format!("{}/v1/messages", self.base_url);

        let request = serde_json::json!({
            "model": self.model,
            // Output cap, NOT the context window. Bounded to common model
            // limits — larger values (e.g. the full context length) are
            // rejected by models with smaller output caps (e.g. Claude).
            "max_tokens": self.context_length.min(8192).max(1024),
            "system": system,
            "messages": [
                { "role": "user", "content": user }
            ],
            "stream": true,
        });

        log::info!("LLM request: format=anthropic model={} url={} (streaming)", self.model, url);

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
            .map_err(|e| {
                if e.is_connect() {
                    format!("Connection refused at {} — is the LLM server running?", self.base_url)
                } else if e.is_timeout() {
                    "LLM connection timed out after 30s — server not accepting connections".to_string()
                } else {
                    format!("LLM request failed: {}", e)
                }
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, body));
        }

        Self::read_chat_response(response, on_output, |data, content| {
            let v: serde_json::Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return Ok(true), // ignore keepalives/non-JSON lines
            };
            match v["type"].as_str() {
                Some("content_block_delta") => {
                    if let Some(text) = v["delta"]["text"].as_str() {
                        content.push_str(text);
                    }
                }
                Some("message_stop") => return Ok(false),
                Some("error") => {
                    return Err(format!("LLM stream error: {}", v["error"].as_object()
                        .map(|o| o.iter().map(|(k, val)| format!("{}: {}", k, val)).collect::<Vec<_>>().join(", "))
                        .unwrap_or_else(|| data.to_string())));
                }
                _ => {}
            }
            Ok(true)
        })
        .await
    }

    /// List available models. Both wire formats expose `GET {base}/v1/models`.
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/v1/models", self.base_url);

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

/// Keep `tail` trimmed to the last OUTPUT_TAIL_CHARS chars (rolling window
/// sent to the UI's live output view). Called with an empty window and the
/// full content, it doubles as the non-streaming tail extractor.
fn push_tail(tail: &mut String, text: &str) {
    tail.push_str(text);
    let total = tail.chars().count();
    if total > OUTPUT_TAIL_CHARS {
        let skip = total - OUTPUT_TAIL_CHARS;
        *tail = tail.chars().skip(skip).collect();
    }
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
        r#"You are extracting commands for the user's PERSONAL CUSTOM knowledge base. This is not the app's built-in knowledge base and must never be treated as one: output is shown to this user for review, then saved to their private profile. Extract only commands documented in the provided text — do not invent, generalize from other platforms, or fill gaps from your own knowledge. Every command must conform exactly to the schema below; the app validates your output and the user rejects invalid commands at review.

You are a network operating system command reference extraction tool. Your job is to read documentation or web pages about {platform} commands and extract structured command data.

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
3. The "mode" field must be one of the valid modes listed above; any other value is rejected and coerced to the platform default "{default_mode}", so omit the field if unsure rather than guessing a mode name
4. If you cannot determine a field with confidence, omit it rather than guessing
5. Category for each command: pick the best fit from the allowed categories listed above. A page may cover several categories — assign each command its own. Omit to use the requested category ('{category}')
6. Extract ALL commands found in the documentation — be thorough
7. Descriptions should be practical and useful for a network engineer
8. "tokens" should be empty [] only for trivial commands; prefer one {{lit: ...}} token over empty"#,
        platform = platform,
        modes_list = modes_list,
        negation = negation_line,
        categories = categories_line,
        category = category,
        default_mode = platform_index.default_mode,
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
                        "category": { "type": "string" },
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

// ─── Shared test SSE mock (stdlib TcpListener, no extra deps) ───────

#[cfg(test)]
pub(crate) mod sse_test_mock {
    /// Multi-request SSE mock: accepts N sequential connections, each gets
    /// one response from the queue. `Some(body)` = chunked SSE 200, `None` = HTTP 500.
    pub fn sse_mock_n(responses: Vec<Option<String>>) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        std::thread::spawn(move || {
            for resp in responses {
                let (mut stream, _) = match listener.accept() { Ok(s) => s, Err(_) => break };

                let mut buf = vec![0u8; 65536];
                let mut total = 0usize;
                loop {
                    let n = match stream.read(&mut buf[total..]) { Ok(n) if n > 0 => n, _ => break };
                    total += n;
                    if String::from_utf8_lossy(&buf[..total]).contains("\r\n\r\n") { break; }
                }

                let headers = String::from_utf8_lossy(&buf[..total]);
                let content_len = headers
                    .lines()
                    .find_map(|l| l.to_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                    .unwrap_or(0);
                let header_end = headers.find("\r\n\r\n").map(|i| i + 4).unwrap_or(total);
                let already_read = total - header_end;
                let remaining = content_len.saturating_sub(already_read);
                let mut drained = 0;
                while drained < remaining {
                    let n = match stream.read(&mut buf[..]) { Ok(n) if n > 0 => n, _ => break };
                    drained += n;
                }

                let out = match resp {
                    Some(body) => {
                        let data = body.as_bytes();
                        let mut r = Vec::new();
                        r.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
                        r.extend_from_slice(b"Content-Type: text/event-stream\r\n");
                        r.extend_from_slice(b"Transfer-Encoding: chunked\r\n\r\n");
                        r.extend_from_slice(format!("{:x}\r\n", data.len()).as_bytes());
                        r.extend_from_slice(data);
                        r.extend_from_slice(b"\r\n0\r\n\r\n");
                        r
                    }
                    None => {
                        let body = b"internal error";
                        let mut r = Vec::new();
                        r.extend_from_slice(b"HTTP/1.1 500 Internal Server Error\r\n");
                        r.extend_from_slice(b"Content-Type: text/plain\r\n");
                        r.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
                        r.extend_from_slice(body);
                        r
                    }
                };
                let _ = stream.write_all(&out);
                let _ = stream.flush();
            }
        });

        addr
    }
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
    fn test_build_system_prompt_custom_kb_boundary() {
        // docs/10: the prompt must state the custom-KB purpose/boundary so
        // the LLM never treats extraction as built-in KB content.
        let pi = iosxe_platform_index();
        let prompt = build_system_prompt("cisco-iosxe", "networking", &pi, &[]);
        assert!(prompt.contains("PERSONAL CUSTOM knowledge base"));
        assert!(prompt.contains("do not invent"));
        // Rule 3 states the mode coercion that the validator enforces
        // (import.rs coerces unknown modes to default_mode).
        assert!(prompt.contains("coerced to the platform default \"privileged-exec\""));
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
    fn test_normalize_base_url_variants() {
        // Bare host (existing users) and full API roots (preset paste / manual)
        // must all resolve to the same endpoint base.
        assert_eq!(normalize_base_url("http://localhost:11434"), "http://localhost:11434");
        assert_eq!(normalize_base_url("http://localhost:11434/v1"), "http://localhost:11434");
        assert_eq!(normalize_base_url("http://localhost:11434/v1/"), "http://localhost:11434");
        assert_eq!(normalize_base_url("https://api.openai.com/v1"), "https://api.openai.com");
        assert_eq!(normalize_base_url("https://api.openai.com"), "https://api.openai.com");
        assert_eq!(normalize_base_url("  https://api.x.ai/v1  "), "https://api.x.ai");
        // Only the trailing /v1 is stripped — a /v1 nested deeper stays intact.
        assert_eq!(normalize_base_url("https://gw.example.com/v1/proxy"), "https://gw.example.com/v1/proxy");
    }

    #[test]
    fn test_extracted_command_with_tokens_round_trips() {
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

    #[tokio::test]
    async fn test_extract_commands_parses_sse_stream() {
        use super::sse_test_mock::sse_mock_n;

        // LLM "responds" with one SSE chunk containing the full JSON payload
        let llm_json = r#"{"commands":[{"name":"show ip","syntax":null,"description":"Show IP config","mode":null,"category":null,"aliases":[],"examples":[],"tags":[],"tokens":[],"order":"fixed","negatable":false}]}"#;
        let chunk = serde_json::json!({"choices":[{"delta":{"content": llm_json}}]});
        let sse_body = format!("data: {}\n\ndata: [DONE]\n\n", chunk);

        let addr = sse_mock_n(vec![Some(sse_body)]);
        let base_url = format!("http://{}", addr);

        let client = LlmClient::new(
            base_url,
            "test-model".to_string(),
            None,
            64000,
            "openai".to_string(),
        );

        let index = crate::kb::PlatformIndex {
            id: "linux-bash".to_string(),
            name: "Linux Bash".to_string(),
            description: String::new(),
            reference_url: String::new(),
            versions: vec![],
            prompt_patterns: std::collections::HashMap::new(),
            default_mode: "user".to_string(),
            negation_prefix: None,
            prefix_commands: std::collections::HashMap::new(),
        };

        let output_chars = std::sync::atomic::AtomicUsize::new(0);
        let oc = &output_chars;
        let result = client.extract_commands(
            "some documentation text",
            "linux-bash",
            "networking",
            &index,
            &[],
            |n, _| { oc.fetch_add(n, std::sync::atomic::Ordering::Relaxed); },
        ).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "show ip");
        assert_eq!(result[0].description.as_deref(), Some("Show IP config"));
        assert!(output_chars.load(std::sync::atomic::Ordering::Relaxed) > 0, "on_output should have been called");
    }
}
