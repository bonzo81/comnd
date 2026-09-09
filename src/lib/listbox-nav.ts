/**
 * ListboxNav — shared listbox index move: wrap or clamp at the ends.
 * Callers own their key handling, rendering, and scrollIntoView.
 */

/** Move the selected index by delta. wrap (default) wraps; false clamps. count=0 is a no-op. */
export function moveListItem(
  count: number,
  selected: number,
  setSelected: (i: number) => void,
  delta: number,
  wrap = true,
): void {
  if (count === 0) return;
  const cur = Math.min(Math.max(selected, 0), count - 1);
  setSelected(wrap ? (cur + delta + count) % count : Math.min(Math.max(cur + delta, 0), count - 1));
}