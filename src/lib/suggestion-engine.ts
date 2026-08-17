/**
 * Suggestion Engine — queries KB for matching commands
 * Frontend-side matching against in-memory KB (loaded from Rust backend)
 */

import type { Command } from "./tauri-api";

export type { Command };

export interface SuggestionResult {
  command: Command;
  matchType: "name" | "alias";
  matchedText: string;
}

export class SuggestionEngine {
  private commands: Command[] = [];
  private _platform: string = "";
  private _version: string = "";
  private mode: string = "";

  /** Load commands for a platform (called on connect) */
  loadCommands(commands: Command[], platform: string) {
    this.commands = commands;
    this._platform = platform;
  }

  /** Set current version filter */
  setVersion(version: string) {
    this._version = version;
  }

  /** Update current mode (from prompt detection) */
  setMode(mode: string) {
    this.mode = mode;
  }

  /** Query for matching commands based on input buffer */
  query(input: string): SuggestionResult[] {
    const lowerInput = input.toLowerCase().trim();
    const results: SuggestionResult[] = [];

    for (const cmd of this.commands) {
      // Filter by mode if set
      if (this.mode && cmd.mode !== this.mode) continue;

      // Empty input: return all commands for current mode
      if (!lowerInput) {
        results.push({ command: cmd, matchType: "name", matchedText: cmd.name });
        continue;
      }

      // Check name prefix match
      if (cmd.name.toLowerCase().startsWith(lowerInput)) {
        results.push({ command: cmd, matchType: "name", matchedText: cmd.name });
        continue;
      }

      // Check alias prefix match
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(lowerInput)) {
          results.push({ command: cmd, matchType: "alias", matchedText: alias });
          break;
        }
      }
    }

    // Sort: name matches first, then alias matches
    results.sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType === "name" ? -1 : 1;
      return a.command.name.localeCompare(b.command.name);
    });

    return results;
  }

  /** Get the top suggestion (for ghost text) */
  topMatch(input: string): SuggestionResult | null {
    const results = this.query(input);
    return results.length > 0 ? results[0] : null;
  }
}
