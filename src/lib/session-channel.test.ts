/**
 * Unit tests for SessionChannel — SSH lifecycle behind a pluggable transport.
 * Uses an in-memory bus (no Tauri, no DOM) to drive normalized events.
 */

import { describe, expect, it } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { SessionChannel, type SessionEvent, type SessionTransport } from "./session-channel";

class InMemoryTransport implements SessionTransport {
  connectedWith: number | null = null;
  disconnected: number[] = [];
  private handlers = new Map<string, ((p: unknown) => void)[]>();

  async connect(_hostId: string, _opts: { cols: number; rows: number }, sessionId: number): Promise<void> {
    this.connectedWith = sessionId;
  }

  async disconnect(sessionId: number): Promise<void> {
    this.disconnected.push(sessionId);
  }

  async listen(name: string, handler: (payload: unknown) => void): Promise<UnlistenFn> {
    const arr = this.handlers.get(name) ?? [];
    arr.push(handler);
    this.handlers.set(name, arr);
    return () => {
      const a = this.handlers.get(name);
      if (a) this.handlers.set(name, a.filter((h) => h !== handler));
    };
  }

  emit(name: string, payload: unknown): void {
    for (const h of this.handlers.get(name) ?? []) h(payload);
  }
}

function mk() {
  const transport = new InMemoryTransport();
  const channel = new SessionChannel(transport);
  const events: SessionEvent[] = [];
  channel.on((e) => events.push(e));
  return { transport, channel, events };
}

describe("SessionChannel", () => {
  it("transitions idle -> connecting on connect, connected on ssh-connected", async () => {
    const { transport, channel, events } = mk();
    expect(channel.state).toBe("idle");

    await channel.connect("h1", { cols: 80, rows: 24 });
    expect(channel.state).toBe("connecting");
    expect(transport.connectedWith).toBe(channel.sessionId);

    transport.emit("ssh-connected", { reason: "", session_id: channel.sessionId });
    expect(channel.state).toBe("connected");
    expect(events).toContainEqual({ type: "connected" });
  });

  it("decodes base64 output and tags the phase from current state", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });
    transport.emit("ssh-connected", { reason: "", session_id: channel.sessionId });

    // "hi" in base64
    transport.emit("ssh-output", { data: "aGk=", session_id: channel.sessionId });

    const out = events.find((e) => e.type === "output");
    expect(out).toBeDefined();
    if (out?.type !== "output") return;
    expect(Array.from(out.data)).toEqual([0x68, 0x69]);
    expect(out.phase).toBe("connected");
  });

  it("swallows ssh-disconnected after a clean user disconnect", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });
    transport.emit("ssh-connected", { reason: "", session_id: channel.sessionId });

    await channel.disconnect();
    expect(transport.disconnected).toEqual([channel.sessionId]);

    transport.emit("ssh-disconnected", { reason: "user", session_id: channel.sessionId });
    expect(events.some((e) => e.type === "disconnected")).toBe(false);
  });

  it("emits disconnected with wasConnected for an unexpected drop after connecting", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });
    transport.emit("ssh-connected", { reason: "", session_id: channel.sessionId });

    transport.emit("ssh-disconnected", { reason: "lost", session_id: channel.sessionId });
    expect(channel.state).toBe("disconnected");
    expect(events).toContainEqual({ type: "disconnected", reason: "lost", wasConnected: true });
  });

  it("ignores events with a stale session_id", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });

    const stale = (channel.sessionId ?? 0) - 1;
    transport.emit("ssh-connected", { reason: "", session_id: stale });
    transport.emit("ssh-output", { data: "aGk=", session_id: stale });
    transport.emit("ssh-disconnected", { reason: "lost", session_id: stale });
    transport.emit("ssh-error", { reason: "boom", session_id: stale });

    expect(channel.state).toBe("connecting");
    expect(events).toEqual([]);
  });

  it("treats ssh-disconnected before ever connected as connect-failed", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });

    transport.emit("ssh-disconnected", { reason: "channel_eof", session_id: channel.sessionId });
    expect(channel.state).toBe("error");
    expect(events).toContainEqual({ type: "connect-failed", reason: "channel_eof" });
    expect(events.some((e) => e.type === "disconnected")).toBe(false);
  });

  it("reconnect resets connectedAtLeastOnce: die-before-connected emits connect-failed, not silent disconnected", async () => {
    const { transport, channel, events } = mk();
    // First session: connects, then drops.
    await channel.connect("h1", { cols: 80, rows: 24 });
    transport.emit("ssh-connected", { reason: "", session_id: channel.sessionId });
    transport.emit("ssh-disconnected", { reason: "lost", session_id: channel.sessionId });
    expect(events).toContainEqual({ type: "disconnected", reason: "lost", wasConnected: true });

    // Reconnect: new session dies before ssh-connected.
    await channel.connect("h1", { cols: 80, rows: 24 });
    transport.emit("ssh-disconnected", { reason: "channel_eof", session_id: channel.sessionId });

    expect(channel.state).toBe("error");
    expect(events).toContainEqual({ type: "connect-failed", reason: "channel_eof" });
  });

  it("maps ssh-auth-interactive and ssh-auth-round to normalized events (issue #12)", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });

    transport.emit("ssh-auth-interactive", { reason: "password_prompt", session_id: channel.sessionId });
    expect(events).toContainEqual({ type: "auth-interactive" });

    const prompts = [{ prompt: "Password: ", echo: false }];
    transport.emit("ssh-auth-round", { session_id: channel.sessionId, prompts });
    expect(events).toContainEqual({ type: "auth-round", prompts });
  });

  it("ignores interactive-auth events with a stale session_id", async () => {
    const { transport, channel, events } = mk();
    await channel.connect("h1", { cols: 80, rows: 24 });

    const stale = (channel.sessionId ?? 0) - 1;
    transport.emit("ssh-auth-interactive", { reason: "password_prompt", session_id: stale });
    transport.emit("ssh-auth-round", { session_id: stale, prompts: [] });

    expect(
      events.filter((e) => e.type === "auth-interactive" || e.type === "auth-round"),
    ).toEqual([]);
  });
});
