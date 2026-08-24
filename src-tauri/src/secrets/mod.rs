//! Secrets — SSH agent transport + secret provider framework.
//!
//! Chunk 3: agent. Chunk 6: SecretProvider trait, registry, shared CLI runner.

pub mod agent;
pub mod providers;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;

// ─── Provider types ────────────────────────────────────────────────

/// Live state of a secret provider. Surfaced to the settings UI (chunk 7)
/// and the connect flow (chunk 10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderStatus {
    Ready,
    NotInstalled { message: String },
    AuthExpired { action: String },
    Error { message: String },
}

/// One credential a provider can enumerate (browse UI, chunk 15).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CredentialItem {
    /// Provider-specific reference — what `resolve()` takes.
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// A secret manager the app can pull credentials from. Implementations are
/// stateless: config comes from config.json, secrets from the OS keychain —
/// both read per call so settings changes apply without a restart.
#[async_trait]
pub trait SecretProvider: Send + Sync {
    /// Stable id — the config.json `providers` key and the keyring entry
    /// (`netsh_provider_<id>`).
    fn id(&self) -> &'static str;

    /// Probe whether the provider is usable right now.
    async fn status(&self) -> ProviderStatus;

    /// Resolve a reference to its secret (password/passphrase). Transient —
    /// callers drop it after use; never log or persist it.
    async fn resolve(&self, reference: &str) -> Result<String, String>;

    /// Validate a reference and return its display label without exposing
    /// the secret (host form "Test" button, chunk 9).
    async fn test_reference(&self, reference: &str) -> Result<String, String> {
        let _ = reference;
        Err("not supported".to_string())
    }

    /// Enumerate credentials for the browse UI (chunk 15).
    async fn list(&self) -> Result<Vec<CredentialItem>, String> {
        Err("not supported".to_string())
    }
}

// ─── Registry ──────────────────────────────────────────────────────

/// Compiled-in providers, filtered to enabled ones. Rebuilt from config when
/// provider settings change (chunk 7).
pub struct ProviderRegistry {
    providers: Vec<Arc<dyn SecretProvider>>,
}

impl ProviderRegistry {
    pub fn new(providers: Vec<Arc<dyn SecretProvider>>) -> Self {
        Self { providers }
    }

    /// Build the registry from config. Only enabled providers are included.
    pub fn from_config(config: &crate::config::AppConfig) -> Self {
        let mut list: Vec<Arc<dyn SecretProvider>> = Vec::new();
        if provider_enabled(config, "proton") {
            list.push(Arc::new(providers::proton::ProtonProvider));
        }
        Self::new(list)
    }

    /// Clone the handle for `id` (None when unknown or disabled).
    pub fn get(&self, id: &str) -> Option<Arc<dyn SecretProvider>> {
        self.providers.iter().find(|p| p.id() == id).cloned()
    }

    pub fn all(&self) -> Vec<Arc<dyn SecretProvider>> {
        self.providers.clone()
    }
}

/// True when the provider's config entry has `"enabled": true`.
fn provider_enabled(config: &crate::config::AppConfig, id: &str) -> bool {
    config
        .providers
        .get(id)
        .and_then(|v| v.get("enabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

// ─── Shared CLI runner ─────────────────────────────────────────────

/// Failure of a provider CLI invocation.
#[derive(Debug)]
pub enum CliError {
    /// Binary not found on PATH — map to `ProviderStatus::NotInstalled`.
    NotInstalled,
    /// Did not finish within the timeout (killed).
    Timeout,
    /// Non-zero exit or spawn failure.
    Failed { code: Option<i32>, stderr: String },
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled => write!(f, "not installed"),
            Self::Timeout => write!(f, "timed out"),
            Self::Failed { code, stderr } => write!(f, "failed ({:?}): {}", code, stderr),
        }
    }
}

impl std::error::Error for CliError {}

/// Run a provider CLI. Arg array only — secrets go in `env`, never argv,
/// never through a shell. Stdin is null so interactive prompts fail fast.
/// Returns trimmed stdout.
pub async fn run_cli(
    program: &str,
    args: &[String],
    env: &[(&str, &str)],
    timeout: Duration,
) -> Result<String, CliError> {
    let mut cmd = tokio::process::Command::new(program);
    // Kill the process if the wait future is dropped (timeout path).
    // Stdin null: interactive prompts fail fast. Stdout/err piped: captured,
    // never inherited (no console writes from provider CLIs).
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CliError::NotInstalled),
        Err(e) => return Err(CliError::Failed { code: None, stderr: e.to_string() }),
    };

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(CliError::Failed {
                    code: output.status.code(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            }
        }
        Ok(Err(e)) => Err(CliError::Failed { code: None, stderr: e.to_string() }),
        // Future dropped here → kill_on_drop terminates the process.
        Err(_) => Err(CliError::Timeout),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Env-var-backed provider — exercises the trait + registry without a CLI.
    struct MockProvider {
        id: &'static str,
        secret_env: &'static str,
    }

    #[async_trait]
    impl SecretProvider for MockProvider {
        fn id(&self) -> &'static str {
            self.id
        }

        async fn status(&self) -> ProviderStatus {
            if std::env::var(self.secret_env).is_ok() {
                ProviderStatus::Ready
            } else {
                ProviderStatus::NotInstalled {
                    message: "mock not configured".into(),
                }
            }
        }

        async fn resolve(&self, reference: &str) -> Result<String, String> {
            match std::env::var(self.secret_env) {
                Ok(v) if v == "fail" => Err(format!("mock failure for {}", reference)),
                Ok(v) => Ok(format!("{}:{}", reference, v)),
                Err(_) => Err("mock not configured".into()),
            }
        }

        async fn test_reference(&self, reference: &str) -> Result<String, String> {
            self.resolve(reference)
                .await
                .map(|_| format!("label for {}", reference))
        }

        async fn list(&self) -> Result<Vec<CredentialItem>, String> {
            Ok(vec![CredentialItem {
                id: "a".into(),
                label: "A".into(),
                username: Some("u".into()),
            }])
        }
    }

    /// Implements only the required methods — default impls must error.
    struct BareProvider;

    #[async_trait]
    impl SecretProvider for BareProvider {
        fn id(&self) -> &'static str {
            "bare"
        }
        async fn status(&self) -> ProviderStatus {
            ProviderStatus::Ready
        }
        async fn resolve(&self, _reference: &str) -> Result<String, String> {
            Ok("x".into())
        }
    }

    // Single function: env vars are process-global, parallel tests would race.
    #[tokio::test]
    async fn test_mock_provider_status_resolve_list() {
        const VAR: &str = "NETSH_TEST_MOCK_SECRET";
        std::env::remove_var(VAR);

        let p = MockProvider { id: "mock", secret_env: VAR };

        assert_eq!(
            p.status().await,
            ProviderStatus::NotInstalled { message: "mock not configured".into() }
        );
        assert!(p.resolve("x").await.is_err());

        std::env::set_var(VAR, "s3cret");
        assert_eq!(p.status().await, ProviderStatus::Ready);
        assert_eq!(
            p.resolve("vault/item/password").await.unwrap(),
            "vault/item/password:s3cret"
        );

        // test_reference returns a label, never the secret
        let label = p.test_reference("vault/item/password").await.unwrap();
        assert!(!label.contains("s3cret"));
        assert!(label.contains("vault/item/password"));

        std::env::set_var(VAR, "fail");
        assert!(p.resolve("x").await.is_err());
        assert!(p.test_reference("x").await.is_err());

        let items = p.list().await.unwrap();
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].username.as_deref(), Some("u"));

        std::env::remove_var(VAR);
    }

    #[tokio::test]
    async fn test_default_impls_unsupported() {
        let p = BareProvider;
        assert!(p.list().await.is_err());
        assert!(p.test_reference("r").await.is_err());
    }

    #[test]
    fn test_registry_lookup() {
        let reg = ProviderRegistry::new(vec![Arc::new(MockProvider {
            id: "mock",
            secret_env: "NETSH_TEST_MOCK_SECRET",
        })]);
        assert!(reg.get("mock").is_some());
        assert!(reg.get("nope").is_none());
        assert_eq!(reg.all().len(), 1);

        let empty = ProviderRegistry::from_config(&crate::config::AppConfig::default());
        assert!(empty.all().is_empty());
    }

    #[test]
    fn test_provider_status_ipc_shape() {
        // Pins the serde tag the frontend switches on.
        let v = serde_json::to_value(ProviderStatus::AuthExpired { action: "x".into() }).unwrap();
        assert_eq!(v["kind"], "auth_expired");
        assert_eq!(v["action"], "x");
    }

    #[tokio::test]
    async fn test_run_cli_not_installed() {
        let err = run_cli(
            "netsh-definitely-not-a-real-binary-xyz",
            &[],
            &[],
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CliError::NotInstalled));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_run_cli_stdout_and_env() {
        // cmd /C prints the env var value — proves args + env wiring.
        let out = run_cli(
            "cmd",
            &["/C".into(), "echo".into(), "%NETSH_TEST_CLI_VAL%".into()],
            &[("NETSH_TEST_CLI_VAL", "hello-cli")],
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(out, "hello-cli");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_run_cli_nonzero_exit() {
        let err = run_cli(
            "cmd",
            &["/C".into(), "exit".into(), "3".into()],
            &[],
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        match err {
            CliError::Failed { code, .. } => assert_eq!(code, Some(3)),
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_run_cli_timeout_kills() {
        // ping sleeps ~4s without needing a console (timeout.exe exits early
        // when stdin is redirected).
        let err = run_cli(
            "ping",
            &["-n".into(), "5".into(), "127.0.0.1".into()],
            &[],
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CliError::Timeout));
    }
}
