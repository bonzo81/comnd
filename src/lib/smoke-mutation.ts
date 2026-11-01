import { invoke } from "@tauri-apps/api/core";

/**
 * Smoke-only deliberate regressions (issue #89). The runner boots the app with
 * `COMND_SMOKE_MUTATION=focus|name|layout` and then expects the matching
 * assertion to fail; a clean run means the assertion no longer catches the
 * class of bug it exists to catch.
 *
 * The mutation is applied before `new App()` so the regression is in place for
 * the whole session, exactly as a real bug would be. Nothing here runs in a
 * release build: the command behind `test_smoke_mutation` is debug-only and the
 * module is only imported when Vite builds with `--mode smoke`.
 */
export type SmokeMutation = "focus" | "name" | "layout";

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
  else return;
  document.documentElement.dataset.smokeMutation = category;
}
