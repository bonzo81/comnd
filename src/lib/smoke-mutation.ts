import { invoke } from "@tauri-apps/api/core";

/**
 * Smoke-only deliberate regressions (issue #89). The runner boots the app with
 * `COMND_SMOKE_MUTATION=focus|name|layout|suggestion|kb-layout|terminal-sidebar-layout`
 * and then expects the matching assertion to fail; a clean run means the
 * assertion no longer catches the class of bug it exists to catch.
 *
 * The mutation is applied before `new App()` so the regression is in place for
 * the whole session, exactly as a real bug would be. Nothing here runs in a
 * release build: the command behind `test_smoke_mutation` is debug-only and the
 * module is only imported when Vite builds with `--mode smoke`.
 */
export type SmokeMutation =
  | "focus"
  | "name"
  | "layout"
  | "suggestion"
  | "kb-layout"
  | "terminal-sidebar-layout";

const STYLE_ID = "comnd-smoke-mutation-style";

function addStyle(css: string): void {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Removes every visible focus indicator from the document. */
function mutateFocus(): void {
  addStyle(`
    *:focus,
    *:focus-visible,
    *:focus-within {
      outline: none !important;
      box-shadow: none !important;
    }
  `);
}

/**
 * Removes accessible names from controls that have no visible text, leaving
 * only icon-only buttons and the like unnamed — the exact case issue #89 wants
 * the name scan to notice.
 */
function mutateName(): void {
  const strip = (root: ParentNode): void => {
    const selector = "[aria-label], [aria-labelledby], [title]";
    const nodes: Element[] = Array.from(root.querySelectorAll(selector));
    if (root instanceof Element && root.matches(selector)) nodes.push(root);
    for (const el of nodes) {
      const text = (el.textContent ?? "").trim();
      if (text.length > 0) continue;
      el.removeAttribute("aria-label");
      el.removeAttribute("aria-labelledby");
      el.removeAttribute("title");
    }
  };
  strip(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) strip(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/** Overlays the sidebar on the terminal instead of resizing it. */
function mutateLayout(): void {
  addStyle(`
    .tv-main { position: relative; }
    .tv-sidebar {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 30;
    }
  `);
}

/**
 * Pushes the Knowledge Base detail actions and the command count off the right
 * edge of the window, so `kb-layout` fails on geometry a user would see rather
 * than on a behaviour change.
 */
function mutateKbLayout(): void {
  addStyle(`
    /* Breaks kb-layout's in-window box and hit-test assertions for
       #kb-cmd-edit-btn, #kb-cmd-ignore-btn and #kb-cmd-delete-btn. */
    .cmd-actions {
      transform: translateX(200vw);
    }
    /* Breaks kb-layout's assertion that .kb-count stays inside the window. */
    .kb-count {
      transform: translateX(200vw);
    }
  `);
}

/**
 * Pushes the terminal side panel's controls off the right edge of the window.
 * The panel keeps rendering the command detail, so only the control geometry
 * assertions in `terminal-sidebar-layout` fail.
 *
 * `position: fixed` is what makes the regression stick: the sidebar scrolls, so
 * a merely transformed control could be scrolled back into view. A fixed box is
 * placed against the viewport instead, where no scroll of the panel reaches it.
 */
function mutateTerminalSidebarLayout(): void {
  addStyle(`
    /* Breaks terminal-sidebar-layout's in-window box and hit-test assertions
       for every .sb-content .example-copy button. */
    .sb-content .example-copy {
      position: fixed !important;
      left: 200vw !important;
      right: auto !important;
    }
    /* Breaks the same assertions for the panel's .cmd-ref-link. */
    .sb-content .cmd-ref-link {
      position: fixed !important;
      left: 200vw !important;
      right: auto !important;
    }
    /* Breaks the same assertions for the sidebar resizer handle. */
    #tv-sidebar-resizer {
      position: fixed !important;
      left: 200vw !important;
      right: auto !important;
    }
  `);
}

export async function applySmokeMutation(): Promise<void> {
  let category: string | null = null;
  try {
    category = await invoke<string | null>("test_smoke_mutation");
  } catch {
    return;
  }
  if (!category) return;
  if (category === "focus") mutateFocus();
  else if (category === "name") mutateName();
  else if (category === "layout") mutateLayout();
  else if (category === "kb-layout") mutateKbLayout();
  else if (category === "terminal-sidebar-layout") mutateTerminalSidebarLayout();
  // `suggestion` needs no DOM change of its own: the marker written below
  // makes SuggestionEngine.stripPrefix stop stripping, which only the prefix
  // scenario reaches (issue #138).
  else if (category !== "suggestion") return;
  document.documentElement.dataset.smokeMutation = category;
}
