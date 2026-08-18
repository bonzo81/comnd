// Monotonic session id minting.
// ponytail: Date.now() collides when two hosts connect in the same ms,
// causing both tabs to share a session_id and display the same remote host.
// Module-level counter so ids never repeat across tabs within a session.
let next = 1;

export function mintSessionId(): number {
  return next++;
}

// Test only — reset counter between test cases.
export function __resetSessionId(): void {
  next = 1;
}
