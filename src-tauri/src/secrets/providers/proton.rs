//! Proton Pass provider — `pass-cli` on PATH (chunk 8).
//!
//! Ref format: `pass://<vault>/<item>/<field>` where vault/item accept either
//! the human name or the opaque ID (`item view` resolves both; item IDs are
//! used for generated refs because titles can duplicate). Auth via the PAT env
//! var when a token is stored in the keyring, otherwise a persisted interactive
//! session. CLI shapes confirmed against a real install — see
//! `docs/credentials/plan-provider-proton.md`.

use std::time::Duration;

use async_trait::async_trait;

use crate::secrets::{CliError, CredentialItem, ProviderStatus, SecretProvider, run_cli};

const CLI: &str = "pass-cli";
const PAT_ENV: &str = "PROTON_PASS_PERSONAL_ACCESS_TOKEN";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Default field for browse-UI refs until the real item schema is confirmed.
const DEFAULT_FIELD: &str = "password";

/// Parse + validate `pass://<vault>/<item>/<field>`. Rejects malformed refs
/// before any subprocess spawn.
fn parse_ref(reference: &str) -> Result<(String, String, String), String> {
    let rest = reference
        .strip_prefix("pass://")
        .ok_or_else(|| "ref must start with pass://".to_string())?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
        return Err("ref must be pass://<vault>/<item>/<field>".to_string());
    }
    Ok((parts[0].into(), parts[1].into(), parts[2].into()))
}

/// PAT from the OS keyring (None → rely on a persisted session).
fn pat_env() -> Vec<(String, String)> {
    match crate::config::get_provider_secret("proton") {
        Ok(Some(p)) if !p.is_empty() => vec![(PAT_ENV.to_string(), p)],
        _ => Vec::new(),
    }
}

fn env_refs(envs: &[(String, String)]) -> Vec<(&str, &str)> {
    envs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// `pass-cli item view "pass://<vault>/<item>/<field>"` — raw stdout is the secret.
async fn item_view(reference: &str) -> Result<String, String> {
    let env = pat_env();
    let refs = env_refs(&env);
    run_cli(CLI, &["item".into(), "view".into(), reference.to_string()], &refs, TIMEOUT)
        .await
        .map_err(|e| e.to_string())
}

/// Parse a `vault list` line: `- [<share_id>]: <name>` → (share_id, name).
fn parse_vault_line(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("- [")?;
    let (id, name) = rest.split_once("]: ")?;
    if id.is_empty() || name.is_empty() {
        return None;
    }
    Some((id.to_string(), name.to_string()))
}

#[derive(serde::Deserialize)]
struct ItemListOutput {
    items: Vec<ItemEntry>,
}

#[derive(serde::Deserialize)]
struct ItemEntry {
    id: String,
    title: String,
}

#[derive(serde::Deserialize)]
struct ItemViewOutput {
    item: ItemViewContent,
}

#[derive(serde::Deserialize)]
struct ItemViewContent {
    content: ItemViewInner,
}

#[derive(serde::Deserialize)]
struct ItemViewInner {
    title: String,
}

pub struct ProtonProvider;

#[async_trait]
impl SecretProvider for ProtonProvider {
    fn id(&self) -> &'static str {
        "proton"
    }

    async fn status(&self) -> ProviderStatus {
        // One probe doubles as install + auth check: spawn failure = missing
        // binary, non-zero exit = auth/session problem.
        let env = pat_env();
        let refs = env_refs(&env);
        match run_cli(CLI, &["vault".into(), "list".into()], &refs, TIMEOUT).await {
            Ok(_) => ProviderStatus::Ready,
            Err(CliError::NotInstalled) => ProviderStatus::NotInstalled {
                message: "pass-cli not found on PATH — install the Proton Pass CLI (https://proton.me/pass)".into(),
            },
            Err(CliError::Timeout) => ProviderStatus::Error {
                message: "pass-cli timed out".into(),
            },
            // Bad PAT and expired session both surface as a failed call.
            Err(CliError::Failed { .. }) => ProviderStatus::AuthExpired {
                action: "Run `pass-cli login` in your terminal".into(),
            },
        }
    }

    async fn resolve(&self, reference: &str) -> Result<String, String> {
        parse_ref(reference)?; // validate before spawn
        item_view(reference).await
    }

    /// Validate the ref end-to-end and return the item title as a display
    /// label — never the secret (host form "Test" button, chunk 9). Views the
    /// item without a field so the JSON includes `content.title`.
    async fn test_reference(&self, reference: &str) -> Result<String, String> {
        let (vault, item, _field) = parse_ref(reference)?;
        let env = pat_env();
        let refs = env_refs(&env);
        let out = run_cli(
            CLI,
            &[
                "item".into(),
                "view".into(),
                format!("pass://{}/{}", vault, item),
                "--output".into(),
                "json".to_string(),
            ],
            &refs,
            TIMEOUT,
        )
        .await
        .map_err(|e| e.to_string())?;
        let parsed: ItemViewOutput = serde_json::from_str(&out).map_err(|e| e.to_string())?;
        Ok(parsed.item.content.title)
    }

    fn can_list(&self) -> bool {
        true
    }

    /// Enumerate credentials for the browse UI (chunk 15). Refs use opaque
    /// IDs (`pass://<share_id>/<item_id>/password`) — titles can duplicate.
    async fn list(&self) -> Result<Vec<CredentialItem>, String> {
        let env = pat_env();
        let refs = env_refs(&env);
        let vaults = run_cli(CLI, &["vault".into(), "list".into()], &refs, TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for line in vaults.lines() {
            let (share_id, _name) = match parse_vault_line(line.trim()) {
                Some(v) => v,
                None => continue,
            };
            let out = run_cli(
                CLI,
                &[
                    "item".into(),
                    "list".into(),
                    "--share-id".into(),
                    share_id.clone(),
                    "--output".into(),
                    "json".to_string(),
                ],
                &refs,
                TIMEOUT,
            )
            .await
            .map_err(|e| e.to_string())?;
            let parsed: ItemListOutput = serde_json::from_str(&out).map_err(|e| e.to_string())?;
            for entry in parsed.items {
                items.push(CredentialItem {
                    id: format!("pass://{}/{}/{}", share_id, entry.id, DEFAULT_FIELD),
                    label: entry.title,
                    username: None,
                });
            }
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_ref, parse_vault_line};

    #[test]
    fn test_parse_vault_line() {
        assert_eq!(
            parse_vault_line("- [abc123==]: Personal").unwrap(),
            ("abc123==".to_string(), "Personal".to_string())
        );
        for bad in ["", "- no brackets", "[id]: Name", "- []: x", "- [x]:"] {
            assert!(parse_vault_line(bad).is_none(), "should reject: {}", bad);
        }
    }

    #[test]
    fn test_parse_ref_valid() {
        assert_eq!(
            parse_ref("pass://main/router-lab/password").unwrap(),
            ("main".to_string(), "router-lab".to_string(), "password".to_string())
        );
    }

    #[test]
    fn test_parse_ref_rejects_malformed() {
        for bad in [
            "pass:main/item/field", // wrong scheme separator
            "pass://",              // empty
            "pass://main/item",     // missing field
            "pass://main//password",// empty item
            "pass://main/item/password/extra", // too many segments
            "vault/item/password",  // no scheme
        ] {
            assert!(parse_ref(bad).is_err(), "should reject: {}", bad);
        }
    }
}
