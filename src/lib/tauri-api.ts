/**
 * Tauri API — typed wrappers for all Tauri invoke() calls
 * Single source of truth for frontend ↔ backend IPC.
 */

import { invoke } from "@tauri-apps/api/core";

// ─── Types ──────────────────────────────────────────────────────────

export type CredentialSource =
  | { type: "password" }
  | { type: "ssh_key"; key_path: string }
  | { type: "agent"; identity: string | null }
  | { type: "secret_ref"; provider: string; reference: string; label: string | null };

export interface Host {
  id: string;
  display_name: string;
  hostname: string;
  port: number;
  username: string;
  credential?: CredentialSource;
  platform: string;
  os_version: string | null;
  highlight_profile: string | null;
  notes: string | null;
  last_connected: string | null;
  created_at: string;
  sort_order: number;
  tags: string[];
  group_id: string | null;
  /** Host source integration that materialized this host ("netbox"), null for user hosts. */
  source?: string | null;
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
  /** Commands that may precede other commands (sudo, tmsh). Keyed by prefix word. */
  prefix_commands?: Record<string, PrefixCommand>;
}

export interface PrefixCommand {
  /** Modes whose commands become matchable after the prefix is stripped. */
  unlocks: string[];
  /** Flags before the inner command that take a value to skip (e.g. sudo's `-u`). */
  skip_flag_value?: string[];
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
  /** Provenance (docs/10): "custom" when from the user KB layer; absent for bundled. */
  source?: string;
  /** True when this command replaced a bundled command with the same name. */
  overrides?: boolean;
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
  | { choice: string[]; optional?: boolean; repeatable?: boolean; descriptions?: Record<string, string> }
  | { var: string; description?: string; type?: VarType; source?: VarSource; optional?: boolean; values?: string[]; min?: number; max?: number }
  | { pipe: boolean; filters?: PipeFilter[]; optional?: boolean; repeatable?: boolean };

export type VarType = "free" | "enumerable" | "numeric" | "choice";
export type VarSource = "none" | "device" | "kb";

export interface PipeFilter {
  lit: string;
  var?: string;
  type?: VarType;
}

// ─── KB Commands ────────────────────────────────────────────────────

export async function queryKb(platform: string): Promise<Command[]> {
  return invoke<Command[]>("query_kb", { platform });
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

export async function hasCredential(
  hostId: string,
): Promise<boolean> {
  return invoke<boolean>("has_credential", { hostId });
}

// ─── Secret Provider Commands (chunks 6–7) ─────────────────────────

export type ProviderStatus =
  | { kind: "ready" }
  | { kind: "not_installed"; message: string }
  | { kind: "auth_expired"; action: string }
  | { kind: "error"; message: string };

export interface ProviderInfo {
  id: string;
  status: ProviderStatus;
  /** Provider can enumerate credentials — browse UI available (chunk 15). */
  can_list: boolean;
}

/** One credential a provider can enumerate (browse UI, chunk 15). */
export interface CredentialItem {
  /** Provider-specific reference — what resolve() takes. */
  id: string;
  label: string;
  username?: string;
}

export interface ProviderState {
  enabled: boolean;
  has_secret: boolean;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return invoke<ProviderInfo[]>("list_providers");
}

/** Validate a secret-manager reference; resolves to the item's display label. */
export async function testRef(provider: string, reference: string): Promise<string> {
  return invoke<string>("test_ref", { provider, reference });
}

/** Enumerate a provider's credentials for the browse UI (chunk 15). */
export async function listCredentials(provider: string): Promise<CredentialItem[]> {
  return invoke<CredentialItem[]>("list_credentials", { provider });
}

export async function getProviderState(
  provider: string,
): Promise<ProviderState> {
  return invoke<ProviderState>("get_provider_state", { provider });
}

export async function saveProviderConfig(
  provider: string,
  config: Record<string, unknown>,
): Promise<void> {
  return invoke<void>("save_provider_config", { provider, config });
}

export async function saveProviderSecret(
  provider: string,
  secret: string | null,
): Promise<void> {
  return invoke<void>("save_provider_secret", { provider, secret });
}

// ─── SSH Agent Commands ─────────────────────────────────────────────

export interface AgentIdentity {
  /** SHA-256 fingerprint, base64 no-pad. */
  fingerprint: string;
  algorithm: string;
}

export async function agentListIdentities(): Promise<AgentIdentity[]> {
  return invoke<AgentIdentity[]>("agent_list_identities");
}

// ─── SSH Commands ───────────────────────────────────────────────────

export async function sshConnect(params: {
  hostId: string;
  cols: number;
  rows: number;
  sessionId: number;
}): Promise<void> {
  return invoke<void>("ssh_connect", {
    hostId: params.hostId,
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

/** Answer a pending first-seen host-key (TOFU) confirmation dialog. */
export async function tofuRespond(sessionId: number, accept: boolean): Promise<void> {
  return invoke<void>("tofu_respond", { sessionId, accept });
}

export async function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url_cmd", { url });
}

// ─── Config Commands ────────────────────────────────────────────────

export interface AppConfig {
  llm_api_format: string;
  llm_base_url: string;
  llm_model: string;
  llm_api_key: string | null;
  llm_context_length: number;
  log_level: string;
  log_max_size_mb: number;
  log_file_path: string | null;
  max_sessions: number;
  session_logging: boolean;
  session_log_timestamps: boolean;
  session_log_dir: string | null;
  /** User shortcut overrides (docs/specs/11): action id -> canonical combo. */
  shortcuts?: Record<string, string>;
}

export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_app_config");
}

export async function getLogLevel(): Promise<string> {
  return invoke<string>("get_log_level");
}

export async function setLogLevel(level: string): Promise<void> {
  return invoke<void>("set_log_level", { level });
}

export async function setLogMaxSize(maxMb: number): Promise<void> {
  return invoke<void>("set_log_max_size", { maxMb });
}

export async function setMaxSessions(max: number): Promise<void> {
  return invoke<void>("set_max_sessions", { max });
}

/** Replace all user shortcut overrides (docs/specs/11). Empty map = defaults. */
export async function setShortcutOverrides(overrides: Record<string, string>): Promise<void> {
  return invoke<void>("set_shortcuts", { overrides });
}

export async function getSessionLogDir(): Promise<string> {
  return invoke<string>("get_session_log_dir");
}

export async function setSessionLogging(enabled: boolean): Promise<void> {
  return invoke<void>("set_session_logging", { enabled });
}

export async function setSessionLogTimestamps(enabled: boolean): Promise<void> {
  return invoke<void>("set_session_log_timestamps", { enabled });
}

export async function setSessionLogDir(dir: string | null): Promise<void> {
  return invoke<void>("set_session_log_dir", { dir });
}

// ─── Backup / Restore Commands ──────────────────────────────────────

export async function exportData(destPath: string): Promise<void> {
  return invoke<void>("export_data", { destPath });
}

/** Overwrite mode: replaces all data with the zip contents. */
export async function importData(srcPath: string): Promise<void> {
  return invoke<void>("import_data", { srcPath });
}

export interface MergeConflict {
  file: string;
  key: string;
  current_label: string;
  backup_label: string;
}

export interface MergeScan {
  temp_dir: string;
  new_count: number;
  conflicts: MergeConflict[];
}

/** Merge step 1: scan backup for conflicts without writing anything. */
export async function scanMerge(srcPath: string): Promise<MergeScan> {
  return invoke<MergeScan>("scan_merge", { srcPath });
}

/** Merge step 2: apply the merge with user-provided conflict resolutions. */
export async function applyMerge(
  tempDir: string,
  resolutions: Record<string, "keep_current" | "use_backup">,
): Promise<string> {
  return invoke<string>("apply_merge", { tempDir, resolutions });
}

/** Restart the app process. */
export async function restartApp(): Promise<void> {
  return invoke<void>("restart_app");
}

export async function setLogFilePath(path: string | null): Promise<void> {
  return invoke<void>("set_log_file_path", { path });
}

export async function getLogStatus(): Promise<string | null> {
  return invoke<string | null>("get_log_status");
}

/** Forward a frontend log record to the Rust logger (persisted to netssh.log). */
export function logFrontend(level: string, tag: string, msg: string, args: string): Promise<void> {
  return invoke<void>("log_frontend", { level, tag, msg, args });
}

export async function saveLlmSettings(
  apiFormat: string,
  baseUrl: string,
  model: string,
  apiKey: string | null,
  contextLength: number,
): Promise<void> {
  return invoke<void>("save_llm_settings", {
    apiFormat,
    baseUrl,
    model,
    apiKey,
    contextLength,
  });
}

// ─── KB Import Commands ─────────────────────────────────────────────

// ─── Two-stage import (Phase 5.6) ────────────────────────────────────

export interface CommandPreview {
  command: Command;
  /** "ok" if all token checks pass; "warn" if tokens were dropped (Phase 5.3). */
  status: string;
  /** Human-readable issues (empty when status is "ok"). */
  issues: string[];
  /** True when the name exists in the bundled KB ("Overrides built-in entry"). */
  in_bundled?: boolean;
  /** The bundled command with the same name, for the compare view. */
  bundled?: Command | null;
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
  platformName?: string,
): Promise<ExtractPreview> {
  return invoke<ExtractPreview>("extract_kb_preview", {
    url,
    platform,
    category,
    platformName: platformName ?? null,
  });
}

/** Stage 1 from pasted page text (user's browser did the fetching). */
export async function extractKbPreviewFromText(
  text: string,
  sourceUrl: string,
  platform: string,
  category: string,
  platformName?: string,
): Promise<ExtractPreview> {
  return invoke<ExtractPreview>("extract_kb_preview_from_text", {
    text,
    sourceUrl: sourceUrl || null,
    platform,
    category,
    platformName: platformName ?? null,
  });
}

/** Stage 2: write the user-approved previews to YAML + reload. */
export async function commitKbImport(
  previews: CommandPreview[],
  platform: string,
  category: string,
  platformName?: string,
): Promise<number> {
  return invoke<number>("commit_kb_import", { previews, platform, category, platformName: platformName ?? null });
}

export async function testLlmConnection(): Promise<string[]> {
  return invoke<string[]>("test_llm_connection");
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
): Promise<KbValidationIssue[] | null> {
  // Resolves to null when saved, or the blocking error-severity issues when the
  // validator refused the save. Rejects (throws) on I/O errors or malformed
  // token JSON — those are hard failures, not a validation verdict.
  return invoke<KbValidationIssue[] | null>("save_kb_command", {
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
  overrides: boolean,
): Promise<void> {
  return invoke<void>("delete_kb_command", { platform, category, commandName, overrides });
}

export async function disableKbCommand(
  platform: string,
  commandName: string,
): Promise<void> {
  return invoke<void>("disable_kb_command", { platform, commandName });
}

export async function enableKbCommand(
  platform: string,
  commandName: string,
): Promise<void> {
  return invoke<void>("enable_kb_command", { platform, commandName });
}

export async function getDisabledCommands(platform: string): Promise<string[]> {
  return invoke<string[]>("get_disabled_commands", { platform });
}

// ─── Command Replay (docs/specs/09-command-replay.md) ──────────────────────

export interface ReplayVariable {
  name: string;
}

export interface ReplayCommand {
  id: string;
  command: string; // template with {{name}} markers
  variables: ReplayVariable[];
  platform: string;
  created_at: string;
}

export async function replayList(): Promise<ReplayCommand[]> {
  return invoke<ReplayCommand[]>("replay_list");
}

export async function replaySave(cmd: ReplayCommand): Promise<ReplayCommand> {
  return invoke<ReplayCommand>("replay_save", { cmd });
}

export async function replayDelete(id: string): Promise<void> {
  return invoke<void>("replay_delete", { id });
}

// ─── NetBox Host Source Commands (plan §8.2) ─────────────────────────

export interface NetBoxFilters {
  status: string | null;
  sites: string[];
  roles: string[];
  tags: string[];
}

export interface NetBoxConfig {
  enabled: boolean;
  base_url: string;
  filters: NetBoxFilters;
  /** "skip" or "fallback" */
  platform_policy: string;
  platform_fallback: string | null;
  platform_overrides: Record<string, string>;
  default_username: string | null;
  default_port: number;
  default_credential: CredentialSource | null;
  /** Accept self-signed/unverifiable TLS certs (home labs; off by default). */
  allow_invalid_certs: boolean;
}

export interface NetBoxConfigState {
  config: NetBoxConfig;
  has_token: boolean;
}

export interface NetBoxTestResult {
  version: string;
  device_count: number;
}

export interface SyncReport {
  fetched: number;
  no_primary_ip: number;
  skipped_platform: number;
  unmatched_platforms: string[];
}

/** Per-device credential/username overlay. Null = inherit source defaults. */
export interface DeviceOverlay {
  username: string | null;
  port: number | null;
  credential: CredentialSource | null;
  last_connected: string | null;
  notes: string | null;
}

export interface NetBoxDeviceEntry {
  netbox_id: number;
  name: string;
  address: string;
  platform: string;
  site: string | null;
  location: string | null;
  tags: string[];
  status: string;
  enabled: boolean;
  overlay: DeviceOverlay;
}

export interface NetBoxStatus {
  enabled: boolean;
  has_token: boolean;
  has_default_pw: boolean;
  last_synced: string | null;
  device_count: number;
}

export async function netboxGetConfig(): Promise<NetBoxConfigState> {
  return invoke<NetBoxConfigState>("netbox_get_config");
}

/** `defaultPassword` is stored in the OS keyring, never in config. Blank = unchanged. */
export async function netboxSaveConfig(
  config: NetBoxConfig,
  defaultPassword: string | null,
): Promise<NetBoxConfig> {
  return invoke<NetBoxConfig>("netbox_save_config", { config, defaultPassword });
}

export async function netboxSaveToken(token: string | null): Promise<void> {
  return invoke<void>("netbox_save_token", { token });
}

/** Test a URL + token without saving. Blank token falls back to the stored one. */
export async function netboxTestConnection(
  baseUrl: string,
  token: string | null,
  allowInvalidCerts: boolean,
): Promise<NetBoxTestResult> {
  return invoke<NetBoxTestResult>("netbox_test_connection", { baseUrl, token, allowInvalidCerts });
}

export async function netboxSync(): Promise<SyncReport> {
  return invoke<SyncReport>("netbox_sync");
}

export async function netboxGetDevices(): Promise<NetBoxDeviceEntry[]> {
  return invoke<NetBoxDeviceEntry[]>("netbox_get_devices");
}

export interface NetBoxChoice {
  slug: string;
  name: string;
}

export async function netboxGetSites(): Promise<NetBoxChoice[]> {
  return invoke<NetBoxChoice[]>("netbox_get_sites");
}

export async function netboxGetRoles(): Promise<NetBoxChoice[]> {
  return invoke<NetBoxChoice[]>("netbox_get_roles");
}

export async function netboxGetTags(): Promise<NetBoxChoice[]> {
  return invoke<NetBoxChoice[]>("netbox_get_tags");
}

export async function netboxSetDeviceEnabled(
  netboxId: number,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("netbox_set_device_enabled", { netboxId, enabled });
}

/** `password` is stored in the OS keyring under the device's host key. Blank = unchanged. */
export async function netboxSetDeviceOverlay(
  netboxId: number,
  overlay: DeviceOverlay,
  password: string | null,
): Promise<void> {
  return invoke<void>("netbox_set_device_overlay", { netboxId, overlay, password });
}

export async function netboxGetStatus(): Promise<NetBoxStatus> {
  return invoke<NetBoxStatus>("netbox_get_status");
}

// ─── Test Helpers (debug builds only) ───────────────────────────────

export async function testStartMockServer(): Promise<number> {
  return invoke<number>("test_mock_server");
}

export async function testStopMockServer(): Promise<void> {
  return invoke<void>("test_stop_mock_server");
}
