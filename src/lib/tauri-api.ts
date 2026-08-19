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
  tags: string[];
  group_id: string | null;
}

export interface HostGroup {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  color: string | null;
  icon: string | null;
  created_at: string;
}

export interface PlatformIndex {
  id: string;
  name: string;
  description: string;
  reference_url: string;
  versions: string[];
  prompt_patterns: Record<string, string>;
  default_mode: string;
  negation_prefix?: string | null;
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
  tokens?: CommandToken[];
  order?: CommandOrder;
  negatable?: boolean;
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

export type CommandOrder = "fixed" | "flags-anywhere" | "free";

export type CommandToken =
  | { lit: string; optional?: boolean }
  | { choice: string[]; optional?: boolean; repeatable?: boolean }
  | { var: string; type?: VarType; source?: VarSource; optional?: boolean; values?: string[]; min?: number; max?: number }
  | { pipe: boolean; filters?: PipeFilter[]; optional?: boolean; repeatable?: boolean };

export type VarType = "free" | "enumerable" | "numeric" | "choice";
export type VarSource = "none" | "device" | "kb";

export interface PipeFilter {
  lit: string;
  var?: string;
  type?: VarType;
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

export interface KbValidationIssue {
  command: string;
  severity: "error" | "warning";
  message: string;
}

export async function validateKb(
  platform: string,
): Promise<KbValidationIssue[]> {
  return invoke<KbValidationIssue[]>("validate_kb", { platform });
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

export async function touchHost(id: string): Promise<void> {
  return invoke<void>("touch_host", { id });
}

// ─── Host Group Commands ─────────────────────────────────────────────

export async function getHostGroups(): Promise<HostGroup[]> {
  return invoke<HostGroup[]>("get_host_groups");
}

export async function saveHostGroup(
  id: string | null,
  name: string,
  parentId: string | null,
  color: string | null,
  icon: string | null,
): Promise<HostGroup> {
  return invoke<HostGroup>("save_host_group", { id, name, parentId, color, icon });
}

export async function moveHostGroup(
  id: string,
  newParent: string | null,
  sortOrder: number,
): Promise<HostGroup> {
  return invoke<HostGroup>("move_host_group", { id, newParent, sortOrder });
}

export async function deleteHostGroup(id: string): Promise<void> {
  return invoke<void>("delete_host_group", { id });
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
  sessionId: number;
}): Promise<void> {
  return invoke<void>("ssh_connect", {
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    password: params.password ?? null,
    keyPath: params.keyPath ?? null,
    cols: params.cols,
    rows: params.rows,
    sessionId: params.sessionId,
  });
}

export async function sshSend(sessionId: number, data: string): Promise<void> {
  return invoke<void>("ssh_send", { sessionId, data });
}

export async function sshDisconnect(sessionId: number): Promise<void> {
  return invoke<void>("ssh_disconnect", { sessionId });
}

export async function sshResize(sessionId: number, cols: number, rows: number): Promise<void> {
  return invoke<void>("ssh_resize", { sessionId, cols, rows });
}

export async function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url_cmd", { url });
}

// ─── Config Commands ────────────────────────────────────────────────

export interface AppConfig {
  ollama_base_url: string;
  ollama_model: string;
  ollama_api_key: string | null;
  ollama_context_length: number;
}

export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_app_config");
}

export async function saveOllamaSettings(
  baseUrl: string,
  model: string,
  apiKey: string | null,
  contextLength: number,
): Promise<void> {
  return invoke<void>("save_ollama_settings", {
    baseUrl,
    model,
    apiKey,
    contextLength,
  });
}

// ─── KB Import Commands ─────────────────────────────────────────────

export interface ImportResult {
  commands_imported: number;
  target_file: string;
  platform: string;
  category: string;
  source_url: string;
  errors: string[];
}

export interface ImportProgress {
  stage: string;
  detail?: string | number;
}

export async function importKbUrl(
  url: string,
  platform: string,
  category: string,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_kb_url", { url, platform, category });
}

// ─── Two-stage import (Phase 5.6) ────────────────────────────────────

export interface CommandPreview {
  command: Command;
  /** "ok" if all token checks pass; "warn" if tokens were dropped (Phase 5.3). */
  status: string;
  /** Human-readable issues (empty when status is "ok"). */
  issues: string[];
}

export interface ExtractPreview {
  previews: CommandPreview[];
  platform: string;
  category: string;
  source_url: string;
  errors: string[];
}

/** Stage 1: extract + validate without writing. */
export async function extractKbPreview(
  url: string,
  platform: string,
  category: string,
): Promise<ExtractPreview> {
  return invoke<ExtractPreview>("extract_kb_preview", { url, platform, category });
}

/** Stage 2: write the user-approved previews to YAML + reload. */
export async function commitKbImport(
  previews: CommandPreview[],
  platform: string,
  category: string,
): Promise<number> {
  return invoke<number>("commit_kb_import", { previews, platform, category });
}

export async function testOllamaConnection(): Promise<string[]> {
  return invoke<string[]>("test_ollama_connection");
}

export async function listKbPlatforms(): Promise<string[]> {
  return invoke<string[]>("list_kb_platforms");
}

export async function getAllKbCommands(platform: string): Promise<Command[]> {
  return invoke<Command[]>("get_all_kb_commands", { platform });
}

export async function saveKbCommand(
  platform: string,
  category: string,
  name: string,
  syntax: string,
  description: string,
  mode: string,
  aliases: string[],
  tags: string[],
  /** Phase 5.8: optional token fields. tokensJson is a JSON array of CommandToken. */
  tokensJson?: string,
  order?: CommandOrder,
  negatable?: boolean,
): Promise<void> {
  return invoke<void>("save_kb_command", {
    platform, category, name, syntax, description, mode, aliases, tags,
    tokensJson: tokensJson ?? null,
    order: order ?? null,
    negatable: negatable ?? null,
  });
}

export async function deleteKbCommand(
  platform: string,
  category: string,
  commandName: string,
): Promise<void> {
  return invoke<void>("delete_kb_command", { platform, category, commandName });
}

// ─── Test Helpers (debug builds only) ───────────────────────────────

export async function testStartMockServer(): Promise<number> {
  return invoke<number>("test_mock_server");
}

export async function testStopMockServer(): Promise<void> {
  return invoke<void>("test_stop_mock_server");
}
