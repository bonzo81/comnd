/**
 * Duplicate-session policy — what to do when the user connects to a host that
 * already has a live session.
 *
 * Pure logic only; the dialog and IPC live elsewhere. `maxSessions === 0`
 * means unlimited, matching the backend check in `ssh.rs`.
 */

export type DuplicateSessionPolicy = "ask" | "allow" | "focus";

/** Action the app should take for a connect to an already-connected host. */
export type DuplicateSessionAction =
  /** Ask the user (normal dialog). */
  | "prompt"
  /** Ask, but the session limit leaves only "go to existing"/"cancel". */
  | "prompt-limit"
  /** Open an independent second session without asking. */
  | "new"
  /** Activate the session that is already running. */
  | "focus";

export const DUPLICATE_SESSION_POLICIES: readonly DuplicateSessionPolicy[] = [
  "ask",
  "allow",
  "focus",
];

/** Coerce an unknown/missing stored value to the safe default. */
export function normalizeDuplicateSessionPolicy(
  raw: string | null | undefined,
): DuplicateSessionPolicy {
  return raw === "allow" || raw === "focus" ? raw : "ask";
}

/** True when another session cannot be opened. `0` = unlimited. */
export function isAtSessionLimit(openSessions: number, maxSessions: number): boolean {
  return maxSessions > 0 && openSessions >= maxSessions;
}

/** Connection status of a session view, as far as the limit is concerned. */
export type SessionLifecycle = "connecting" | "connected" | "disconnected" | "error";

/**
 * Sessions that occupy a backend slot. A failed attempt keeps its tab open so
 * the user can retry, but holds no SSH session, so it must not consume the
 * limit — the backend counts only live sessions (`mgr.session_count()`).
 */
export function countLiveSessions(states: Iterable<SessionLifecycle>): number {
  let live = 0;
  for (const state of states) {
    if (state === "connecting" || state === "connected") live += 1;
  }
  return live;
}

export function resolveDuplicateSessionAction(input: {
  policy: DuplicateSessionPolicy;
  atLimit: boolean;
}): DuplicateSessionAction {
  if (input.atLimit) {
    // Never promise a second session the backend would refuse.
    return input.policy === "focus" ? "focus" : "prompt-limit";
  }
  if (input.policy === "allow") return "new";
  if (input.policy === "focus") return "focus";
  return "prompt";
}
