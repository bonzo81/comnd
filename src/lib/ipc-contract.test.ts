/**
 * IPC contract: every wrapper in src/lib/tauri-api.ts must invoke the command
 * name the Rust side registers, with the argument names the command's struct
 * deserializes. A typo in either half fails at runtime only — nothing else in
 * the suite covers the mapping.
 *
 * The table is checked against the generate_handler![...] list in
 * src-tauri/src/lib.rs, so a wrapper whose command was renamed or removed on
 * the Rust side fails here instead of in the app.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "../../tests/harness";
import * as api from "./tauri-api";
import type { NetBoxConfig, ReplayCommand } from "./tauri-api";

interface WrapperCase {
  /** Exported wrapper name — the test title. */
  name: string;
  /** Command string the wrapper must send. */
  cmd: string;
  run: () => Promise<unknown>;
  /** Exact invoke args. Omitted only when the wrapper takes no arguments. */
  args?: Record<string, unknown>;
}

const replayCmd: ReplayCommand = {
  id: "r-1",
  command: "show interface {{intf}}",
  variables: [{ name: "intf" }],
  platform: "cisco-iosxe",
  created_at: "2026-01-01T00:00:00.000Z",
};

const netboxConfig: NetBoxConfig = {
  enabled: false,
  show_empty_folders: false,
  base_url: "",
  filters: { status: null, sites: [], roles: [], tags: [] },
  platform_policy: "skip",
  platform_fallback: null,
  platform_overrides: {},
  default_username: null,
  default_port: 22,
  default_credential: null,
  allow_invalid_certs: false,
};

const overlay = {
  username: null,
  port: null,
  credential: null,
  last_connected: null,
  notes: null,
};

const cases: WrapperCase[] = [
  // KB
  { name: "queryKb", cmd: "query_kb", run: () => api.queryKb("linux-bash"), args: { platform: "linux-bash" } },
  {
    name: "loadPlatformIndex",
    cmd: "load_platform_index",
    run: () => api.loadPlatformIndex("linux-bash"),
    args: { platform: "linux-bash" },
  },
  { name: "validateKb", cmd: "validate_kb", run: () => api.validateKb("linux-bash"), args: { platform: "linux-bash" } },
  // Hosts
  { name: "getHosts", cmd: "get_hosts", run: () => api.getHosts() },
  { name: "saveHost", cmd: "save_host", run: () => api.saveHost({ id: "h-1" }), args: { host: { id: "h-1" } } },
  { name: "deleteHost", cmd: "delete_host", run: () => api.deleteHost("h-1"), args: { id: "h-1" } },
  { name: "touchHost", cmd: "touch_host", run: () => api.touchHost("h-1"), args: { id: "h-1" } },
  // Host groups
  { name: "getHostGroups", cmd: "get_host_groups", run: () => api.getHostGroups() },
  {
    name: "saveHostGroup",
    cmd: "save_host_group",
    run: () => api.saveHostGroup(null, "Core", "g-1", "#fff", "star"),
    args: { id: null, name: "Core", parentId: "g-1", color: "#fff", icon: "star" },
  },
  {
    name: "moveHostGroup",
    cmd: "move_host_group",
    run: () => api.moveHostGroup("g-2", "g-1", 3),
    args: { id: "g-2", newParent: "g-1", sortOrder: 3 },
  },
  { name: "deleteHostGroup", cmd: "delete_host_group", run: () => api.deleteHostGroup("g-2"), args: { id: "g-2" } },
  // Credentials
  {
    name: "saveCredential",
    cmd: "save_credential",
    run: () => api.saveCredential("h-1", "placeholder"),
    args: { hostId: "h-1", password: "placeholder" },
  },
  { name: "hasCredential", cmd: "has_credential", run: () => api.hasCredential("h-1"), args: { hostId: "h-1" } },
  // Secret providers
  { name: "listProviders", cmd: "list_providers", run: () => api.listProviders() },
  { name: "testRef", cmd: "test_ref", run: () => api.testRef("proton", "ref-1"), args: { provider: "proton", reference: "ref-1" } },
  { name: "listCredentials", cmd: "list_credentials", run: () => api.listCredentials("proton"), args: { provider: "proton" } },
  { name: "getProviderState", cmd: "get_provider_state", run: () => api.getProviderState("proton"), args: { provider: "proton" } },
  {
    name: "saveProviderConfig",
    cmd: "save_provider_config",
    run: () => api.saveProviderConfig("proton", { vault: "Personal" }),
    args: { provider: "proton", config: { vault: "Personal" } },
  },
  {
    name: "saveProviderSecret",
    cmd: "save_provider_secret",
    run: () => api.saveProviderSecret("proton", null),
    args: { provider: "proton", secret: null },
  },
  { name: "agentListIdentities", cmd: "agent_list_identities", run: () => api.agentListIdentities() },
  // SSH
  {
    name: "sshConnect",
    cmd: "ssh_connect",
    run: () => api.sshConnect({ hostId: "h-1", cols: 80, rows: 24, sessionId: 7 }),
    args: { hostId: "h-1", cols: 80, rows: 24, sessionId: 7 },
  },
  { name: "sshSend", cmd: "ssh_send", run: () => api.sshSend(7, "show ver"), args: { sessionId: 7, data: "show ver" } },
  { name: "sshDisconnect", cmd: "ssh_disconnect", run: () => api.sshDisconnect(7), args: { sessionId: 7 } },
  {
    name: "sshAuthRespond",
    cmd: "ssh_auth_respond",
    run: () => api.sshAuthRespond(7, ["answer"]),
    args: { sessionId: 7, responses: ["answer"] },
  },
  { name: "sshResize", cmd: "ssh_resize", run: () => api.sshResize(7, 100, 40), args: { sessionId: 7, cols: 100, rows: 40 } },
  { name: "tofuRespond", cmd: "tofu_respond", run: () => api.tofuRespond(7, true), args: { sessionId: 7, accept: true } },
  { name: "openUrl", cmd: "open_url_cmd", run: () => api.openUrl("https://example.test"), args: { url: "https://example.test" } },
  // Config
  { name: "getAppConfig", cmd: "get_app_config", run: () => api.getAppConfig() },
  { name: "getLogLevel", cmd: "get_log_level", run: () => api.getLogLevel() },
  { name: "setLogLevel", cmd: "set_log_level", run: () => api.setLogLevel("debug"), args: { level: "debug" } },
  { name: "setLogMaxSize", cmd: "set_log_max_size", run: () => api.setLogMaxSize(12), args: { maxMb: 12 } },
  { name: "setMaxSessions", cmd: "set_max_sessions", run: () => api.setMaxSessions(4), args: { max: 4 } },
  {
    name: "setDuplicateSessionPolicy",
    cmd: "set_duplicate_session_policy",
    run: () => api.setDuplicateSessionPolicy("focus"),
    args: { policy: "focus" },
  },
  {
    name: "setShortcutOverrides",
    cmd: "set_shortcuts",
    run: () => api.setShortcutOverrides({ "palette.open": "Ctrl+K" }),
    args: { overrides: { "palette.open": "Ctrl+K" } },
  },
  { name: "getSessionLogDir", cmd: "get_session_log_dir", run: () => api.getSessionLogDir() },
  {
    name: "setSessionLogging",
    cmd: "set_session_logging",
    run: () => api.setSessionLogging(true),
    args: { enabled: true },
  },
  {
    name: "setSessionLogTimestamps",
    cmd: "set_session_log_timestamps",
    run: () => api.setSessionLogTimestamps(false),
    args: { enabled: false },
  },
  { name: "setSessionLogDir", cmd: "set_session_log_dir", run: () => api.setSessionLogDir(null), args: { dir: null } },
  { name: "setLogFilePath", cmd: "set_log_file_path", run: () => api.setLogFilePath(null), args: { path: null } },
  { name: "getLogStatus", cmd: "get_log_status", run: () => api.getLogStatus() },
  {
    name: "logFrontend",
    cmd: "log_frontend",
    run: () => api.logFrontend("info", "TerminalView", "mounted", ""),
    args: { level: "info", tag: "TerminalView", msg: "mounted", args: "" },
  },
  {
    name: "saveLlmSettings",
    cmd: "save_llm_settings",
    run: () => api.saveLlmSettings("openai", "http://llm.test", "m1", null, 8192),
    args: { apiFormat: "openai", baseUrl: "http://llm.test", model: "m1", apiKey: null, contextLength: 8192 },
  },
  // Backup / restore
  { name: "exportData", cmd: "export_data", run: () => api.exportData("out.zip"), args: { destPath: "out.zip" } },
  { name: "importData", cmd: "import_data", run: () => api.importData("in.zip"), args: { srcPath: "in.zip" } },
  { name: "scanMerge", cmd: "scan_merge", run: () => api.scanMerge("in.zip"), args: { srcPath: "in.zip" } },
  {
    name: "applyMerge",
    cmd: "apply_merge",
    run: () => api.applyMerge("tmp-1", { "hosts.yaml": "use_backup" }),
    args: { tempDir: "tmp-1", resolutions: { "hosts.yaml": "use_backup" } },
  },
  { name: "restartApp", cmd: "restart_app", run: () => api.restartApp() },
  // KB import
  {
    name: "extractKbPreview",
    cmd: "extract_kb_preview",
    run: () => api.extractKbPreview("http://kb.test", "cisco-iosxe", "routing"),
    args: { url: "http://kb.test", platform: "cisco-iosxe", category: "routing", platformName: null },
  },
  {
    name: "extractKbPreviewFromText",
    cmd: "extract_kb_preview_from_text",
    run: () => api.extractKbPreviewFromText("page text", "http://kb.test", "cisco-iosxe", "routing", "IOS-XE"),
    args: {
      text: "page text",
      sourceUrl: "http://kb.test",
      platform: "cisco-iosxe",
      category: "routing",
      platformName: "IOS-XE",
    },
  },
  {
    name: "commitKbImport",
    cmd: "commit_kb_import",
    run: () => api.commitKbImport([], "cisco-iosxe", "routing"),
    args: { previews: [], platform: "cisco-iosxe", category: "routing", platformName: null },
  },
  { name: "testLlmConnection", cmd: "test_llm_connection", run: () => api.testLlmConnection() },
  { name: "listKbPlatforms", cmd: "list_kb_platforms", run: () => api.listKbPlatforms() },
  {
    name: "getAllKbCommands",
    cmd: "get_all_kb_commands",
    run: () => api.getAllKbCommands("linux-bash"),
    args: { platform: "linux-bash" },
  },
  {
    name: "saveKbCommand",
    cmd: "save_kb_command",
    run: () => api.saveKbCommand("linux-bash", "file", "ls", "ls [path]", "list", "bash", ["l"], ["files"]),
    args: {
      platform: "linux-bash",
      category: "file",
      name: "ls",
      syntax: "ls [path]",
      description: "list",
      mode: "bash",
      aliases: ["l"],
      tags: ["files"],
      tokensJson: null,
      order: null,
      negatable: null,
    },
  },
  {
    name: "deleteKbCommand",
    cmd: "delete_kb_command",
    run: () => api.deleteKbCommand("linux-bash", "file", "ls", true),
    args: { platform: "linux-bash", category: "file", commandName: "ls", overrides: true },
  },
  {
    name: "disableKbCommand",
    cmd: "disable_kb_command",
    run: () => api.disableKbCommand("linux-bash", "ls"),
    args: { platform: "linux-bash", commandName: "ls" },
  },
  {
    name: "enableKbCommand",
    cmd: "enable_kb_command",
    run: () => api.enableKbCommand("linux-bash", "ls"),
    args: { platform: "linux-bash", commandName: "ls" },
  },
  {
    name: "getDisabledCommands",
    cmd: "get_disabled_commands",
    run: () => api.getDisabledCommands("linux-bash"),
    args: { platform: "linux-bash" },
  },
  // Replay
  { name: "replayList", cmd: "replay_list", run: () => api.replayList() },
  { name: "replaySave", cmd: "replay_save", run: () => api.replaySave(replayCmd), args: { cmd: replayCmd } },
  { name: "replayDelete", cmd: "replay_delete", run: () => api.replayDelete("r-1"), args: { id: "r-1" } },
  // NetBox
  { name: "netboxGetConfig", cmd: "netbox_get_config", run: () => api.netboxGetConfig() },
  {
    name: "netboxSaveConfig",
    cmd: "netbox_save_config",
    run: () => api.netboxSaveConfig(netboxConfig, null),
    args: { config: netboxConfig, defaultPassword: null },
  },
  { name: "netboxSaveToken", cmd: "netbox_save_token", run: () => api.netboxSaveToken(null), args: { token: null } },
  {
    name: "netboxTestConnection",
    cmd: "netbox_test_connection",
    run: () => api.netboxTestConnection("http://nb.test", null, true),
    args: { baseUrl: "http://nb.test", token: null, allowInvalidCerts: true },
  },
  { name: "netboxSync", cmd: "netbox_sync", run: () => api.netboxSync() },
  { name: "netboxGetDevices", cmd: "netbox_get_devices", run: () => api.netboxGetDevices() },
  { name: "netboxGetSites", cmd: "netbox_get_sites", run: () => api.netboxGetSites() },
  { name: "netboxGetRoles", cmd: "netbox_get_roles", run: () => api.netboxGetRoles() },
  { name: "netboxGetTags", cmd: "netbox_get_tags", run: () => api.netboxGetTags() },
  {
    name: "netboxSetDeviceEnabled",
    cmd: "netbox_set_device_enabled",
    run: () => api.netboxSetDeviceEnabled(5, false),
    args: { netboxId: 5, enabled: false },
  },
  {
    name: "netboxSetDeviceOverlay",
    cmd: "netbox_set_device_overlay",
    run: () => api.netboxSetDeviceOverlay(5, overlay, null),
    args: { netboxId: 5, overlay, password: null },
  },
  { name: "netboxGetStatus", cmd: "netbox_get_status", run: () => api.netboxGetStatus() },
  // Debug-build helpers
  { name: "testStartMockServer", cmd: "test_mock_server", run: () => api.testStartMockServer() },
  { name: "testStopMockServer", cmd: "test_stop_mock_server", run: () => api.testStopMockServer() },
];

const SENTINEL = { ok: "sentinel" };

describe("tauri-api wrapper contract", () => {
  it("covers every wrapper, with no duplicate command names", () => {
    // Tripwire: add a row when you add a wrapper.
    expect(cases).toHaveLength(75);
    const cmds = cases.map((c) => c.cmd);
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  it.each(cases)("$name sends $cmd and returns the IPC result", async (c) => {
    const h = createHarness();
    h.ipc.mock(c.cmd, SENTINEL);

    await expect(c.run()).resolves.toBe(SENTINEL);

    const calls = h.ipc.calls(c.cmd);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(c.args ?? {});
  });

  it("sends only command names the Rust side registers", () => {
    // Vitest runs from the repo root; import.meta.url is an http URL under jsdom.
    const src = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const start = src.indexOf("generate_handler![");
    expect(start).toBeGreaterThan(-1);
    // The file may use CRLF; the block closes on a line holding only `]`.
    const rest = src.slice(start);
    const endMatch = /[\r\n]\s*\]/.exec(rest);
    expect(endMatch).not.toBeNull();

    const registered = new Set(
      rest
        .slice(0, endMatch?.index ?? rest.length)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"))
        .map((line) => line.replace(/,$/, "").split("::").pop() ?? ""),
    );

    expect(cases.filter((c) => !registered.has(c.cmd)).map((c) => `${c.name} -> ${c.cmd}`)).toEqual([]);
  });
});

describe("tauri-api optional-argument defaults", () => {
  it("passes an explicit platformName through instead of nulling it", async () => {
    const h = createHarness();
    h.ipc.mock("extract_kb_preview", SENTINEL);

    await api.extractKbPreview("http://kb.test", "cisco-iosxe", "routing", "IOS-XE");

    expect(h.ipc.calls("extract_kb_preview")[0].args.platformName).toBe("IOS-XE");
  });

  it("sends an empty sourceUrl as null, not an empty string", async () => {
    const h = createHarness();
    h.ipc.mock("extract_kb_preview_from_text", SENTINEL);

    await api.extractKbPreviewFromText("page text", "", "cisco-iosxe", "routing");

    expect(h.ipc.calls("extract_kb_preview_from_text")[0].args.sourceUrl).toBeNull();
  });

  it("passes optional KB command fields through when they are supplied", async () => {
    const h = createHarness();
    h.ipc.mock("save_kb_command", SENTINEL);

    await api.saveKbCommand(
      "linux-bash",
      "file",
      "ls",
      "ls [path]",
      "list",
      "bash",
      [],
      [],
      "[]",
      "fixed",
      true,
    );

    expect(h.ipc.calls("save_kb_command")[0].args).toMatchObject({
      tokensJson: "[]",
      order: "fixed",
      negatable: true,
    });
  });
});
