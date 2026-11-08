/**
 * Launch seam. Presentational state that lives outside the App object is
 * applied here, before the first screen paints, then the app is constructed.
 * Kept out of main.ts so the launch path is testable — main.ts imports Tauri
 * and CSS and is excluded from coverage.
 *
 * Reading Comfort must be re-applied on every launch: the stored key survives
 * restarts but the `data-reading-comfort` attribute and `--text-scale` are
 * DOM-only (docs/specs/12-dyslexia-mode.md §Verification step 2). Calling
 * applyReadingComfort() when nothing is stored is a harmless DOM clear.
 */

import { applyReadingComfort } from "./reading-comfort";

export function startApp(createApp: () => void): void {
  applyReadingComfort();
  createApp();
}
