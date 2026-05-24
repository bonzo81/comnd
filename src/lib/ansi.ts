/**
 * Strip ANSI escape sequences from text.
 *
 * Handles:
 * - **CSI** (Control Sequence Introducer): `ESC [` … letter
 *   e.g. `"\x1b[32mHello\x1b[0m"` → `"Hello"`
 * - **OSC** (Operating System Command): `ESC ]` … `BEL` or `ST`
 *   e.g. `"\x1b]0;title\x07text"` → `"text"`
 *
 * Not handled (documented limitation):
 * - DCS, SOS, PM, APC — rare in terminal output
 * - Single-character escape sequences (e.g. `ESC c`)
 *
 * This function focuses on ANSI stripping only and does NOT normalize
 * control characters (e.g. `\r\n`, null bytes).
 */
export function stripAnsi(text: string): string {
  // Strip OSC sequences first — they can contain embedded CSI-like bytes
  return (
    text
      // OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \)
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
      // CSI: ESC [ params… final byte
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
  );
}
