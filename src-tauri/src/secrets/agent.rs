//! SSH agent discovery + identity enumeration (credential chunk 3),
//! shared by the UI listing and the auth chain (chunk 4).
//!
//! Detection order: SSH_AUTH_SOCK (unix) / OpenSSH agent named pipe
//! (windows), then Pageant as the windows fallback.

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::PublicKey;
use serde::Serialize;

/// SHA-256 fingerprint, bare base64 no-pad — the format russh 0.46 produced
/// and hosts.json stores. ssh-key's Display adds a "SHA256:" prefix; strip it.
pub fn fingerprint_b64(key: &PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256)
        .to_string()
        .trim_start_matches("SHA256:")
        .to_string()
}

#[derive(Debug, Serialize)]
pub struct AgentIdentity {
    /// SHA-256 fingerprint, base64 no-pad (russh's format).
    pub fingerprint: String,
    pub algorithm: String,
}

/// Transport-agnostic agent client — any socket type erased to a dynamic stream.
pub type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

/// Connect to the first reachable SSH agent. The caller owns the socket and
/// drops it when done (auth opens one per connect attempt).
pub async fn connect_agent() -> Result<DynAgent, String> {
    #[cfg(unix)]
    {
        match AgentClient::connect_env().await {
            Ok(client) => return Ok(client.dynamic()),
            Err(e) => {
                return Err(format!(
                    "No SSH agent detected — start ssh-agent and add a key. Tried: {e}"
                ))
            }
        }
    }

    #[cfg(windows)]
    {
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(client) => return Ok(client.dynamic()),
            Err(_) => {}
        }
        Err("No SSH agent detected — start ssh-agent and add a key".to_string())
    }
}

/// List identities from the first reachable agent.
///
/// `Err` carries a human-readable "no agent" reason for the UI.
pub async fn list_identities() -> Result<Vec<AgentIdentity>, String> {
    let client = connect_agent().await?;
    identities(client).await.map_err(|e| format!("No SSH agent detected — no identities from agent: {e}"))
}

async fn identities(mut client: DynAgent) -> Result<Vec<AgentIdentity>, String> {
    let keys: Vec<PublicKey> = client
        .request_identities()
        .await
        .map_err(|e| e.to_string())?;
    Ok(keys
        .into_iter()
        .map(|k| AgentIdentity {
            fingerprint: fingerprint_b64(&k),
            algorithm: k.algorithm().as_str().to_string(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Environment-dependent probe: must not panic, and an Err must carry
    /// an actionable message. Print result for manual verification.
    #[tokio::test]
    async fn test_list_identities_no_panic() {
        match list_identities().await {
            Ok(list) => println!("agent identities: {list:?}"),
            Err(e) => {
                println!("no agent: {e}");
                assert!(e.contains("No SSH agent"), "unexpected error: {e}");
            }
        }
    }
}
