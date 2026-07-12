/**
 * Layers panel: a folder-style tree — parts nest under their parent part (bone
 * hierarchy) and each part folds open to show the SVG objects (paths) inside it. Drag
 * a part onto another to parent it; drop it on the "un-parent" strip to detach.
 * Double-click renames (names carry through into exported files).
 */

import {
  state, notify, selectedPart, selectPart, setParent, movePartRelativeTo,
  ancestorChain, moveSelectedInDrawOrder, RigPart, RigPath,
} from '../core/model';
import { renderPose, reorderCanvas, enterGroupsFor, syncPartPathDom } from '../view';
import { checkpoint } from '../core/history';
import { dialog } from '../ui/dialogs';
import { showContextMenu } from '../ui/contextMenu';
import { buildPartContextMenu } from '../ui/actions';
import { icon } from './icons';

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
  wireDropTarget(unparent, null);
  el.appendChild(unparent);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Click ▸ to fold parts open. Drag one part onto another to parent it (limbs chain). ' +
    'Drag a path onto its siblings to reorder paint order within the part. Double-click renames.';
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
    ev.preventDefault();
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

  // Drag to reorder (top/bottom edge = above/below) or to parent (middle).
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('text/rig-part', part.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  wirePartRowDrop(row, part);

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
      pathRow.draggable = true;
      pathRow.addEventListener('dragstart', (ev) => {
        ev.stopPropagation();
        draggingPath = { partId: part.id, pathId: path.id };
        ev.dataTransfer?.setData('text/rig-path', path.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      pathRow.addEventListener('dragend', () => { draggingPath = null; });
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

/** Accept part drags; newParentId null = detach. */
function wireDropTarget(el: HTMLElement, newParentId: string | null): void {
  el.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drop-target');
    const childId = ev.dataTransfer?.getData('text/rig-part');
    if (!childId || childId === newParentId) return;
    checkpoint();
    if (!setParent(childId, newParentId)) {
      void dialog.alert('Cannot parent a part to its own descendant.');
      return;
    }
    if (newParentId) expanded.add(newParentId);
    notify();
    renderPose();
  });
}

const DROP_CLASSES = ['drop-target', 'drop-above', 'drop-below'];

/** Which drop action the pointer position means: near the edges reorders, middle parents. */
function dropZoneOf(ev: DragEvent, el: HTMLElement): 'above' | 'into' | 'below' {
  const r = el.getBoundingClientRect();
  const f = (ev.clientY - r.top) / r.height;
  if (f < 0.25) return 'above';
  if (f > 0.75) return 'below';
  return 'into';
}

/**
 * Part rows accept three drops: top edge = draw just above this part, bottom edge =
 * just below (both adopt this part's parent — sibling insertion), middle = parent
 * the dragged part into this one.
 */
function wirePartRowDrop(row: HTMLElement, part: RigPart): void {
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.toggle('drop-target', zone === 'into');
    row.classList.toggle('drop-above', zone === 'above');
    row.classList.toggle('drop-below', zone === 'below');
  });
  row.addEventListener('dragleave', () => row.classList.remove(...DROP_CLASSES));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.remove(...DROP_CLASSES);
    const draggedId = ev.dataTransfer?.getData('text/rig-part');
    if (!draggedId || draggedId === part.id) return;
    checkpoint();
    const ok = zone === 'into'
      ? setParent(draggedId, part.id)
      : movePartRelativeTo(draggedId, part.id, zone);
    if (!ok) {
      void dialog.alert('That drop would create a parenting cycle.');
      return;
    }
    if (zone === 'into') expanded.add(part.id);
    reorderCanvas();
    notify();
  });
}

// ---- Path reordering (drag within a part's own paths) ----

/**
 * The path currently mid-drag, tracked in-module. `dataTransfer.getData` is only readable
 * on 'drop' (browsers protect it during dragover/dragenter), but the drop feedback and the
 * same-part gate both need to know the source RIGHT AWAY as the pointer crosses rows — so
 * dragstart stashes it here and every path row's dragover/drop reads it back. dragend always
 * fires (success, cancel, or drop-elsewhere) so this can't get stuck set.
 */
let draggingPath: { partId: string; pathId: string } | null = null;

/** Paths don't nest, so there's no "into" zone — just above/below, split at the row's midline. */
function pathDropZoneOf(ev: DragEvent, el: HTMLElement): 'above' | 'below' {
  const r = el.getBoundingClientRect();
  return (ev.clientY - r.top) / r.height < 0.5 ? 'above' : 'below';
}

/**
 * The `part.paths` (model-order) index the dragged path should land at for a drop at `zone`
 * relative to `refPathId`, computed in the ON-SCREEN list order the tree actually renders
 * (`[...part.paths].reverse()` — row 0 = last in the array = topmost/drawn-last, mirroring
 * the parts tree's own topmost-first convention). Pure; returns -1 if either id is missing.
 */
function pathDropTargetIndex(
  part: RigPart, draggedId: string, refPathId: string, zone: 'above' | 'below',
): number {
  const visual = [...part.paths].reverse();
  const n = visual.length;
  const srcV = visual.findIndex((p) => p.id === draggedId);
  const refV = visual.findIndex((p) => p.id === refPathId);
  if (srcV < 0 || refV < 0) return -1;
  const withoutSrc = visual.filter((_, i) => i !== srcV);
  let insertV = withoutSrc.findIndex((p) => p.id === refPathId);
  if (zone === 'below') insertV += 1;
  return n - 1 - insertV;
}

/**
 * Move `pathId` to `targetIndex` within `part.paths` by reusing the EXACT adjacent-swap
 * mutation PageUp/PageDown drives on an entered path (`moveSelectedInDrawOrder`), one step
 * at a time — a drag reorder ends up byte-identical to pressing that key N times rather than
 * a second array-splice mutation. Temporarily borrows the entered-path selection to drive
 * it (that function reads `state.selectedPartId`/`selectedPathId`), then restores whatever
 * was selected before the drag — a reorder drag doesn't change selection, matching
 * `wirePartRowDrop`'s reorder branch above.
 */
function movePathTo(part: RigPart, pathId: string, targetIndex: number): boolean {
  const from = part.paths.findIndex((p) => p.id === pathId);
  if (from < 0 || targetIndex < 0 || targetIndex >= part.paths.length) return false;
  const prevPartId = state.selectedPartId;
  const prevPathId = state.selectedPathId;
  state.selectedPartId = part.id;
  state.selectedPathId = pathId;
  const step = targetIndex > from ? 1 : -1;
  let i = from;
  let ok = true;
  while (i !== targetIndex) {
    if (!moveSelectedInDrawOrder(step)) { ok = false; break; }
    i += step;
  }
  state.selectedPartId = prevPartId;
  state.selectedPathId = prevPathId;
  return ok;
}

/**
 * Path rows accept drops from another path row of the SAME part only. Paths live baked
 * into their part's frame, so a cross-part move would teleport geometry (a future "extract
 * path to part" op is the real answer — out of scope here). A cross-part hover never claims
 * the dragover (no preventDefault), so the browser shows its native "can't drop here" cursor
 * and no 'drop' event fires at all — the rejection is a structural non-event, not a branch
 * that could accidentally mutate.
 */
function wirePathRowDrop(row: HTMLElement, part: RigPart, path: RigPath): void {
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-path')) return;
    if (!draggingPath || draggingPath.partId !== part.id || draggingPath.pathId === path.id) return;
    ev.preventDefault();
    const zone = pathDropZoneOf(ev, row);
    row.classList.toggle('drop-above', zone === 'above');
    row.classList.toggle('drop-below', zone === 'below');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    const dragged = draggingPath;
    draggingPath = null;
    if (!dragged || dragged.partId !== part.id || dragged.pathId === path.id) return;
    const zone = pathDropZoneOf(ev, row);
    const from = part.paths.findIndex((p) => p.id === dragged.pathId);
    const targetIndex = pathDropTargetIndex(part, dragged.pathId, path.id, zone);
    if (targetIndex < 0 || targetIndex === from) return; // no-op drop: nothing to checkpoint
    checkpoint();
    if (!movePathTo(part, dragged.pathId, targetIndex)) return;
    syncPartPathDom(part);
    renderPose();
    notify();
  });
}
