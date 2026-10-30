import { describe, it, expect } from "vitest";
import { TerminalView } from "../src/components/terminal-view";

// Minimal host — only the fields the connect/disconnect path touches.
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
  const calls: { cb: string }[] = [];
  const view = new TerminalView(
    () => calls.push({ cb: "detach" }),
    () => calls.push({ cb: "disconnect" }),
    () => calls.push({ cb: "session-died" }),
    () => calls.push({ cb: "request-close" }),
  );
  const container = document.createElement("div");
  view.mount(container);
  return { view, calls, root: (view as unknown as { root: HTMLElement }).root };
}

type Channel = { sessionId: number | null; state: string; dispose(): void };
function channelOf(view: TerminalView): Channel {
  return (view as unknown as { channel: Channel }).channel;
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
    // Drive the real connect path: mints a session id + registers listeners.
    await view.connect(host);
    const ch = channelOf(view);

    // Simulate backend channel_eof arriving before ssh-connected ever fired.
    await emitTauri("ssh-disconnected", { reason: "channel_eof", session_id: ch.sessionId });
    await tick();

    // No bounce callbacks — the view stays put with an error overlay.
    expect(calls).toEqual([]);
    expect(ch.state).toBe("error");
    expect(root.querySelector(".tv-overlay-title")?.textContent).toBe("Connection Failed");

    ch.dispose();
  });

  it("still bounces after a real connection", async () => {
    const { view, calls, root } = makeView();
    // The bounce branch requires the terminal to be inside a visible .app-view.
    const wrapper = document.createElement("div");
    wrapper.className = "app-view";
    document.body.appendChild(wrapper);
    wrapper.appendChild(root);

    await view.connect(host);
    const ch = channelOf(view);

    // Establish a real connection, then drop it.
    await emitTauri("ssh-connected", { reason: "ok", session_id: ch.sessionId });
    await tick();
    await emitTauri("ssh-disconnected", { reason: "channel_closed", session_id: ch.sessionId });
    await tick();

    expect(calls).toContainEqual({ cb: "disconnect" });

    ch.dispose();
    wrapper.remove();
  });
});
