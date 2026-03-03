//! SSH connection management via russh
//! 
//! Handles: connection lifecycle, authentication (password + keyboard-interactive),
//! host key verification (TOFU), PTY allocation, and data streaming.

// TODO: Implement SSH session manager
// - Connection pool (one per host)
// - Auth flow: try configured method, handle keyboard-interactive
// - Known hosts (TOFU model, JSON in app data dir)
// - PTY resize on window change
// - Keepalive heartbeats
// - Read timeout for disconnect detection
