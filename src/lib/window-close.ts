/**
 * Window-close confirmation — decides whether quitting the app must ask first.
 *
 * Pure logic only; the dialog and the window calls live in main.ts. "Live"
 * means the same thing the session limit means (`duplicate-session.ts`):
 * connecting or connected. A failed attempt keeps its tab open for Retry but
 * holds no SSH session, so it must not make quitting ask.
 */

import { countLiveSessions, type SessionLifecycle } from "./duplicate-session";

export interface WindowClosePrompt {
  /** Sessions that quitting would terminate. */
  sessionCount: number;
  title: string;
  message: string;
  confirmLabel: string;
}

/** The prompt a window close must show, or null when the close is silent. */
export function describeWindowClose(
  states: Iterable<SessionLifecycle>,
): WindowClosePrompt | null {
  const sessionCount = countLiveSessions(states);
  if (sessionCount === 0) return null;
  return {
    sessionCount,
    title: "Close Comnd?",
    message:
      sessionCount === 1
        ? "1 SSH session will be terminated."
        : `${sessionCount} SSH sessions will be terminated.`,
    confirmLabel: "Close Comnd",
  };
}
