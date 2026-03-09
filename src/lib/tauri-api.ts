/**
 * Tauri API — typed wrappers for all Tauri invoke() calls
 * Single source of truth for frontend ↔ backend IPC.
 */

import { invoke } from "@tauri-apps/api/core";

// ─── Types ──────────────────────────────────────────────────────────

export type AuthType = "password" | "ssh_key";

export interface Host {
  id: string;
  display_name: string;
  hostname: string;
  port: number;
  username: string;
  auth_type: AuthType;
  ssh_key_path: string | null;
  platform: string;
  os_version: string | null;
  notes: string | null;
  last_connected: string | null;
  created_at: string;
  sort_order: number;
}

export interface PlatformIndex {
  id: string;
  name: string;
  description: string;
  reference_url: string;
  versions: string[];
  prompt_patterns: Record<string, string>;
  default_mode: string;
}

export interface Command {
  name: string;
  syntax: string;
  description: string;
  category: string;
  mode: string;
  aliases: string[];
  examples: CommandExample[];
  versions: CommandVersions;
  tags: string[];
}

export interface CommandExample {
  command: string;
  description: string;
}

export interface CommandVersions {
  introduced: string | null;
  deprecated: string | null;
  notes: string | null;
}

// ─── KB Commands ────────────────────────────────────────────────────

export async function queryKb(
  prefix: string,
  platform: string,
  mode: string | null,
  version: string | null,
): Promise<Command[]> {
  return invoke<Command[]>("query_kb", { prefix, platform, mode, version });
}

export async function loadPlatformIndex(
  platform: string,
): Promise<PlatformIndex> {
  return invoke<PlatformIndex>("load_platform_index", { platform });
}

// ─── Host Commands ──────────────────────────────────────────────────

export async function getHosts(): Promise<Host[]> {
  return invoke<Host[]>("get_hosts");
}

export async function saveHost(host: Partial<Host>): Promise<Host> {
  return invoke<Host>("save_host", { host });
}

export async function deleteHost(id: string): Promise<void> {
  return invoke<void>("delete_host", { id });
}

export async function reorderHosts(ids: string[]): Promise<void> {
  return invoke<void>("reorder_hosts", { ids });
}

export async function touchHost(id: string): Promise<void> {
  return invoke<void>("touch_host", { id });
}

// ─── Credential Commands ────────────────────────────────────────────

export async function saveCredential(
  hostId: string,
  password: string,
): Promise<void> {
  return invoke<void>("save_credential", { hostId, password });
}

export async function getCredential(
  hostId: string,
): Promise<string | null> {
  return invoke<string | null>("get_credential", { hostId });
}

// ─── SSH Commands ───────────────────────────────────────────────────

export async function sshConnect(params: {
  hostname: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  cols: number;
  rows: number;
}): Promise<void> {
  return invoke<void>("ssh_connect", {
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    password: params.password ?? null,
    keyPath: params.keyPath ?? null,
    cols: params.cols,
    rows: params.rows,
  });
}

export async function sshSend(data: string): Promise<void> {
  return invoke<void>("ssh_send", { data });
}

export async function sshDisconnect(): Promise<void> {
  return invoke<void>("ssh_disconnect");
}

export async function sshResize(cols: number, rows: number): Promise<void> {
  return invoke<void>("ssh_resize", { cols, rows });
}

export async function sshAuthResponse(response: string): Promise<void> {
  return invoke<void>("ssh_auth_response", { response });
}
