import { describe, it, expect, beforeEach } from "vitest";
import { TerminalView } from "../src/components/terminal-view";

// Minimal host — only the fields the disconnect path touches.
const host = {
  id: "h1",
  hostname: "10.0.0.1",
  port: 22,
  username: "admin",
  display_name: "Test",
  platform: "linux-bash",
  auth_type: "password",
} as never;

function makeView() {
  const calls: { cb: string; hostId: string }[] = [];
  const view = new TerminalView(
    () => calls.push({ cb: "detach", hostId: "" }),
    (hostId) => calls.push({ cb: "disconnect", hostId }),
    (hostId) => calls.push({ cb: "session-died", hostId }),
    () => calls.push({ cb: "request-close", hostId: "" }),
  );
  const container = document.createElement("div");
  view.mount(container);
  return { view, calls, root: (view as unknown as { root: HTMLElement }).root };
}

/** Emit an event through the mocked Tauri IPC bus (see tests/setup.ts). */
async function emitTauri(event: string, payload: unknown) {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}

function tick() {
  return new Promise((r) => setTimeout(r, 20));
}

describe("ssh-disconnected before ever connected", () => {
  it("does not bounce to host list; shows error instead", async () => {
    const { view, calls, root } = makeView();
    const v = view as unknown as Record<string, unknown>;
    v.host = host;
    v.state = "connecting";
    v.sessionId = 1;
    v.connectedAtLeastOnce = false;

    await (view as unknown as { registerSshListeners: () => Promise<void> }).registerSshListeners();

    // Simulate backend channel_eof arriving while still "connecting"
    await emitTauri("ssh-disconnected", { reason: "channel_eof", session_id: 1 });
    await tick();

    // No bounce callbacks fired — the view stays put with an error overlay
    expect(calls).toEqual([]);
    expect(v.state).toBe("error");
    expect(root.querySelector(".tv-overlay-title")?.textContent).toBe("Connection Failed");

    (view as unknown as { unregisterSshListeners: () => void }).unregisterSshListeners();
  });

  it("still bounces after a real connection", async () => {
    const { view, calls } = makeView();
    const v = view as unknown as Record<string, unknown>;
    v.host = host;
    v.sessionId = 2;
    v.connectedAtLeastOnce = true;
    v.state = "connected";
    // Wrapper must be visible for the "user is looking" branch
    const wrapper = document.createElement("div");
    wrapper.className = "app-view";
    document.body.appendChild(wrapper);
    const termEl = (view as unknown as { root: HTMLElement }).root;
    wrapper.appendChild(termEl);
    (view as unknown as { terminal: { element: HTMLElement } }).terminal = {
      element: termEl,
    } as never;

    await (view as unknown as { registerSshListeners: () => Promise<void> }).registerSshListeners();

    await emitTauri("ssh-disconnected", { reason: "channel_closed", session_id: 2 });
    await tick();

    expect(calls).toContainEqual({ cb: "disconnect", hostId: "h1" });

    (view as unknown as { unregisterSshListeners: () => void }).unregisterSshListeners();
    wrapper.remove();
  });
});
