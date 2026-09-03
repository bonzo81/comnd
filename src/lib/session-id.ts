// Monotonic session id minting.
// Starts at Date.now() so ids never collide with stale backend sessions
// that survive frontend HMR reloads (backend stays alive, counter used to
// reset to 1, causing insert_session to overwrite the old session whose
// death event then poisoned the new view).
let next = Date.now();

export function mintSessionId(): number {
  return next++;
}

// Test only — reset counter between test cases.
export function __resetSessionId(): void {
  next = Date.now();
}
