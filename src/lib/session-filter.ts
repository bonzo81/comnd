// Stale-event filter for SSH Tauri events.
// Each TerminalView keeps the session_id it minted before sshConnect;
// the backend echoes it back on every event. Without this filter,
// host2's ssh-connected event overwrites host1's view state and both
// tabs display host2's stream.
export function shouldAcceptEvent(
  eventSessionId: number,
  viewSessionId: number,
): boolean {
  return eventSessionId === viewSessionId;
}
