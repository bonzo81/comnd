//! Credential resolution — the single path from a `CredentialSource` to the
//! concrete auth inputs an SSH session needs, plus key-based keyring helpers.
//!
//! Phase 0 of the host-source plan (docs/plans/plan-netbox-host-source.md §5):
//! extracted from hosts.rs so source-level defaults (e.g. NetBox) can reuse
//! the same resolution with a different keyring key. Types are re-exported
//! from hosts.rs so existing `hosts::...` paths keep compiling.

use serde::{Deserialize, Serialize};

// ─── Credential Types ───────────────────────────────────────────────

/// How a host's auth secret is sourced. Tagged union (serde stays backward compatible).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CredentialSource {
    /// Keyring entry keyed by `host:<id>` (legacy entries: bare `<id>`).
    Password,
    /// Local SSH private key file.
    SshKey { key_path: String },
    /// Agent-signed key. `identity` = fingerprint; None = offer all identities.
    Agent { identity: Option<String> },
    /// Secret-manager item. `provider` = provider id (e.g. "proton"),
    /// `reference` = item reference pasted by the user, `label` = cached display name.
    SecretRef { provider: String, reference: String, label: Option<String> },
}

/// How agent publickey auth should offer identities.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum AgentAuth {
    /// No agent auth for this host.
    #[default]
    Off,
    /// Offer every identity the agent holds.
    All,
    /// Offer only the identity with this fingerprint.
    Fingerprint(String),
}

/// Concrete auth inputs resolved from a `CredentialSource`.
#[derive(Debug, Default)]
pub struct ResolvedCredentials {
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub agent: AgentAuth,
}

// ─── Resolution ─────────────────────────────────────────────────────

/// Resolve a credential source into concrete SSH auth inputs.
///
/// `secret_key` is the keyring key for password secrets (e.g. `host:<id>`,
/// `source:netbox`). Secrets stay Rust-side: the resolved secret is
/// transient — dropped when the returned struct dies, never logged or
/// persisted. SecretRef goes through the async provider registry, so this
/// is async; callers must not hold std Mutex guards across the await.
pub async fn resolve(
    credential: &CredentialSource,
    secret_key: &str,
    registry: &crate::secrets::ProviderRegistry,
) -> Result<ResolvedCredentials, String> {
    match credential {
        CredentialSource::Password => Ok(ResolvedCredentials {
            password: get_secret(secret_key)?,
            key_path: None,
            agent: AgentAuth::Off,
        }),
        CredentialSource::SshKey { key_path } => Ok(ResolvedCredentials {
            password: None,
            key_path: if key_path.is_empty() { None } else { Some(key_path.clone()) },
            agent: AgentAuth::Off,
        }),
        CredentialSource::Agent { identity } => Ok(ResolvedCredentials {
            password: None,
            key_path: None,
            agent: match identity {
                Some(fp) if !fp.is_empty() => AgentAuth::Fingerprint(fp.clone()),
                _ => AgentAuth::All,
            },
        }),
        CredentialSource::SecretRef { provider, reference, .. } => {
            let p = registry
                .get(provider)
                .ok_or_else(|| {
                    format!(
                        "Provider '{}' is not enabled — enable it in Settings → Auth Integrations",
                        provider
                    )
                })?;
            match p.resolve(reference).await {
                Ok(secret) => Ok(ResolvedCredentials {
                    password: Some(secret),
                    key_path: None,
                    agent: AgentAuth::Off,
                }),
                Err(msg) => Err(crate::secrets::resolve_error_message(&p, reference, &msg).await),
            }
        }
    }
}

// ─── Keyring (OS keychain) ──────────────────────────────────────────

/// Keyring key for a host's password secret.
pub fn host_key(host_id: &str) -> String {
    format!("host:{}", host_id)
}

/// Pre-key-scheme entries were stored under the bare host id.
fn legacy_key(key: &str) -> Option<&str> {
    key.strip_prefix("host:")
}

/// Debug-only NetBox API token seed for the app-level NetBox smoke suite
/// (`npm run smoke:netbox`). CI runners have no OS keychain, so the suite
/// supplies the mock instance's token through the environment. Debug builds
/// only — a release binary never reads it.
#[cfg(debug_assertions)]
fn test_mock_netbox_token() -> Option<String> {
    std::env::var("COMND_TEST_MOCK_NETBOX_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// Debug-only: the two NetBox keychain entries live in an in-memory store
/// while the mock token is set, so CI needs no keychain. Host secrets keep
/// using the OS keychain.
#[cfg(debug_assertions)]
fn is_netbox_test_key(key: &str) -> bool {
    key == crate::netbox::TOKEN_KEY || key == crate::netbox::DEFAULT_PW_KEY
}

/// The store behind `is_netbox_test_key`. It is seeded with the environment
/// token, then honours saves and deletes exactly like the keychain, so the
/// app-level suite can tell a working Save Connection apart from one that
/// never wrote the token. `None` when the override is inactive.
#[cfg(debug_assertions)]
fn netbox_test_store(
    key: &str,
) -> Option<std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, String>>>> {
    if test_mock_netbox_token().is_none() || !is_netbox_test_key(key) {
        return None;
    }
    static STORE: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> =
        std::sync::Mutex::new(None);
    let mut store = STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if store.is_none() {
        let mut secrets = std::collections::HashMap::new();
        if let Some(token) = test_mock_netbox_token() {
            secrets.insert(crate::netbox::TOKEN_KEY.to_string(), token);
        }
        *store = Some(secrets);
    }
    Some(store)
}

/// `Some(current value)` when the in-memory store owns `key`, `None` when the
/// keychain does.
#[cfg(debug_assertions)]
fn netbox_test_get(key: &str) -> Option<Option<String>> {
    netbox_test_store(key).map(|store| store.as_ref().and_then(|secrets| secrets.get(key).cloned()))
}

#[cfg(debug_assertions)]
fn netbox_test_save(key: &str, secret: &str) -> bool {
    match netbox_test_store(key) {
        Some(mut store) => {
            if let Some(secrets) = store.as_mut() {
                secrets.insert(key.to_string(), secret.to_string());
            }
            true
        }
        None => false,
    }
}

#[cfg(debug_assertions)]
fn netbox_test_delete(key: &str) -> bool {
    match netbox_test_store(key) {
        Some(mut store) => {
            if let Some(secrets) = store.as_mut() {
                secrets.remove(key);
            }
            true
        }
        None => false,
    }
}

/// Save a secret under `key` in the OS keychain.
pub fn save_secret(key: &str, secret: &str) -> Result<(), String> {
    // Debug-only: the NetBox smoke suite's in-memory store stands in for the
    // keychain, which CI does not have.
    #[cfg(debug_assertions)]
    if netbox_test_save(key, secret) {
        return Ok(());
    }
    keyring::Entry::new("comnd", key)
        .and_then(|e| e.set_password(secret))
        .map_err(|e| e.to_string())
}

/// Get a secret under `key` from the OS keychain (`None` when unset).
/// Lazy migration: when `key` is `host:<id>` and no new entry exists, the
/// legacy bare `<id>` entry is consulted. The new key is written on the
/// next save, so no one-time migration pass is needed.
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    // Debug-only override, consulted before the keychain: on CI the
    // keychain backend fails outright (Err, not NoEntry), so a fallback
    // after it would never be reached.
    #[cfg(debug_assertions)]
    if let Some(stored) = netbox_test_get(key) {
        return Ok(stored);
    }
    match keyring::Entry::new("comnd", key).and_then(|e| e.get_password()) {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => match legacy_key(key) {
            Some(legacy) => match keyring::Entry::new("comnd", legacy).and_then(|e| e.get_password()) {
                Ok(pw) => Ok(Some(pw)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            None => Ok(None),
        },
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the secret under `key` (and its legacy bare-id twin for host keys).
pub fn delete_secret(key: &str) -> Result<(), String> {
    // Debug-only: the NetBox smoke suite's in-memory store stands in for the
    // keychain, which CI does not have.
    #[cfg(debug_assertions)]
    if netbox_test_delete(key) {
        return Ok(());
    }
    delete_entry(key)?;
    if let Some(legacy) = legacy_key(key) {
        let _ = delete_entry(legacy);
    }
    Ok(())
}

fn delete_entry(key: &str) -> Result<(), String> {
    keyring::Entry::new("comnd", key)
        .and_then(|e| e.delete_credential())
        .or_else(|e| {
            // Deleting a non-existent entry is not an error.
            if matches!(e, keyring::Error::NoEntry) { Ok(()) } else { Err(e) }
        })
        .map_err(|e| e.to_string())
}

// ─── Tests ──────────────────────────────────────────────────────────

/// Test guard: real set/get/delete roundtrip on a unique probe entry.
/// Returns false (after printing a visible SKIP line and a GitHub Actions
/// warning annotation) when the OS keychain cannot be used.
#[cfg(test)]
pub(crate) fn keychain_available_or_skip(test: &str) -> bool {
    let probe = (|| -> Result<(), String> {
        let entry = keyring::Entry::new(
            "comnd",
            &format!("comnd_test_probe_{}", uuid::Uuid::new_v4()),
        )
        .map_err(|e| e.to_string())?;
        let roundtrip = entry
            .set_password("probe")
            .and_then(|()| entry.get_password())
            .map_err(|e| e.to_string())
            .and_then(|got| {
                if got == "probe" {
                    Ok(())
                } else {
                    Err("keychain probe value did not roundtrip".to_owned())
                }
            });
        let cleanup = entry
            .delete_credential()
            .or_else(|e| {
                if matches!(e, keyring::Error::NoEntry) {
                    Ok(())
                } else {
                    Err(e)
                }
            })
            .map_err(|e| e.to_string());
        match (roundtrip, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) => Err(e),
            (Ok(()), Err(e)) => Err(format!("failed to clean up keychain probe ({e})")),
            (Err(roundtrip), Err(cleanup)) => Err(format!(
                "{roundtrip}; failed to clean up keychain probe ({cleanup})"
            )),
        }
    })();
    match probe {
        Ok(()) => true,
        Err(e) => {
            println!("SKIP {test}: OS keychain unavailable ({e})");
            println!("::warning title=Keychain test skipped::{test}: OS keychain unavailable ({e})");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_ref_roundtrip() {
        let with_label = r#"{"type":"secret_ref","provider":"proton","reference":"abc123","label":"Lab Router"}"#;
        assert_eq!(
            serde_json::from_str::<CredentialSource>(with_label).unwrap(),
            CredentialSource::SecretRef { provider: "proton".into(), reference: "abc123".into(), label: Some("Lab Router".into()) }
        );
        let json = serde_json::to_string(&CredentialSource::SecretRef { provider: "proton".into(), reference: "abc123".into(), label: None }).unwrap();
        assert_eq!(json, r#"{"type":"secret_ref","provider":"proton","reference":"abc123","label":null}"#);
        // Old files without the variant still parse
        assert_eq!(serde_json::from_str::<CredentialSource>(r#"{"type":"password"}"#).unwrap(), CredentialSource::Password);
    }

    #[test]
    fn test_legacy_key() {
        assert_eq!(legacy_key("host:abc-123"), Some("abc-123"));
        assert_eq!(legacy_key("source:netbox"), None);
        assert_eq!(legacy_key("plain"), None);
    }

    /// Debug-only mock token store (plan 064): the app-level NetBox suite runs
    /// on CI where no OS keychain exists, so the NetBox keys are served from
    /// an in-memory store seeded with the environment token.
    #[cfg(debug_assertions)]
    #[test]
    fn test_netbox_token_env_override() {
        const VAR: &str = "COMND_TEST_MOCK_NETBOX_TOKEN";
        // Sole reader of this variable — nothing else can race it.
        std::env::set_var(VAR, "nbt_mock.token");
        assert_eq!(
            get_secret(crate::netbox::TOKEN_KEY).unwrap().as_deref(),
            Some("nbt_mock.token"),
            "the environment token must seed the store"
        );
        // Saves are honoured, so the suite can prove the UI wrote the token it
        // was given instead of inheriting the seeded one.
        save_secret(crate::netbox::TOKEN_KEY, "typed.token").unwrap();
        assert_eq!(
            get_secret(crate::netbox::TOKEN_KEY).unwrap().as_deref(),
            Some("typed.token")
        );
        delete_secret(crate::netbox::TOKEN_KEY).unwrap();
        assert_eq!(get_secret(crate::netbox::TOKEN_KEY).unwrap(), None);
        // The NetBox config save path clears the default-password entry on
        // every write; that cleanup must not need a keychain either.
        save_secret(crate::netbox::DEFAULT_PW_KEY, "ignored").unwrap();
        assert_eq!(
            get_secret(crate::netbox::DEFAULT_PW_KEY).unwrap().as_deref(),
            Some("ignored")
        );
        delete_secret(crate::netbox::DEFAULT_PW_KEY).unwrap();
        assert_eq!(get_secret(crate::netbox::DEFAULT_PW_KEY).unwrap(), None);
        // Host secrets are untouched by the NetBox store.
        assert!(!is_netbox_test_key(&host_key("host-1")));
        std::env::remove_var(VAR);
        assert!(test_mock_netbox_token().is_none());
        assert!(netbox_test_store(crate::netbox::TOKEN_KEY).is_none());
    }

    fn empty_registry() -> crate::secrets::ProviderRegistry {
        crate::secrets::ProviderRegistry::new(vec![])
    }

    #[tokio::test]
    async fn test_resolve_ssh_key() {
        let registry = empty_registry();
        let creds = resolve(
            &CredentialSource::SshKey { key_path: "~/.ssh/id_rsa".into() },
            "host:h1",
            &registry,
        )
        .await
        .unwrap();
        assert_eq!(creds.password, None);
        assert_eq!(creds.key_path.as_deref(), Some("~/.ssh/id_rsa"));
        assert_eq!(creds.agent, AgentAuth::Off);

        // Empty key path → no key auth
        let creds = resolve(&CredentialSource::SshKey { key_path: String::new() }, "host:h1", &registry)
            .await
            .unwrap();
        assert_eq!(creds.key_path, None);
    }

    #[tokio::test]
    async fn test_resolve_agent() {
        let registry = empty_registry();
        // No identity → offer all
        let creds = resolve(&CredentialSource::Agent { identity: None }, "host:h1", &registry)
            .await
            .unwrap();
        assert_eq!(creds.agent, AgentAuth::All);
        // Empty identity → offer all
        let creds = resolve(
            &CredentialSource::Agent { identity: Some(String::new()) },
            "host:h1",
            &registry,
        )
        .await
        .unwrap();
        assert_eq!(creds.agent, AgentAuth::All);
        // Fingerprint → only that identity
        let creds = resolve(
            &CredentialSource::Agent { identity: Some("SHA256:abc".into()) },
            "host:h1",
            &registry,
        )
        .await
        .unwrap();
        assert_eq!(creds.agent, AgentAuth::Fingerprint("SHA256:abc".into()));
        assert_eq!(creds.password, None);
        assert_eq!(creds.key_path, None);
    }

    #[tokio::test]
    async fn test_resolve_secret_ref_disabled_provider() {
        let registry = empty_registry();
        let err = resolve(
            &CredentialSource::SecretRef { provider: "proton".into(), reference: "ref".into(), label: None },
            "host:h1",
            &registry,
        )
        .await
        .unwrap_err();
        assert!(err.contains("not enabled"), "unexpected error: {}", err);
    }

    #[tokio::test]
    async fn test_resolve_password_reads_keyring() {
        // Best-effort: skip when the OS keychain is unavailable (e.g. CI).
        if !crate::credentials::keychain_available_or_skip("credentials::test_resolve_password_reads_keyring") {
            return;
        }
        let key = host_key(&format!("comnd_cred_test_{}", uuid::Uuid::new_v4()));
        save_secret(&key, "pw-123").unwrap();

        let registry = empty_registry();
        let creds = resolve(&CredentialSource::Password, &key, &registry).await.unwrap();
        // Windows Credential Manager has a session-scoping quirk where a
        // credential written by one Entry instance may not be visible from a
        // subsequent Entry instance in the same process (see config.rs
        // tests). Accept None there; other platforms must see the password.
        if !cfg!(target_os = "windows") {
            assert_eq!(creds.password.as_deref(), Some("pw-123"));
        }

        let _ = delete_secret(&key);
    }

    #[tokio::test]
    async fn test_get_secret_falls_back_to_legacy_bare_id() {
        if !crate::credentials::keychain_available_or_skip("credentials::test_get_secret_falls_back_to_legacy_bare_id") {
            return;
        }
        let id = format!("comnd_legacy_{}", uuid::Uuid::new_v4());
        // Simulate a pre-key-scheme entry: stored under the bare host id.
        let legacy_entry = keyring::Entry::new("comnd", &id).unwrap();
        legacy_entry.set_password("old-pw").unwrap();

        match get_secret(&host_key(&id)) {
            Ok(Some(pw)) if pw == "old-pw" => {}
            Ok(None) if cfg!(target_os = "windows") => {} // keychain quirk, see above
            other => panic!("expected legacy fallback, got {:?}", other.map(|p| p.is_some())),
        }

        let _ = delete_secret(&host_key(&id));
    }
}
