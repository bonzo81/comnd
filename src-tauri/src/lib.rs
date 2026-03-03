//! net.sh — Tauri backend
//! 
//! Handles: SSH connections (russh), KB loading/querying,
//! credential management, and config storage.

mod ssh;
mod kb;

use tauri::Manager;

/// Query the knowledge base for matching commands
#[tauri::command]
async fn query_kb(input: String, platform: String, mode: String) -> Result<String, String> {
    // TODO: Query in-memory KB index
    Ok(format!("[]"))
}

/// Establish SSH connection to a host
#[tauri::command]
async fn ssh_connect(host: String, port: u16, username: String) -> Result<String, String> {
    // TODO: Implement via russh
    Err("SSH not yet implemented".to_string())
}

/// Send data to the SSH channel
#[tauri::command]
async fn ssh_send(session_id: String, data: String) -> Result<(), String> {
    // TODO: Write to SSH channel
    Err("SSH not yet implemented".to_string())
}

/// Disconnect SSH session
#[tauri::command]
async fn ssh_disconnect(session_id: String) -> Result<(), String> {
    // TODO: Clean shutdown
    Err("SSH not yet implemented".to_string())
}

/// Load saved hosts from config
#[tauri::command]
async fn get_hosts() -> Result<String, String> {
    // TODO: Read from app data directory
    Ok("[]".to_string())
}

/// Save a host to config
#[tauri::command]
async fn save_host(host_json: String) -> Result<(), String> {
    // TODO: Write to app data directory
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            query_kb,
            ssh_connect,
            ssh_send,
            ssh_disconnect,
            get_hosts,
            save_host,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
