/**
 * Layers panel: a folder-style tree — parts nest under their parent part (bone
 * hierarchy) and each part folds open to show the SVG objects (paths) inside it. Drag
 * a part onto another to parent it; drop it on the "un-parent" strip to detach; drag a
 * path onto a sibling to reorder or onto another part to move it there (render-neutral).
 * Double-click renames (names carry through into exported files). This module owns tree
 * building + inline rename; ALL drag-and-drop wiring lives in layersDragAndDrop.ts.
 */

import { state, notify, selectedPart, selectPart, ancestorChain, RigPart } from '../core/model';
import { renderPose, enterGroupsFor } from '../view';
import { checkpoint } from '../core/history';
import { showContextMenu } from '../ui/contextMenu';
import { buildPartContextMenu } from '../ui/actions';
import { buildPathContextMenu } from '../ui/pathActions';
import { icon } from './icons';
import {
  wireDropTarget, wirePartRowDrag, wirePartRowDrop, wirePathRowDrag, wirePathRowDrop,
} from './layersDragAndDrop';
import { ensureLayersSplitter } from './layersResize';

/** layersDragAndDrop opens folders through this (the `expanded` set stays module-local). */
const expandPart = (partId: string): void => { expanded.add(partId); };

// ---- Layers tree ----

/** Parts whose folders are open. Persists across re-renders within a session. */
const expanded = new Set<string>();

/**
 * The part ids in the order their rows render in the tree (depth-first, top part first,
 * children only under expanded folders) — the "visible row order" a Shift+range select
 * spans. Mirrors buildLayersPanel / partNode's traversal exactly (reverse doc order,
 * `!parentId` roots), so a range never includes a collapsed part.
 */
function visiblePartOrder(): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const out: string[] = [];
  const walk = (parts: RigPart[]): void => {
    for (const p of parts) {
      out.push(p.id);
      if (expanded.has(p.id)) {
        walk([...doc.parts].reverse().filter((c) => c.parentId === p.id));
      }
    }
  };
  walk([...doc.parts].reverse().filter((p) => !p.parentId));
  return out;
}

export function buildLayersPanel(el: HTMLElement): void {
  ensureLayersSplitter(el); // idempotent — sets up the width splitter once, at boot
  el.innerHTML = '<h2>Layers</h2>';
  const doc = state.doc;
  if (!doc) return;

  // Never hide the selection inside a collapsed branch (e.g. a freshly placed bone).
  const selected = selectedPart();
  if (selected) {
    for (const ancestor of ancestorChain(selected)) expanded.add(ancestor.id);
  }

  const tree = document.createElement('ul');
  tree.className = 'layer-tree';
  // Topmost drawn part first, like every art tool.
  const roots = [...doc.parts].reverse().filter((p) => !p.parentId);
  for (const part of roots) tree.appendChild(partNode(part));
  el.appendChild(tree);

  // Drop strip: drag a part here to detach it from its parent.
  const unparent = document.createElement('div');
  unparent.className = 'unparent-zone';
  unparent.textContent = '⤒ drop a part here to un-parent it';
  wireDropTarget(unparent, null, expandPart);
  el.appendChild(unparent);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Click ▸ to fold parts open. Drag one part onto another to parent it (limbs chain). ' +
    'Drag a path onto its siblings to reorder paint order, or onto another part to move ' +
    'it there (the artwork stays put). Double-click renames.';
  el.appendChild(hint);
}

function partNode(part: RigPart): HTMLElement {
  const doc = state.doc!;
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'layer-row part';
  row.dataset.partId = part.id; // unambiguous lookup — labels aren't unique (nested same-name groups)
  // A selected PATH inside this part (state.selectedPathId) is the real selection target
  // — the inspector/node scoping key off it, not the part row. Give the part row only the
  // muted "contains the selection" affordance in that case, never the full .selected fill,
  // so clicking a path never reads as "the path AND its parent are both selected."
  const pathSelectedHere = part.id === state.selectedPartId && !!state.selectedPathId;
  if (part.id === state.selectedPartId && !pathSelectedHere) row.classList.add('selected');
  else if (pathSelectedHere || state.selectedPartIds.includes(part.id)) row.classList.add('in-selection');
  if (part.hidden) row.classList.add('hidden-part');

  const isOpen = expanded.has(part.id);
  const children = [...doc.parts].reverse().filter((p) => p.parentId === part.id);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = isOpen ? '▾' : '▸';
  chevron.onclick = (ev) => {
    ev.stopPropagation();
    if (isOpen) expanded.delete(part.id);
    else expanded.add(part.id);
    notify();
  };
  row.appendChild(chevron);

  if (part.kind !== 'art' || part.skin) {
    const kindIcon = document.createElement('span');
    kindIcon.className = `layer-kind ${part.skin ? 'skin' : part.kind}`;
    // A deformed (skin-bound) art part carries the bone glyph with a "deformed by its
    // bones" tooltip; the .skin class keeps it visually distinct from a real bone part.
    kindIcon.textContent = part.skin ? '◆' : part.kind === 'bone' ? '◆' : '▣';
    kindIcon.title = part.skin ? 'deformed by its bones' : part.kind;
    row.appendChild(kindIcon);
  }

  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = part.label;
  row.appendChild(name);
  // Full label on hover — the tree column can be narrower than a long/unnamed-bone
  // label truncates to (CLAUDE.md "Editing ergonomics": always set, browsers only
  // surface `title` on overflow anyway, so detecting truncation first is pointless).
  row.title = part.label;

  const count = document.createElement('span');
  count.className = 'layer-count';
  count.textContent = children.length > 0 ? `${part.paths.length}+${children.length}` : `${part.paths.length}`;
  row.appendChild(count);

  // Layers eye: editor-only visibility, NEVER keyable — the same `part.hidden` flag in
  // both Edit and Animate, so toggling it never touches a clip's tracks (unlike the
  // keyable `opacity` channel just above it in the inspector). stopPropagation so the
  // click doesn't also run the row's select handler below.
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'layer-eye';
  eye.appendChild(icon(part.hidden ? 'eyeClosed' : 'eyeOpen'));
  eye.title = part.hidden ? 'Show this part' : 'Hide this part (editor only, never exported/keyed)';
  eye.onclick = (ev) => {
    ev.stopPropagation();
    checkpoint();
    part.hidden = !part.hidden;
    renderPose();
    notify();
  };
  row.appendChild(eye);

  row.onclick = (ev) => {
    // Shift = RANGE select between the anchor (current primary) and this row, in visible
    // (flattened, expanded-only) row order; Ctrl = toggle one row's membership; plain =
    // replace. The anchor stays put so chained Shift+clicks re-range from the same row.
    if (ev.shiftKey && state.selectedPartId) {
      const order = visiblePartOrder();
      const ai = order.indexOf(state.selectedPartId);
      const bi = order.indexOf(part.id);
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        state.selectedPartIds = order.slice(lo, hi + 1);
        state.selectedPathId = null;
      } else {
        selectPart(part.id);
        enterGroupsFor(part.id);
      }
    } else if (ev.ctrlKey && state.selectedPartIds.includes(part.id)) {
      state.selectedPartIds = state.selectedPartIds.filter((id) => id !== part.id);
      if (state.selectedPartId === part.id) {
        state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1] ?? null;
      }
    } else {
      selectPart(part.id, ev.shiftKey || ev.ctrlKey);
      // Picking a part in the tree opens its groups so canvas drags hit IT, not them.
      enterGroupsFor(part.id);
    }
    notify();
    renderPose();
  };
  row.ondblclick = (ev) => {
    ev.stopPropagation();
    beginInlineRename(row, name, part);
  };
  row.addEventListener('contextmenu', (ev) => {
    // Native-menu suppression is the ui/contextMenu.ts chokepoint's job now (capture-
    // phase on document, fires before this bubble-phase handler even runs).
    if (!state.selectedPartIds.includes(part.id)) {
      selectPart(part.id);
      enterGroupsFor(part.id);
      notify();
      renderPose();
    } else {
      state.selectedPartId = part.id;
    }
    showContextMenu(buildPartContextMenu(part), ev.clientX, ev.clientY);
  });

  // Drag to reorder (top/bottom edge = above/below) or to parent (middle); the row also
  // receives PATH drops (move a path into this part) — see layersDragAndDrop.ts.
  wirePartRowDrag(row, part);
  wirePartRowDrop(row, part, expandPart);

  li.appendChild(row);

  if (isOpen) {
    const kids = document.createElement('ul');
    kids.className = 'layer-children';
    for (const child of children) kids.appendChild(partNode(child));
    for (const path of [...part.paths].reverse()) {
      const pathLi = document.createElement('li');
      const pathRow = document.createElement('div');
      pathRow.className = 'layer-row path';
      pathRow.dataset.pathId = path.id; // unambiguous lookup, mirrors row.dataset.partId above
      if (state.selectedPathId === path.id) pathRow.classList.add('selected');
      pathRow.title = path.label; // full label on hover, same rationale as the part row above
      pathRow.innerHTML = `<span class="path-icon">◇</span>`;
      const pathName = document.createElement('span');
      pathName.className = 'layer-name';
      pathName.textContent = path.label;
      pathRow.appendChild(pathName);
      pathRow.onclick = () => {
        // Enter the part and select this object — the inspector shows its style and
        // node editing scopes to it.
        selectPart(part.id);
        state.selectedPathId = path.id;
        notify();
        renderPose();
      };
      pathRow.ondblclick = (ev) => {
        ev.stopPropagation();
        beginInlineRename(pathRow, pathName, path);
      };
      pathRow.addEventListener('contextmenu', (ev) => {
        // See the part row's contextmenu handler above — suppression is the chokepoint's
        // job, not this listener's.
        selectPart(part.id);
        state.selectedPathId = path.id;
        notify();
        renderPose();
        showContextMenu(
          buildPathContextMenu(part, path, ev.clientX, ev.clientY, () => beginInlineRename(pathRow, pathName, path)),
          ev.clientX, ev.clientY,
        );
      });
      wirePathRowDrag(pathRow, part, path);
      wirePathRowDrop(pathRow, part, path);
      pathLi.appendChild(pathRow);
      kids.appendChild(pathLi);
    }
    li.appendChild(kids);
  }
  return li;
}

/**
 * Swap `labelEl` for a text input in place (VS Code-style inline rename): select-all on
 * open, Enter commits with a checkpoint, Escape cancels, blur commits. A no-op rename
 * (empty or unchanged) just reverts the DOM without touching history.
 */
function beginInlineRename(row: HTMLElement, labelEl: HTMLElement, target: { label: string }): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'layer-rename-input';
  input.value = target.label;
  row.replaceChild(input, labelEl);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    input.removeEventListener('blur', commit);
    const val = input.value.trim().replace(/\s+/g, '_');
    if (val && val !== target.label) {
      checkpoint();
      target.label = val;
      notify(); // full rebuild replaces `row`; no need to restore labelEl ourselves
    } else if (input.isConnected) {
      row.replaceChild(labelEl, input);
    }
  };
  const cancel = () => {
    if (done) return;
    done = true;
    input.removeEventListener('blur', commit);
    row.replaceChild(labelEl, input);
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // don't let '%'/tool-key/etc. shortcuts fire while typing
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}
