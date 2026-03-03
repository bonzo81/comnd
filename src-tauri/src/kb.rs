//! Knowledge Base loader and query engine
//! 
//! Loads YAML command files per platform into an in-memory index.
//! Supports fast prefix matching for the suggestion engine.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformIndex {
    pub id: String,
    pub name: String,
    pub description: String,
    pub reference_url: String,
    pub versions: Vec<String>,
    pub prompt_patterns: std::collections::HashMap<String, String>,
    pub default_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub syntax: String,
    pub description: String,
    pub category: String,
    pub mode: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub examples: Vec<CommandExample>,
    #[serde(default)]
    pub versions: CommandVersions,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandExample {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommandVersions {
    pub introduced: Option<String>,
    pub deprecated: Option<String>,
    pub notes: Option<String>,
}

// TODO: Implement KB loader
// - Parse index.yaml per platform
// - Load all command YAML files
// - Build in-memory prefix index (trie or sorted vec)
// - Version filtering (major version comparison)
// - Query method returning ranked matches
