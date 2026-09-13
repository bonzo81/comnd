/**
 * Suggestion Engine — queries KB for matching commands
 * Frontend-side matching against in-memory KB (loaded from Rust backend)
 *
 * Phase 2: token-aware positional matching. Commands with `tokens` use
 * `matchTokens` (knows the user's position within the command's syntax).
 * Commands without `tokens` fall back to legacy `name.startsWith` matching.
 * See docs/plans/plan-kb-token-engine.md § 2.
 */

import type { Command, CommandToken, CommandOrder } from "./tauri-api";
import { isLit, isChoice, isVar, isPipe } from "./tokens";

export type { Command };

// ─── Token match result ──────────────────────────────────────────────

export interface TokenMatch {
  /** index into cmd.tokens of the token the user is currently filling */
  currentTokenIndex: number;
  /** text already typed within the current token (may be "") */
  currentTokenInput: string;
  /** indices of cmd.tokens fully satisfied by the input so far */
  consumedTokens: number[];
  /** remaining tokens (for ghost text / dropdown rendering in Phase 3) */
  remainingTokens: CommandToken[];
  /** word index within a multi-word lit (0 = at start of lit) */
  litWordIndex: number;
  /** true if the negation prefix was stripped from the input */
  negated: boolean;
}

export interface SuggestionResult {
  command: Command;
  matchType: "token" | "name" | "alias";
  matchedText: string;
  tokenMatch?: TokenMatch | null;
  /** Prefix command stripped from the input ("sudo", "tmsh"), if any. */
  prefix?: string;
}

// ─── Ghost payload derivation (Phase 3) ─────────────────────────────

import type { GhostPayload } from "./ghost-text";

/**
 * Derive the ghost-text payload for a token match. Returns null if the
 * current position has nothing to render (e.g. input past all tokens).
 * See docs/plans/plan-kb-token-engine.md § 3.3.
 */
export function ghostPayloadFor(tm: TokenMatch, cmd: Command): GhostPayload | null {
  const toks = cmd.tokens;
  if (!toks) return null;
  const tok = toks[tm.currentTokenIndex];
  if (!tok) return null;

  if (isLit(tok)) {
    // Complete the lit from the current word index. `currentTokenInput` may
    // span multiple already-typed words; we only return the remainder of
    // the current word (ghost text is a single visual completion).
    const words = splitLit(tok.lit);
    if (tm.litWordIndex >= words.length) return null;
    const word = words[tm.litWordIndex];
    const input = tm.currentTokenInput.toLowerCase();
    if (input && word.toLowerCase().startsWith(input)) {
      return { kind: "literal", text: word.substring(input.length) };
    }
    if (!input) {
      // At start of a multi-word lit, ghost the rest of the lit words too.
      // The next words are appended so a single Tab completes the whole lit.
      const rest = words.slice(tm.litWordIndex).join(" ");
      return { kind: "literal", text: rest };
    }
    return { kind: "literal", text: word };
  }
  if (isChoice(tok)) {
    const c = tm.currentTokenInput.toLowerCase();
    const pick =
      tok.choice.find((opt) => opt.toLowerCase().startsWith(c)) ?? tok.choice[0] ?? "";
    // Ghost the remainder of the pick, merging with what's already typed —
    // a fully-typed option ghosts nothing (no "addraddr").
    const rem = pick.toLowerCase().startsWith(c) && c
      ? pick.substring(tm.currentTokenInput.length)
      : pick;
    if (!rem) return null;
    return { kind: "choice", options: tok.choice, pick: rem };
  }
  if (isVar(tok)) {
    return {
      kind: "variable",
      placeholder: tok.var,
      hint: tok.type === "numeric" ? "numeric"
        : tok.source === "device" ? "enumerable"
        : tok.type,
    };
  }
  if (isPipe(tok)) {
    const filters = tok.filters ?? [];
    const c = tm.currentTokenInput.toLowerCase();
    const match = filters.find((f) => f.lit.toLowerCase().startsWith(c))?.lit ?? filters[0]?.lit ?? "";
    const rem = c && match.toLowerCase().startsWith(c)
      ? match.substring(tm.currentTokenInput.length)
      : match;
    if (!rem) return null;
    return { kind: "choice", options: filters.map((f) => f.lit), pick: rem };
  }
  return null;
}

// ─── Token helpers ────────────────────────────────────────────────────

function splitLit(lit: string): string[] {
  return lit.trim().split(/\s+/).filter((w) => w.length > 0);
}

function isNumeric(s: string): boolean {
  return s.length > 0 && /^\d+$/.test(s);
}

// ─── Matching primitives ─────────────────────────────────────────────

/**
 * Does a COMPLETED user word (followed by space, fully typed) satisfy a
 * cmd token? Used for the positional walk past completed tokens.
 */
function completedWordMatchesToken(word: string, tok: CommandToken, isFirstLit: boolean): boolean {
  const w = word.toLowerCase();
  if (isLit(tok)) {
    // Completed words must match lit words exactly (case-insensitive), except
    // the first lit allows word-prefix (alias-style: sh→show, int→interface).
    const words = splitLit(tok.lit);
    if (isFirstLit) {
      return words.some((lw) => lw.toLowerCase().startsWith(w) || w.startsWith(lw.toLowerCase()));
    }
    return words.some((lw) => lw.toLowerCase() === w);
  }
  if (isChoice(tok)) {
    return tok.choice.some((c) => c.toLowerCase() === w || c.toLowerCase().startsWith(w));
  }
  if (isVar(tok)) {
    if (tok.type === "numeric" && !isNumeric(word)) return false;
    return true;
  }
  if (isPipe(tok)) {
    if (w === "|") return true;
    return tok.filters?.some((f) => f.lit.toLowerCase().startsWith(w)) ?? false;
  }
  return false;
}

/**
 * Does the CURRENT word (being typed, no trailing space) match a token as a
 * prefix? Empty current means "slot to fill" — always matches.
 */
function currentMatchesToken(current: string, tok: CommandToken, litWordIdx: number): boolean {
  const c = current.toLowerCase();
  if (isLit(tok)) {
    const words = splitLit(tok.lit);
    if (litWordIdx >= words.length) return c === "";
    return c === "" || words[litWordIdx].toLowerCase().startsWith(c);
  }
  if (isChoice(tok)) {
    return c === "" || tok.choice.some((opt) => opt.toLowerCase().startsWith(c));
  }
  if (isVar(tok)) {
    if (c === "") return true;
    if (tok.type === "numeric") return isNumeric(current);
    return true;
  }
  if (isPipe(tok)) {
    if (c === "" || c === "|") return true;
    return tok.filters?.some((f) => f.lit.toLowerCase().startsWith(c)) ?? false;
  }
  return false;
}

// ─── Fixed-order matching ────────────────────────────────────────────

function matchFixed(
  completed: string[],
  current: string,
  tokens: CommandToken[],
  negated: boolean,
): TokenMatch | null {
  let ci = 0; // cmd token index
  let uti = 0; // completed user token index
  const consumed: number[] = [];
  let litWordIdx = 0;

  // Walk completed user tokens against cmd tokens in order.
  while (uti < completed.length) {
    if (ci >= tokens.length) return null; // user typed beyond command
    const ct = tokens[ci];
    const isFirstLit = ci === 0 && isLit(ct);

    if (isLit(ct)) {
      const words = splitLit(ct.lit);
      let matchedAny = false;
      while (litWordIdx < words.length && uti < completed.length) {
        const uw = completed[uti].toLowerCase();
        const lw = words[litWordIdx].toLowerCase();
        const ok = isFirstLit
          ? lw.startsWith(uw) || uw.startsWith(lw)
          : lw === uw;
        if (ok) {
          uti++;
          litWordIdx++;
          matchedAny = true;
        } else {
          break;
        }
      }
      if (litWordIdx === words.length) {
        consumed.push(ci);
        ci++;
        litWordIdx = 0;
      } else if (uti >= completed.length) {
        // Ran out of completed words mid-lit — current word may complete it.
        // Fall through to resolveCurrent with the partial lit state.
        break;
      } else if (ct.optional && !matchedAny) {
        ci++; // skip optional lit that doesn't match
        litWordIdx = 0;
        continue;
      } else {
        return null;
      }
    } else if (isChoice(ct)) {
      if (completedWordMatchesToken(completed[uti], ct, false)) {
        consumed.push(ci);
        ci++;
        uti++;
      } else if (ct.optional) {
        ci++;
        continue;
      } else {
        return null;
      }
    } else if (isVar(ct)) {
      if (completedWordMatchesToken(completed[uti], ct, false)) {
        consumed.push(ci);
        ci++;
        uti++;
      } else if (ct.optional) {
        ci++;
        continue;
      } else {
        return null;
      }
    } else if (isPipe(ct)) {
      const uw = completed[uti];
      if (uw === "|") {
        uti++;
        if (uti >= completed.length) break; // filter is current
        const fw = completed[uti].toLowerCase();
        const filter = ct.filters?.find((f) => {
          const fl = f.lit.toLowerCase();
          return fl === fw || fl.startsWith(fw) || fw.startsWith(fl);
        });
        if (filter) {
          uti++;
          if (filter.var && uti < completed.length) uti++; // filter argument
          consumed.push(ci);
          if (!ct.repeatable) ci++;
          continue;
        } else if (ct.optional) {
          ci++;
          continue;
        } else {
          return null;
        }
      } else if (ct.optional) {
        ci++;
        continue;
      } else {
        return null;
      }
    }
  }

  // Now handle the current word against the next unconsumed token.
  return resolveCurrent(ci, litWordIdx, current, tokens, consumed, negated);
}

/**
 * Resolve the current word against the next expected token, skipping
 * optional tokens that the current word cannot match (fixed order allows
 * omitting optionals).
 */
function resolveCurrent(
  ciIn: number,
  litWordIdxIn: number,
  current: string,
  tokens: CommandToken[],
  consumed: number[],
  negated: boolean,
): TokenMatch | null {
  let ci = ciIn;
  let litWordIdx = litWordIdxIn;

  // Mid-lit: current is inside a multi-word lit.
  if (litWordIdx > 0 && ci < tokens.length && isLit(tokens[ci])) {
    const tok = tokens[ci];
    if (currentMatchesToken(current, tok, litWordIdx)) {
      return {
        currentTokenIndex: ci,
        currentTokenInput: current,
        consumedTokens: consumed,
        remainingTokens: tokens.slice(ci),
        litWordIndex: litWordIdx,
        negated,
      };
    }
    if (tok.optional) {
      ci++;
      litWordIdx = 0;
    } else {
      return null;
    }
  }

  // Walk forward, skipping optionals that don't match current.
  while (ci < tokens.length) {
    const ct = tokens[ci];
    if (currentMatchesToken(current, ct, 0)) {
      return {
        currentTokenIndex: ci,
        currentTokenInput: current,
        consumedTokens: consumed,
        remainingTokens: tokens.slice(ci),
        litWordIndex: 0,
        negated,
      };
    }
    if (ct.optional) {
      ci++;
      continue;
    }
    return null; // required token doesn't match current
  }

  // All tokens consumed or skipped.
  if (current === "") {
    return {
      currentTokenIndex: Math.max(tokens.length - 1, 0),
      currentTokenInput: "",
      consumedTokens: consumed,
      remainingTokens: [],
      litWordIndex: 0,
      negated,
    };
  }
  return null; // extra input beyond command
}

function matchUnordered(
  completed: string[],
  current: string,
  tokens: CommandToken[],
  negated: boolean,
): TokenMatch | null {
  // Find the boundary: last required token index.
  let lastRequired = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const opt =
      (isLit(t) && t.optional) ||
      (isChoice(t) && t.optional) ||
      (isVar(t) && t.optional) ||
      (isPipe(t) && t.optional);
    if (!opt) lastRequired = i;
  }

  const requiredTokens = tokens.slice(0, lastRequired + 1);
  const optionalTokens = tokens.slice(lastRequired + 1);

  // Match required tokens in order (reuse fixed-order logic for the required prefix).
  let ci = 0;
  let uti = 0;
  const consumed           = [];
  let litWordIdx = 0;

  while (uti < completed.length && ci < requiredTokens.length) {
    const ct = requiredTokens[ci];
    const isFirstLit = ci === 0 && isLit(ct);
    const globalCi = ci;

    if (isLit(ct)) {
      const words = splitLit(ct.lit);
      let matchedAny = false;
      while (litWordIdx < words.length && uti < completed.length) {
        const uw = completed[uti].toLowerCase();
        const lw = words[litWordIdx].toLowerCase();
        const ok = isFirstLit ? lw.startsWith(uw) || uw.startsWith(lw) : lw === uw;
        if (ok) {
          uti++;
          litWordIdx++;
          matchedAny = true;
        } else break;
      }
      if (litWordIdx === words.length) {
        consumed.push(globalCi);
        ci++;
        litWordIdx = 0;
      } else if (uti >= completed.length) {
        break;
      } else {
        return null;
      }
    } else if (isChoice(ct)) {
      if (completedWordMatchesToken(completed[uti], ct, false)) {
        consumed.push(globalCi);
        ci++;
        uti++;
      } else return null;
    } else if (isVar(ct)) {
      if (completedWordMatchesToken(completed[uti], ct, false)) {
        consumed.push(globalCi);
        ci++;
        uti++;
      } else return null;
    } else if (isPipe(ct)) {
      if (completed[uti] === '|') {
        consumed.push(globalCi);
        ci++;
        uti++;
      } else return null;
    }
  }

  if (ci < requiredTokens.length) {
    const m = resolveCurrent(ci, litWordIdx, current, requiredTokens, consumed, negated);
    if (!m) return null;
    return { ...m, remainingTokens: tokens.slice(m.currentTokenIndex) };
  }

  // Build optional units: lit+var forms a pair; others are standalone.
  // `repeatable: true` on a choice means flags can repeat (e.g. `ls -l -a`).
  type Unit =
    | { kind: 'choice'; idx: number; repeatable: boolean }
    | { kind: 'lit'; idx: number }
    | { kind: 'var'; idx: number }
    | { kind: 'pair'; litIdx: number; varIdx: number }
    | { kind: 'pipe'; idx: number };
  const units: Unit[] = [];
  {
    let i = 0;
    while (i < optionalTokens.length) {
      const t = optionalTokens[i];
      if (isLit(t)) {
        const next = optionalTokens[i + 1];
        if (isVar(next)) {
          units.push({ kind: 'pair', litIdx: lastRequired + 1 + i, varIdx: lastRequired + 1 + i + 1 });
          i += 2;
        } else {
          units.push({ kind: 'lit', idx: lastRequired + 1 + i });
          i += 1;
        }
      } else if (isChoice(t)) {
        units.push({ kind: 'choice', idx: lastRequired + 1 + i, repeatable: !!t.repeatable });
        i += 1;
      } else if (isVar(t)) {
        units.push({ kind: 'var', idx: lastRequired + 1 + i });
        i += 1;
      } else if (isPipe(t)) {
        units.push({ kind: 'pipe', idx: lastRequired + 1 + i });
        i += 1;
      } else {
        i += 1;
      }
    }
  }

  const usedUnit = new Set<number>();
  const optIdx = (unitIdx: number): number => unitIdx - lastRequired - 1;

  let ri = uti;
  while (ri < completed.length) {
    let found = -1;
    // Pass 1: keyword units (choice, lit, pair, pipe) — more specific.
    for (let u = 0; u < units.length; u++) {
      if (usedUnit.has(u)) continue;
      const unit = units[u];
      if (unit.kind === 'choice' || unit.kind === 'lit') {
        if (completedWordMatchesToken(completed[ri], optionalTokens[optIdx(unit.idx)], false)) {
          found = u;
          consumed.push(unit.idx);
          ri++;
          break;
        }
      } else if (unit.kind === 'pair') {
        const litTok = optionalTokens[optIdx(unit.litIdx)];
        if (completedWordMatchesToken(completed[ri], litTok, false)) {
          found = u;
          consumed.push(unit.litIdx);
          ri++;
          if (ri < completed.length) {
            consumed.push(unit.varIdx);
            ri++;
          }
          break;
        }
      } else if (unit.kind === 'pipe') {
        if (completed[ri].toLowerCase() === '|') {
          found = u;
          consumed.push(unit.idx);
          ri++;
          if (ri < completed.length) ri++;
          if (ri < completed.length) ri++;
          break;
        }
      }
    }
    // Pass 2: standalone var — catches free-text values not claimed by a keyword.
    if (found < 0) {
      for (let u = 0; u < units.length; u++) {
        if (usedUnit.has(u)) continue;
        const unit = units[u];
        if (unit.kind === 'var') {
          if (completedWordMatchesToken(completed[ri], optionalTokens[optIdx(unit.idx)], false)) {
            found = u;
            consumed.push(unit.idx);
            ri++;
            break;
          }
        }
      }
    }
    if (found < 0) return null;
    // Only mark a pair fully used if its var was also consumed.
    const fu = units[found];
    if (fu.kind === 'pair' && !consumed.includes(fu.varIdx)) {
      // Lit consumed but var pending — don't mark used; current word may be the value.
    } else if (fu.kind === 'choice' && fu.repeatable) {
      // Repeatable choice (e.g. `ls -l -a`): don't mark used — the unit can
      // match again. ponytail: only the `repeatable` flag widens this; a
      // one-shot choice still marks used as before.
    } else {
      usedUnit.add(found);
    }
  }

  if (current !== '') {
    // Check if the last consumed unit was a pair lit awaiting its value.
    for (let u = 0; u < units.length; u++) {
      if (usedUnit.has(u)) continue;
      const unit = units[u];
      if (unit.kind === 'pair') {
        // Was the lit consumed but not the var? Check consumed tokens.
        const litConsumed = consumed.includes(unit.litIdx);
        const varConsumed = consumed.includes(unit.varIdx);
        if (litConsumed && !varConsumed) {
          const varTok = optionalTokens[optIdx(unit.varIdx)];
          if (currentMatchesToken(current, varTok, 0)) {
            return {
              currentTokenIndex: unit.varIdx,
              currentTokenInput: current,
              consumedTokens: consumed,
              remainingTokens: tokens.slice(unit.varIdx),
              litWordIndex: 0,
              negated,
            };
          }
        }
      }
    }
    // Pass 1: keyword units first.
    for (let u = 0; u < units.length; u++) {
      if (usedUnit.has(u)) continue;
      const unit = units[u];
      if (unit.kind === 'choice' || unit.kind === 'lit') {
        if (currentMatchesToken(current, optionalTokens[optIdx(unit.idx)], 0)) {
          return {
            currentTokenIndex: unit.idx,
            currentTokenInput: current,
            consumedTokens: consumed,
            remainingTokens: tokens.slice(unit.idx),
            litWordIndex: 0,
            negated,
          };
        }
      } else if (unit.kind === 'pair') {
        if (currentMatchesToken(current, optionalTokens[optIdx(unit.litIdx)], 0)) {
          return {
            currentTokenIndex: unit.litIdx,
            currentTokenInput: current,
            consumedTokens: consumed,
            remainingTokens: tokens.slice(unit.litIdx),
            litWordIndex: 0,
            negated,
          };
        }
      }
    }
    // Pass 2: standalone var.
    for (let u = 0; u < units.length; u++) {
      if (usedUnit.has(u)) continue;
      const unit = units[u];
      if (unit.kind === 'var') {
        if (currentMatchesToken(current, optionalTokens[optIdx(unit.idx)], 0)) {
          return {
            currentTokenIndex: unit.idx,
            currentTokenInput: current,
            consumedTokens: consumed,
            remainingTokens: tokens.slice(unit.idx),
            litWordIndex: 0,
            negated,
          };
        }
      }
    }
    return null;
  }

  for (let u = 0; u < units.length; u++) {
    if (!usedUnit.has(u)) {
      const unit = units[u];
      const firstIdx = unit.kind === 'pair' ? unit.litIdx : unit.idx;
      return {
        currentTokenIndex: firstIdx,
        currentTokenInput: '',
        consumedTokens: consumed,
        remainingTokens: tokens.slice(firstIdx),
        litWordIndex: 0,
        negated,
      };
    }
  }

  return {
    currentTokenIndex: Math.max(tokens.length - 1, 0),
    currentTokenInput: '',
    consumedTokens: consumed,
    remainingTokens: [],
    litWordIndex: 0,
    negated,
  };
}// ─── Public matcher ──────────────────────────────────────────────────

/**
 * Match user input against a command's tokens positionally.
 * Returns null if the input cannot match this command.
 */
export function matchTokens(
  input: string,
  cmd: Command,
  negationPrefix?: string | null,
): TokenMatch | null {
  if (!cmd.tokens || cmd.tokens.length === 0) return null;

  // Strip negation prefix (cmd must be negatable).
  let work = input;
  let negated = false;
  if (cmd.negatable && negationPrefix) {
    const np = negationPrefix.toLowerCase();
    if (work.toLowerCase().startsWith(np)) {
      work = work.substring(negationPrefix.length);
      negated = true;
    }
  }

  // Parse into completed words + current word.
  const trimmed = work.trim();
  const endsWithSpace = work.length > 0 && /\s$/.test(work);
  const allWords = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const completed = endsWithSpace ? allWords : allWords.slice(0, -1);
  const current =
    !endsWithSpace && allWords.length > 0 ? allWords[allWords.length - 1] : "";

  const order: CommandOrder = cmd.order ?? "fixed";
  if (order === "fixed") {
    return matchFixed(completed, current, cmd.tokens, negated);
  }
  return matchUnordered(completed, current, cmd.tokens, negated);
}

// ─── Engine ──────────────────────────────────────────────────────────

export interface PrefixCommandDef {
  unlocks: string[];
  skip_flag_value?: string[];
}

/** Stripped prefix state: remainder text + the modes it unlocks. */
interface StrippedPrefix {
  prefix: string;
  remainder: string;
  unlocks: string[];
}

/**
 * Detect a prefix command (sudo, tmsh) at the start of the input.
 * Strips the prefix word and any skip-flag+value pairs that follow
 * (e.g. `sudo -u root <cmd>`). Only fires when the prefix is a
 * complete word followed by a space — `sud` stays a normal match.
 */
function stripPrefix(input: string, prefixes: Map<string, PrefixCommandDef>): StrippedPrefix | null {
  const lower = input.toLowerCase();
  for (const [word, def] of prefixes) {
    if (!lower.startsWith(word + " ")) continue;
    let rest = input.substring(word.length + 1);
    // Skip flag+value pairs (sudo -u root cmd → cmd)
    if (def.skip_flag_value?.length) {
      for (;;) {
        const m = rest.match(/^(\S+)\s+(\S+)\s/);
        const m2 = rest.match(/^(\S+)\s+(\S+)$/);
        const flag = m?.[1] ?? m2?.[1] ?? null;
        if (flag && def.skip_flag_value.includes(flag.toLowerCase())) {
          rest = m ? rest.replace(/^(\S+)\s+(\S+)\s/, "") : rest.replace(/^(\S+)\s+(\S+)$/, "").trim();
          // After a flag+value pair there must be more input; if rest is
          // empty the user stopped after the value — treat remainder as "".
          rest = rest.replace(/^\s+/, "");
          if (!rest) return { prefix: word, remainder: "", unlocks: def.unlocks };
          continue;
        }
        break;
      }
    }
    return { prefix: word, remainder: rest, unlocks: def.unlocks };
  }
  return null;
}

export class SuggestionEngine {
  private commands: Command[] = [];
  private _platform: string = "";
  private _version: string = "";
  private mode: string = "";
  private negationPrefix: string | null = null;
  private prefixCommands: Map<string, PrefixCommandDef> = new Map();

  /** Load commands for a platform (called on connect) */
  loadCommands(
    commands: Command[],
    platform: string,
    negationPrefix?: string | null,
  ) {
    this.commands = commands;
    this._platform = platform;
    this.negationPrefix = negationPrefix ?? null;
  }

  /** Set prefix commands independently of loadCommands (single source: platform index). */
  setPrefixCommands(prefixCommands: Record<string, PrefixCommandDef>) {
    this.prefixCommands = new Map(Object.entries(prefixCommands));
  }

  /**
   * Input minus a known prefix command and its skip-flag+value pairs
   * (e.g. `sudo -u root cmd` → `cmd`). The caller passes a prefix it already
   * confirmed is present (came from this engine's own stripPrefix).
   */
  effectiveInputAfterPrefix(input: string, prefix: string): string {
    const stripped = stripPrefix(input, this.prefixCommands);
    return stripped?.remainder ?? input.substring(prefix.length).trimStart();
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
    // Prefix-command path: `sudo <cmd>` / `tmsh <cmd>` — strip the prefix,
    // match the remainder against the prefix's unlocked modes. Only fires
    // once the user has typed an inner command word; bare `sudo ` still
    // suggests the sudo entry itself.
    const stripped = stripPrefix(input, this.prefixCommands);
    if (stripped && stripped.remainder.trim() !== "") {
      const inner = this.matchInput(stripped.remainder, stripped.unlocks);
      if (inner.length > 0) {
        for (const r of inner) r.prefix = stripped.prefix;
        return inner;
      }
      // No inner match — fall through so `sudo -u ...` still shows the
      // prefix command's own entry (flags, description) as today.
    }
    return this.matchInput(input, this.mode ? [this.mode] : null);
  }

  /**
   * Match input against commands, filtered to the given modes.
   * Null modeFilter = no filter (mode unknown).
   */
  private matchInput(input: string, modeFilter: string[] | null): SuggestionResult[] {
    const lowerInput = input.toLowerCase().trim();
    const results: SuggestionResult[] = [];

    for (const cmd of this.commands) {
      // Filter by mode if set
      if (modeFilter && !modeFilter.includes(cmd.mode)) continue;

      // Empty input: return all commands for current mode
      if (!lowerInput) {
        results.push({
          command: cmd,
          matchType: cmd.tokens?.length ? "token" : "name",
          matchedText: cmd.name,
          tokenMatch: null,
        });
        continue;
      }

      // Token path: commands with tokens
      if (cmd.tokens && cmd.tokens.length > 0) {
        const tm = matchTokens(input, cmd, this.negationPrefix);
        if (tm) {
          results.push({
            command: cmd,
            matchType: "token",
            matchedText: cmd.name,
            tokenMatch: tm,
          });
          continue;
        }
        // Fall through to legacy if token matching fails? No — a token-aware
        // command that doesn't match positionally is not a match. Legacy
        // matching against its name would be wrong (it would suggest the
        // command when the user has typed past its name into an invalid arg).
        // However, name-prefix matching is still valid for the command stem.
        if (cmd.name.toLowerCase().startsWith(lowerInput)) {
          results.push({
            command: cmd,
            matchType: "name",
            matchedText: cmd.name,
            tokenMatch: null,
          });
        }
        continue;
      }

      // Legacy path: commands without tokens
      if (cmd.name.toLowerCase().startsWith(lowerInput)) {
        results.push({
          command: cmd,
          matchType: "name",
          matchedText: cmd.name,
          tokenMatch: null,
        });
        continue;
      }

      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(lowerInput)) {
          results.push({
            command: cmd,
            matchType: "alias",
            matchedText: alias,
            tokenMatch: null,
          });
          break;
        }
      }
    }

    // Sort: token matches first, then name, then alias.
    // Within token matches: more consumed tokens = better.
    // Within name/alias: alphabetical.
    results.sort((a, b) => {
      const rank = (r: SuggestionResult) => {
        if (r.matchType === "token") return 0;
        if (r.matchType === "name") return 1;
        return 2;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) {
        const ca = a.tokenMatch?.consumedTokens.length ?? 0;
        const cb = b.tokenMatch?.consumedTokens.length ?? 0;
        if (ca !== cb) return cb - ca;
      }
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