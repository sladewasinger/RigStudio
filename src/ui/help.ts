/**
 * Keyboard-shortcut reference and the "?" help overlay.
 *
 * SHORTCUTS is the single source of truth for what's documented — main.ts's keydown
 * handler implements the bindings, this list just describes them. Keeping them in one
 * array (grouped by a `context` label rather than nested arrays) makes it cheap to add
 * a row without restructuring anything.
 */

export interface ShortcutEntry {
  keys: string;
  description: string;
  /** Section heading the entry renders under. */
  context: string;
}

/** Section order in the overlay (also the canonical group list from the spec). */
const GROUP_ORDER = [
  'File', 'Edit', 'Tools', 'View', 'Timeline', 'Node editing', 'Mouse',
] as const;

export const SHORTCUTS: ShortcutEntry[] = [
  // ---- File ----
  { keys: 'toolbar only', description: 'New — start a blank project', context: 'File' },
  { keys: 'Ctrl+S', description: 'Save the project (downloads a .rig.json)', context: 'File' },
  { keys: 'Ctrl+O', description: 'Open an SVG or a saved .rig.json project', context: 'File' },
  { keys: 'toolbar only', description: 'Load sample', context: 'File' },
  { keys: 'toolbar only', description: 'Export Lottie (.json)', context: 'File' },

  // ---- Edit ----
  { keys: 'Ctrl+Z', description: 'Undo', context: 'Edit' },
  { keys: 'Ctrl+Shift+Z / Ctrl+Y', description: 'Redo', context: 'Edit' },
  { keys: 'Ctrl+C', description: 'Copy the selected keyframes (Animate)', context: 'Edit' },
  { keys: 'Ctrl+V', description: 'Paste keyframes at the playhead (Animate)', context: 'Edit' },
  {
    keys: 'Ctrl+A',
    description: 'Select all — every part in Edit/Animate, or every node of the ' +
      'edited path in node-editing mode',
    context: 'Edit',
  },
  {
    keys: 'Ctrl+D',
    description: 'Duplicate the selected part(s), offset +12,+12 (Edit only, skips skinned parts)',
    context: 'Edit',
  },
  {
    keys: 'Delete / Backspace',
    description: 'Delete selected keyframes, else selected nodes, else selected layers ' +
      '(first that applies wins)',
    context: 'Edit',
  },
  { keys: 'Ctrl+G', description: 'Group the selection into a null', context: 'Edit' },
  { keys: 'Ctrl+Shift+G', description: 'Ungroup/dissolve the selected group or bone', context: 'Edit' },
  {
    keys: 'Arrow keys',
    description: 'Nudge the selected parts 2 screen px (Edit pose mode, Shift = 20)',
    context: 'Edit',
  },
  {
    keys: 'PageUp / PageDown',
    description: 'Bring the selected part (or entered path) forward / send it backward in draw order',
    context: 'Edit',
  },

  // ---- Tools ----
  { keys: 'V', description: 'Select tool', context: 'Tools' },
  { keys: 'T', description: 'Translate tool', context: 'Tools' },
  { keys: 'R', description: 'Rotate tool', context: 'Tools' },
  { keys: 'I', description: 'IK tool — drag a limb end, its parent joints solve to follow', context: 'Tools' },
  { keys: '%', description: 'Toggle Edit-mode snapping', context: 'Tools' },
  {
    keys: 'Y',
    description: 'Toggle freeze (origin-editing) mode — unlocks pivot / origin / joint ' +
      'dragging (off by default so origins never move by accident)',
    context: 'Tools',
  },
  { keys: 'Shift+H', description: 'Flip the selection horizontally, in place (Edit)', context: 'Tools' },
  { keys: 'Shift+V', description: 'Flip the selection vertically, in place (Edit)', context: 'Tools' },

  // ---- View ----
  { keys: 'F', description: 'Fit the view to the document', context: 'View' },
  { keys: '+ / =', description: 'Zoom in, centered on the canvas', context: 'View' },
  { keys: '-', description: 'Zoom out, centered on the canvas', context: 'View' },
  { keys: 'Mouse wheel', description: 'Zoom, centered on the cursor', context: 'View' },
  { keys: 'Middle-drag', description: 'Pan the canvas', context: 'View' },
  { keys: 'Tab', description: 'Toggle Edit / Animate mode', context: 'View' },
  { keys: '? / F1', description: 'Toggle this shortcut overlay', context: 'View' },
  {
    keys: 'Escape',
    description: 'Step back out: close this overlay → exit freeze mode → cancel bone ' +
      'placement → exit path → exit group / deselect',
    context: 'View',
  },

  // ---- Timeline ----
  { keys: 'Space', description: 'Play / pause', context: 'Timeline' },
  {
    keys: '← / →',
    description: 'Scrub the playhead (10 ms, Shift = 100 ms), or nudge selected keyframes',
    context: 'Timeline',
  },
  // ---- Node editing ----
  { keys: 'Alt+click a node', description: 'Insert a new node after it', context: 'Node editing' },
  { keys: 'Ctrl+click a node', description: 'Delete that node', context: 'Node editing' },
  {
    keys: 'Double-click',
    description: 'Dive into a group (enters it, selects nothing); a single click then ' +
      'selects a child, a further double-click dives deeper, then into path/node scope. ' +
      'Escape / blank click steps out one level',
    context: 'Node editing',
  },
  {
    keys: 'smooth / symmetric / corner',
    description: 'Set the selected node(s)’ persistent handle type',
    context: 'Node editing',
  },
  { keys: '→ curve / → line', description: 'Convert the outgoing segment', context: 'Node editing' },
  { keys: 'join / join seg', description: 'Weld or bridge the two selected end nodes', context: 'Node editing' },
  {
    keys: 'del seg',
    description: 'Delete the segment between two selected adjacent nodes',
    context: 'Node editing',
  },
  {
    keys: 'Arrow keys',
    description: 'Nudge selected nodes (0.5 doc units, Shift = 5)',
    context: 'Node editing',
  },

  // ---- Mouse ----
  {
    keys: 'Body drag',
    description: 'Select tool: translate the selection; after a second click on it, ' +
      'rotate around the pivot (both Edit and Animate)',
    context: 'Mouse',
  },
  {
    keys: 'Click a selected part',
    description: 'Cycle the handle set: translate/scale ↔ rotate/skew (flips what a body drag does)',
    context: 'Mouse',
  },
  {
    keys: 'Gizmo circle / cross',
    description: 'Drag the circle to rotate around the pivot, the cross to translate (both modes)',
    context: 'Mouse',
  },
  {
    keys: 'Ctrl+drag (translate)',
    description: 'Constrain a free move to its dominant axis',
    context: 'Mouse',
  },
  { keys: 'Ctrl+drag (rotate)', description: 'Snap rotation to 15° increments', context: 'Mouse' },
  { keys: 'Ctrl+drag (corner scale)', description: 'Scale uniformly (equal x/y)', context: 'Mouse' },
  { keys: 'Shift+drag', description: 'Always translate the selection (either handle set)', context: 'Mouse' },
  {
    keys: 'Shift+click / Ctrl+click',
    description: 'Add to the multi-selection (canvas parts, pose mode)',
    context: 'Mouse',
  },
  {
    keys: 'Layers: Shift+click',
    description: 'Range-select from the anchor row to the clicked row (Ctrl+click toggles one)',
    context: 'Mouse',
  },
];

/** SHORTCUTS grouped by context, in GROUP_ORDER order; empty groups are omitted. */
export function groupedShortcuts(): { title: string; entries: ShortcutEntry[] }[] {
  return GROUP_ORDER
    .map((title) => ({ title, entries: SHORTCUTS.filter((s) => s.context === title) }))
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
