//! SSH agent discovery + identity enumeration (credential chunk 3).
//!
//! Transport only — auth use of the agent lands in chunk 4.
//! Detection order: SSH_AUTH_SOCK (unix) / OpenSSH agent named pipe
//! (windows), then Pageant as the windows fallback.

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::key::PublicKey;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AgentIdentity {
    /// SHA-256 fingerprint, base64 no-pad (russh's format).
    pub fingerprint: String,
    pub algorithm: &'static str,
}

/// List identities from the first reachable agent.
///
/// `Err` carries a human-readable "no agent" reason for the UI.
pub async fn list_identities() -> Result<Vec<AgentIdentity>, String> {
    let mut errors: Vec<String> = Vec::new();

    #[cfg(unix)]
    {
        match AgentClient::connect_env().await {
            Ok(client) => return identities(client).await,
            Err(e) => errors.push(format!("ssh-agent (SSH_AUTH_SOCK): {e}")),
        }
    }

    #[cfg(windows)]
    {
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(client) => return identities(client).await,
            Err(e) => errors.push(format!("OpenSSH agent service: {e}")),
        }
        // Pageant: connect always "succeeds" (window-message transport);
        // the identities request is the real probe.
        match identities(AgentClient::connect_pageant().await).await {
            Ok(list) => return Ok(list),
            Err(e) => errors.push(format!("Pageant: {e}")),
        }
    }

    Err(format!(
        "No SSH agent detected — start ssh-agent (or the OpenSSH Authentication Agent service on Windows) and add a key. Tried: {}",
        errors.join("; ")
    ))
}

async fn identities<S>(mut client: AgentClient<S>) -> Result<Vec<AgentIdentity>, String>
where
    S: AgentStream + Unpin,
{
    let keys: Vec<PublicKey> = client
        .request_identities()
        .await
        .map_err(|e| e.to_string())?;
    Ok(keys
        .into_iter()
        .map(|k| AgentIdentity {
            fingerprint: k.fingerprint(),
            algorithm: k.name(),
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
