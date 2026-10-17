/**
 * SessionChannel — SSH session lifecycle behind a narrow interface.
 *
 * Owns: connect/disconnect/cancel, listener registration, session-ID minting
 * and correlation, the clean-disconnect guard, and connected-at-least-once
 * tracking. Emits normalized {@link SessionEvent}s; a view (or test) subscribes
 * via {@link SessionChannel.on}. Never touches the DOM.
 *
 * Transport is pluggable: {@link TauriTransport} for prod (real IPC + events),
 * an in-memory bus for tests.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sshConnect, sshDisconnect } from "./tauri-api";
import { mintSessionId } from "./session-id";
import { shouldAcceptEvent } from "./session-filter";

export type ChannelState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type SessionEvent =
  | { type: "output"; data: Uint8Array; phase: "connecting" | "connected" }
  | { type: "connected" }
  | { type: "disconnected"; reason: string; wasConnected: boolean }
  | { type: "connect-failed"; reason: string }
  | { type: "error"; reason: string }
  | { type: "tofu"; reason: string }
  | { type: "tofu-pending"; hostKey: string; fingerprint: string; keyType: string }
  | { type: "auth-url"; url: string }
  | { type: "auth-interactive" }
  | { type: "auth-round"; prompts: { prompt: string; echo: boolean }[] };

/** Abstraction over the SSH IPC + event stream. Prod = Tauri; tests = in-memory. */
export interface SessionTransport {
  connect(hostId: string, opts: { cols: number; rows: number }, sessionId: number): Promise<void>;
  disconnect(sessionId: number): Promise<void>;
  listen(name: string, handler: (payload: unknown) => void): Promise<UnlistenFn>;
}

export class TauriTransport implements SessionTransport {
  async connect(hostId: string, opts: { cols: number; rows: number }, sessionId: number): Promise<void> {
    await sshConnect({ hostId, cols: opts.cols, rows: opts.rows, sessionId });
  }

  async disconnect(sessionId: number): Promise<void> {
    await sshDisconnect(sessionId);
  }

  listen(name: string, handler: (payload: unknown) => void): Promise<UnlistenFn> {
    return listen<unknown>(name, (event) => handler(event.payload));
  }
}

export class SessionChannel {
  private _state: ChannelState = "idle";
  private _sessionId: number | null = null;
  private cleanDisconnect = false;
  private connectedAtLeastOnce = false;
  private unlisteners: UnlistenFn[] = [];
  private listeners: ((e: SessionEvent) => void)[] = [];

  constructor(private readonly transport: SessionTransport) {}

  get state(): ChannelState {
    return this._state;
  }

  get sessionId(): number | null {
    return this._sessionId;
  }

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  on(cb: (e: SessionEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(e: SessionEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  /**
   * Mint a session ID, register listeners, and open the SSH connection.
   * Idempotent — drops any prior listeners first so reconnect is safe.
   * Sets state to "error" and rethrows if the connect IPC fails.
   */
  async connect(hostId: string, opts: { cols: number; rows: number }): Promise<void> {
    this.unlistenAll();

    this._state = "connecting";
    this.cleanDisconnect = false;
    this.connectedAtLeastOnce = false;
    const sid = mintSessionId();
    this._sessionId = sid;

    await this.registerListeners(sid);

    try {
      await this.transport.connect(hostId, opts, sid);
    } catch (err) {
      this._state = "error";
      throw err;
    }
  }

  /** User-initiated disconnect. Marks the session clean so the resulting
   *  ssh-disconnected event is swallowed by the channel (view handles teardown). */
  async disconnect(): Promise<void> {
    this.cleanDisconnect = true;
    if (this._sessionId != null) {
      try {
        await this.transport.disconnect(this._sessionId);
      } catch {
        // already gone
      }
    }
  }

  /** Full teardown: drop listeners and reset state. Does NOT call transport.disconnect. */
  dispose(): void {
    this.unlistenAll();
    this.listeners = [];
    this._sessionId = null;
    this.cleanDisconnect = false;
    this.connectedAtLeastOnce = false;
    this._state = "idle";
  }

  private unlistenAll(): void {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
  }

  private base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private async registerListeners(sid: number): Promise<void> {
    this.unlisteners.push(
      await this.transport.listen("ssh-output", (raw) => {
        const p = raw as { data: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        const bytes = this.base64ToBytes(p.data);
        this.emit({ type: "output", data: bytes, phase: this._state === "connected" ? "connected" : "connecting" });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-connected", (raw) => {
        const p = raw as { reason: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.cleanDisconnect = false;
        this.connectedAtLeastOnce = true;
        this._state = "connected";
        this.emit({ type: "connected" });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-disconnected", (raw) => {
        const p = raw as { reason: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        // User-initiated — the view drives teardown itself.
        if (this.cleanDisconnect) return;
        if (!this.connectedAtLeastOnce) {
          this._state = "error";
          this.emit({ type: "connect-failed", reason: p.reason });
          return;
        }
        const wasConnected = this._state === "connected";
        this._state = "disconnected";
        this.emit({ type: "disconnected", reason: p.reason, wasConnected });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-error", (raw) => {
        const p = raw as { reason: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this._state = "error";
        this.emit({ type: "error", reason: p.reason });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-tofu", (raw) => {
        const p = raw as { reason: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.emit({ type: "tofu", reason: p.reason });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-tofu-pending", (raw) => {
        const p = raw as { host_key: string; fingerprint: string; key_type: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.emit({ type: "tofu-pending", hostKey: p.host_key, fingerprint: p.fingerprint, keyType: p.key_type });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-auth-url", (raw) => {
        const p = raw as { url: string; session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.emit({ type: "auth-url", url: p.url });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-auth-interactive", (raw) => {
        const p = raw as { session_id: number };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.emit({ type: "auth-interactive" });
      }),
    );

    this.unlisteners.push(
      await this.transport.listen("ssh-auth-round", (raw) => {
        const p = raw as { session_id: number; prompts: { prompt: string; echo: boolean }[] };
        if (!shouldAcceptEvent(p.session_id, sid)) return;
        this.emit({ type: "auth-round", prompts: p.prompts });
      }),
    );
  }
}
