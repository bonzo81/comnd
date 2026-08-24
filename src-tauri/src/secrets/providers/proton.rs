//! Proton Pass provider — `pass-cli` on PATH (chunk 8).
//!
//! Ref format: `pass://<vault>/<item>/<field>`. Auth via the PAT env var when
//! a token is stored in the keyring, otherwise a persisted interactive session.
//! CLI invocations follow the implementation plan's shapes — confirm them
//! against a real install and record findings in
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
/// ponytail: assumes raw output is a clean single value; switch to
/// `--output json` + parse once the real schema is confirmed.
async fn item_view(reference: &str) -> Result<String, String> {
    let env = pat_env();
    let refs = env_refs(&env);
    run_cli(CLI, &["item".into(), "view".into(), reference.to_string()], &refs, TIMEOUT)
        .await
        .map_err(|e| e.to_string())
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

    /// Validate the ref end-to-end and return the item name as a display
    /// label — never the secret (host form "Test" button, chunk 9).
    async fn test_reference(&self, reference: &str) -> Result<String, String> {
        let (_vault, item, _field) = parse_ref(reference)?;
        item_view(reference).await?;
        Ok(item)
    }

    /// Enumerate credentials for the browse UI (chunk 15).
    async fn list(&self) -> Result<Vec<CredentialItem>, String> {
        let env = pat_env();
        let refs = env_refs(&env);
        // ponytail: line-based parse assumed; `vault list` output fed straight
        // to `--share-id` — confirm both shapes (and whether names vs IDs)
        // before the browse UI ships. `--output json` is the upgrade path.
        let vaults = run_cli(CLI, &["vault".into(), "list".into()], &refs, TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for vault in vaults.lines().map(str::trim).filter(|v| !v.is_empty()) {
            let out = run_cli(
                CLI,
                &["item".into(), "list".into(), "--share-id".into(), vault.to_string()],
                &refs,
                TIMEOUT,
            )
            .await
            .map_err(|e| e.to_string())?;
            for item in out.lines().map(str::trim).filter(|i| !i.is_empty()) {
                items.push(CredentialItem {
                    id: format!("pass://{}/{}/{}", vault, item, DEFAULT_FIELD),
                    label: item.to_string(),
                    username: None,
                });
            }
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::parse_ref;

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
