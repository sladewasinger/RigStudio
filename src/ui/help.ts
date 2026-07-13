/**
 * Keyboard-shortcut reference and the "?" help overlay.
 *
 * The keyboard rows are GENERATED from `shortcutBindings.ts` + `shortcutBindingsTools.ts`
 * (the same REGISTRY `shortcuts.ts`'s `installShortcuts()` dispatches against) — a
 * binding and its documentation live in the SAME object, so they cannot drift apart
 * (Pattern-driven redesign pass, ROADMAP.md; this file previously hand-maintained a
 * separate SHORTCUTS array that drifted from main.ts's handler twice before the redesign).
 * The two priority cascades (Delete, Escape) already carry their JOINED tier descriptions
 * baked into their registry entry's `help.description` (see `shortcutBindings.ts`'s
 * `deleteCascade` / `shortcutBindingsTools.ts`'s `escapeCascade`), so this file needs no
 * special-case logic for them — every entry maps to a row the same way.
 *
 * TOOLBAR_ROWS and MOUSE_AND_TOOLS_ROWS are hand-authored on purpose: neither is a
 * `document.keydown` binding (toolbar buttons and canvas/inspector mouse gestures aren't
 * REGISTRY entries at all), so mixing them into the generated list would reintroduce
 * exactly the "pseudo-shortcut" drift risk the redesign eliminates for real bindings.
 * Kept in their own GROUP_ORDER sections so they render visibly separate from the
 * generated ones, never interleaved.
 */

import { FILE_EDIT_BINDINGS } from './shortcutBindings';
import { TOOLS_VIEW_BINDINGS } from './shortcutBindingsTools';

export interface ShortcutEntry {
  keys: string;
  description: string;
  /** Section heading the entry renders under. */
  context: string;
}

/** Section order in the overlay. Toolbar/Mouse & tools are hand-authored (not real
 *  keydown bindings) and always render last, clearly separated from the generated ones. */
const GROUP_ORDER = [
  'File', 'Edit', 'Tools', 'View', 'Timeline', 'Toolbar', 'Mouse & tools',
] as const;

/** Toolbar buttons with no keyboard equivalent (Ctrl+S/Ctrl+O ARE real bindings and
 *  appear in the generated File section instead — not duplicated here). */
const TOOLBAR_ROWS: ShortcutEntry[] = [
  { keys: 'toolbar only', description: 'New — start a blank project', context: 'Toolbar' },
  { keys: 'toolbar only', description: 'Load sample', context: 'Toolbar' },
  { keys: 'toolbar only', description: 'Export Lottie (.json)', context: 'Toolbar' },
  {
    keys: 'toolbar only',
    description: 'Export Rive (.riv) — all clips + state machines as one binary',
    context: 'Toolbar',
  },
  { keys: 'toolbar only', description: 'Export PNG — the current frame as a still image', context: 'Toolbar' },
  { keys: 'toolbar only', description: 'Export SVG — the current pose as a vector image', context: 'Toolbar' },
];

/** Mouse gestures and inspector-button actions — never keyboard bindings, so they can't
 *  live in the generated sections above (see this file's header comment). */
const MOUSE_AND_TOOLS_ROWS: ShortcutEntry[] = [
  {
    keys: 'canvas-tools femur button',
    description: 'Also arms the bone tool (same as the B key)',
    context: 'Mouse & tools',
  },
  { keys: 'Mouse wheel', description: 'Zoom, centered on the cursor', context: 'Mouse & tools' },
  { keys: 'Middle-drag', description: 'Pan the canvas', context: 'Mouse & tools' },
  {
    keys: 'Body drag',
    description: 'Select tool: translate the selection; after a second click on it, ' +
      'rotate around the pivot (both Edit and Animate)',
    context: 'Mouse & tools',
  },
  {
    keys: 'Click a selected part',
    description: 'Cycle the handle set: translate/scale ↔ rotate/skew (flips what a body drag does)',
    context: 'Mouse & tools',
  },
  {
    keys: 'Gizmo circle / cross',
    description: 'Drag the circle to rotate around the pivot, the cross to translate (both modes)',
    context: 'Mouse & tools',
  },
  {
    keys: 'Ctrl+drag (translate)',
    description: 'Constrain a free move to its dominant axis',
    context: 'Mouse & tools',
  },
  { keys: 'Ctrl+drag (rotate)', description: 'Snap rotation to 15° increments', context: 'Mouse & tools' },
  { keys: 'Ctrl+drag (corner scale)', description: 'Scale uniformly (equal x/y)', context: 'Mouse & tools' },
  { keys: 'Shift+drag', description: 'Always translate the selection (either handle set)', context: 'Mouse & tools' },
  {
    keys: 'Shift+click / Ctrl+click',
    description: 'Add to the multi-selection (canvas parts, pose mode)',
    context: 'Mouse & tools',
  },
  {
    keys: 'Layers: Shift+click',
    description: 'Range-select from the anchor row to the clicked row (Ctrl+click toggles one)',
    context: 'Mouse & tools',
  },
  {
    keys: 'Layers: eye icon',
    description: 'Hide/show a part on the canvas (editor only — never keyed, never exported)',
    context: 'Mouse & tools',
  },
  { keys: 'Alt+click a segment', description: 'Insert a node at that exact point', context: 'Mouse & tools' },
  { keys: 'Ctrl+click a node', description: 'Delete that node', context: 'Mouse & tools' },
  {
    keys: 'Double-click',
    description: 'Dive into a group (enters it, selects nothing); a single click then ' +
      'selects a child, a further double-click dives deeper, then into path/node scope. ' +
      'Escape / blank click steps out one level',
    context: 'Mouse & tools',
  },
  {
    keys: 'smooth / symmetric / corner',
    description: 'Inspector buttons: set the selected node(s)’ persistent handle type',
    context: 'Mouse & tools',
  },
  { keys: '→ curve / → line', description: 'Inspector buttons: convert the outgoing segment', context: 'Mouse & tools' },
  {
    keys: 'join / join seg',
    description: 'Inspector buttons: weld or bridge the two selected end nodes',
    context: 'Mouse & tools',
  },
  {
    keys: 'del seg',
    description: 'Inspector button: delete the segment between two selected adjacent nodes',
    context: 'Mouse & tools',
  },
];

/** The generated keyboard rows — one per REGISTRY entry, in registry order. */
function generatedRows(): ShortcutEntry[] {
  return [...FILE_EDIT_BINDINGS, ...TOOLS_VIEW_BINDINGS].map((b) => b.help);
}

/** All rows grouped by context, in GROUP_ORDER order; empty groups are omitted. */
export function groupedShortcuts(): { title: string; entries: ShortcutEntry[] }[] {
  const all = [...generatedRows(), ...TOOLBAR_ROWS, ...MOUSE_AND_TOOLS_ROWS];
  return GROUP_ORDER
    .map((title) => ({ title, entries: all.filter((s) => s.context === title) }))
    .filter((g) => g.entries.length > 0);
}

// ---- Overlay DOM ----

let overlayEl: HTMLElement | null = null;

/** Whether the overlay is currently on screen. */
export function isHelpOpen(): boolean {
  return overlayEl !== null;
}

/** Build and show the overlay. A no-op if it's already open. */
export function openHelp(): void {
  if (overlayEl) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'help-overlay';
  backdrop.className = 'help-overlay';
  // Click the backdrop (not the card) to dismiss.
  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) closeHelp();
  });

  const card = document.createElement('div');
  card.className = 'help-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Keyboard shortcuts');

  const header = document.createElement('div');
  header.className = 'help-header';
  const title = document.createElement('h2');
  title.textContent = 'Keyboard shortcuts';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'help-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  closeBtn.onclick = () => closeHelp();
  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'help-body';
  for (const group of groupedShortcuts()) {
    const section = document.createElement('section');
    const h3 = document.createElement('h3');
    h3.textContent = group.title;
    section.appendChild(h3);
    const table = document.createElement('table');
    table.className = 'help-table';
    for (const entry of group.entries) {
      const row = document.createElement('tr');
      const keyCell = document.createElement('td');
      keyCell.className = 'help-keys';
      keyCell.textContent = entry.keys;
      const descCell = document.createElement('td');
      descCell.textContent = entry.description;
      row.appendChild(keyCell);
      row.appendChild(descCell);
      table.appendChild(row);
    }
    section.appendChild(table);
    body.appendChild(section);
  }
  card.appendChild(body);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  overlayEl = backdrop;
}

/** Hide and discard the overlay. A no-op if it's already closed. */
export function closeHelp(): void {
  overlayEl?.remove();
  overlayEl = null;
}

export function toggleHelp(): void {
  if (overlayEl) closeHelp();
  else openHelp();
}
