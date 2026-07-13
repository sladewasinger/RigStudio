/**
 * Layers panel search/filter (Category B item 1): editor-only session state — never
 * persisted, never serialized — that narrows the tree to parts whose label matches a
 * substring, case-insensitively. Matched parts' ANCESTOR CHAIN stays visible too (a
 * match buried three levels deep is useless without the path to reach it) and those
 * ancestors auto-expand so the match is actually on screen without manual clicks.
 * Clearing the query (Escape, or emptying the box) restores the tree exactly — this
 * module never touches layers.ts's own `expanded` Set, so fold state the user set by
 * hand survives a search round trip untouched. Scoped to PARTS only (paths inside an
 * expanded part render as before, unfiltered) — matches the roadmap item's own framing
 * ("Find/search parts").
 */
import { RigDoc, RigPart } from '../core/model';

let query = '';

export function isSearchActive(): boolean {
  return query.trim().length > 0;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Whether `part`'s own label matches the current query (used for the match highlight —
 *  distinct from `visiblePartIds`, which also includes ancestors-of-matches). */
export function isDirectMatch(part: RigPart): boolean {
  return isSearchActive() && part.label.toLowerCase().includes(normalize(query));
}

/**
 * null when no active query (render the whole tree at its normal fold state).
 * Otherwise every part id that must render: matches plus every ancestor of a match, so
 * the tree path down to each one stays intact.
 */
export function visiblePartIds(doc: RigDoc): Set<string> | null {
  if (!isSearchActive()) return null;
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const visible = new Set<string>();
  for (const part of doc.parts) {
    if (!isDirectMatch(part)) continue;
    visible.add(part.id);
    let cur = part.parentId ? byId.get(part.parentId) : undefined;
    while (cur && !visible.has(cur.id)) {
      visible.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return visible;
}

/**
 * The search input row, prepended above the layer tree. Typing filters live
 * (`onChange` triggers the panel rebuild); Escape clears the query if it has text, else
 * just blurs (a second Escape then reaches the app's normal Escape cascade).
 */
export function buildSearchBar(onChange: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'layers-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Filter parts…';
  input.value = query;
  input.setAttribute('aria-label', 'Filter layers by label');
  input.oninput = () => {
    query = input.value;
    onChange();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // don't let '%'/tool-key/etc. shortcuts fire while typing
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (query) { query = ''; onChange(); } else { input.blur(); }
    }
  });
  row.appendChild(input);
  return row;
}
