/**
 * Layers-panel drag-and-drop wiring — every dragstart/dragover/drop handler the tree's
 * rows carry. Split out of layers.ts (CLAUDE.md "Small, focused files"); layers.ts keeps
 * tree building + inline rename and calls the wire* functions below on each row it makes.
 *
 * The system is a 2×2 ACCEPTANCE TABLE (payload type × row kind), each cell one branch:
 *
 *   | payload \ target  | PART row                        | PATH row                    |
 *   |-------------------|---------------------------------|-----------------------------|
 *   | `text/rig-part`   | reparent / sibling-reorder      | (not accepted)              |
 *   | `text/rig-path`   | move path INTO the part         | reorder (same part) or move |
 *   |                   | (append last = topmost);        | with above/below insertion  |
 *   |                   | own part row = send to top      | (cross part)                |
 *
 * Cross-part path moves go through the view facade's `movePathToPart` (render-neutral
 * frame rebake) and are gated by its `pathMoveRefusal` CHOKEPOINT — the dragover shows
 * the refusal as the row's title and withholds both preventDefault and the drop-zone
 * class, so the browser shows its native "can't drop here" cursor and no 'drop' event
 * fires at all: the rejection is a structural non-event, not a branch that could
 * accidentally mutate. Same-part path reordering is untouched (byte-identical to the
 * pre-split behavior).
 *
 * A PART drop that reparents (`wireDropTarget`'s un-parent strip, `wirePartRowDrop`'s
 * "into" zone) tries the view facade's `reattachRootBone` FIRST (Unified Skeleton Phase
 * 1: a chain-root bone dropped onto another chain's bone, or an already-attached root
 * dropped back to the un-parent strip, reparents world-preservingly instead of jumping)
 * and falls back to plain `setParent` when it declines (every other drag combination —
 * see that function's doc comment for the exact gesture table) — `reattachRootBone(...)
 * || setParent(...)` is safe to chain unconditionally: a decline never mutates, and a
 * cycle refusal inside `reattachRootBone` leaves `setParent`'s own cycle check to fail
 * (and message) identically.
 */

import {
  state, selectPart, setParent, movePartRelativeTo, moveSelectedInDrawOrder, notify,
  RigPart, RigPath,
} from '../core/model';
import { checkpoint } from '../core/history';
import { dialog } from '../ui/dialogs';
import {
  renderPose, syncPartPathDom, reorderCanvas, movePathToPart, pathMoveRefusal,
  reattachRootBone,
} from '../view';

/** Reparent `draggedId` onto `newParentId` for a Layers drop — see the module doc. */
function reparentForDrop(draggedId: string, newParentId: string | null): boolean {
  const dragged = state.doc?.parts.find((p) => p.id === draggedId);
  return (!!dragged && reattachRootBone(dragged, newParentId)) || setParent(draggedId, newParentId);
}

/** Opens a part's folder in the tree (layers.ts owns the `expanded` set). */
export type ExpandPart = (partId: string) => void;

// ---- Part-row drags (text/rig-part) ----

/** Make a part row a drag source. */
export function wirePartRowDrag(row: HTMLElement, part: RigPart): void {
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('text/rig-part', part.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
}

/** Accept part drags; newParentId null = detach. */
export function wireDropTarget(el: HTMLElement, newParentId: string | null, expand: ExpandPart): void {
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
    if (!reparentForDrop(childId, newParentId)) {
      void dialog.alert('Cannot parent a part to its own descendant.');
      return;
    }
    if (newParentId) expand(newParentId);
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
 * Part rows accept three drops from ANOTHER PART: top edge = draw just above this part,
 * bottom edge = just below (both adopt this part's parent — sibling insertion), middle =
 * parent the dragged part into this one. They also accept a PATH drag (see the acceptance
 * table in the module doc): the whole row is one "into" zone — the path is appended last
 * in this part's paints (topmost within the part), render-neutrally; dropping a path on
 * its OWN part's header row sends it to the top of that same paint order.
 */
export function wirePartRowDrop(row: HTMLElement, part: RigPart, expand: ExpandPart): void {
  row.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('text/rig-path')) {
      pathOverPartRow(ev, row, part);
      return;
    }
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.toggle('drop-target', zone === 'into');
    row.classList.toggle('drop-above', zone === 'above');
    row.classList.toggle('drop-below', zone === 'below');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove(...DROP_CLASSES);
    row.title = '';
  });
  row.addEventListener('drop', (ev) => {
    if (draggingPath) {
      pathDropOnPartRow(ev, row, part, expand);
      return;
    }
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.remove(...DROP_CLASSES);
    const draggedId = ev.dataTransfer?.getData('text/rig-part');
    if (!draggedId || draggedId === part.id) return;
    checkpoint();
    const ok = zone === 'into'
      ? reparentForDrop(draggedId, part.id)
      : movePartRelativeTo(draggedId, part.id, zone);
    if (!ok) {
      void dialog.alert('That drop would create a parenting cycle.');
      return;
    }
    if (zone === 'into') expand(part.id);
    reorderCanvas();
    notify();
  });
}

// ---- Path drags (text/rig-path): same-part reorder + cross-part move ----

/**
 * The path currently mid-drag, tracked in-module. `dataTransfer.getData` is only readable
 * on 'drop' (browsers protect it during dragover/dragenter), but the drop feedback and the
 * same-part-vs-cross-part split both need to know the source RIGHT AWAY as the pointer
 * crosses rows — so dragstart stashes it here and every row's dragover/drop reads it back.
 * dragend always fires (success, cancel, or drop-elsewhere) so this can't get stuck set.
 */
let draggingPath: { partId: string; pathId: string } | null = null;

/** The mid-drag source path's PART, or null when no path drag is live. */
function draggingPathSource(): RigPart | null {
  if (!draggingPath) return null;
  return state.doc?.parts.find((p) => p.id === draggingPath!.partId) ?? null;
}

/** Make a path row a drag source (tracks the live drag for the acceptance table). */
export function wirePathRowDrag(row: HTMLElement, part: RigPart, path: RigPath): void {
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.stopPropagation();
    draggingPath = { partId: part.id, pathId: path.id };
    ev.dataTransfer?.setData('text/rig-path', path.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => { draggingPath = null; });
}

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
 * The `dest.paths` (model-order) index an INCOMING path (not currently in `dest`) should
 * land at for a drop at `zone` relative to `refPathId` — the cross-part sibling of
 * pathDropTargetIndex above, in the same on-screen (reversed) list convention. After the
 * insert the array has length n+1, so visual slot `insertV` is model index `n − insertV`.
 * Pure; returns -1 if the reference row's path is missing.
 */
function crossPartDropIndex(dest: RigPart, refPathId: string, zone: 'above' | 'below'): number {
  const visual = [...dest.paths].reverse();
  const refV = visual.findIndex((p) => p.id === refPathId);
  if (refV < 0) return -1;
  const insertV = refV + (zone === 'below' ? 1 : 0);
  return dest.paths.length - insertV;
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

/** A path drag hovering a part row: claim it (drop-target highlight) unless refused. */
function pathOverPartRow(ev: DragEvent, row: HTMLElement, part: RigPart): void {
  const src = draggingPathSource();
  if (!src) return;
  if (src.id !== part.id) {
    const refusal = pathMoveRefusal(src, part);
    if (refusal) {
      // No preventDefault → the browser keeps its native "can't drop here" cursor and no
      // 'drop' fires; the title is the visible WHY (the visible-counterpart GOTCHA).
      row.title = refusal;
      return;
    }
  }
  ev.preventDefault();
  row.classList.add('drop-target');
}

/** A path dropped on a part row: cross-part move (append last) / own-row send-to-top. */
function pathDropOnPartRow(ev: DragEvent, row: HTMLElement, part: RigPart, expand: ExpandPart): void {
  ev.preventDefault();
  row.classList.remove(...DROP_CLASSES);
  row.title = '';
  const dragged = draggingPath;
  draggingPath = null;
  if (!dragged) return;
  const src = state.doc?.parts.find((p) => p.id === dragged.partId);
  if (!src) return;
  if (src.id === part.id) {
    // Own header row = send the path to the TOP of its own paint order (append last),
    // through the same one-step mutation family as sibling reordering.
    const from = part.paths.findIndex((p) => p.id === dragged.pathId);
    const top = part.paths.length - 1;
    if (from < 0 || from === top) return; // no-op drop: nothing to checkpoint
    checkpoint();
    if (!movePathTo(part, dragged.pathId, top)) return;
    syncPartPathDom(part);
    renderPose();
    notify();
    return;
  }
  if (pathMoveRefusal(src, part) !== null) return; // refused hovers never claim, but re-guard
  checkpoint();
  if (!movePathToPart(src, part, dragged.pathId)) return;
  // The moved path stays the working selection in its NEW part (entered-part semantics,
  // like clicking its row); the folder opens so the landing spot is visible.
  selectPart(part.id);
  state.selectedPathId = dragged.pathId;
  expand(part.id);
  notify();
}

/**
 * Path rows accept drops from any other path row: SAME part = reorder that part's own
 * paint order (unchanged behavior); ANOTHER part = move the path into this part at the
 * above/below insertion point, render-neutrally via `movePathToPart` (unless
 * `pathMoveRefusal` refuses — skinned source/destination or a bone).
 */
export function wirePathRowDrop(row: HTMLElement, part: RigPart, path: RigPath): void {
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-path')) return;
    const src = draggingPathSource();
    if (!src || draggingPath!.pathId === path.id) return; // a row never targets its own drag
    if (src.id !== part.id) {
      const refusal = pathMoveRefusal(src, part);
      if (refusal) {
        row.title = refusal; // see pathOverPartRow — same structural non-event rejection
        return;
      }
    }
    ev.preventDefault();
    const zone = pathDropZoneOf(ev, row);
    row.classList.toggle('drop-above', zone === 'above');
    row.classList.toggle('drop-below', zone === 'below');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
    row.title = '';
  });
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    row.title = '';
    const dragged = draggingPath;
    draggingPath = null;
    if (!dragged || dragged.pathId === path.id) return;
    const zone = pathDropZoneOf(ev, row);
    if (dragged.partId === part.id) {
      const from = part.paths.findIndex((p) => p.id === dragged.pathId);
      const targetIndex = pathDropTargetIndex(part, dragged.pathId, path.id, zone);
      if (targetIndex < 0 || targetIndex === from) return; // no-op drop: nothing to checkpoint
      checkpoint();
      if (!movePathTo(part, dragged.pathId, targetIndex)) return;
      syncPartPathDom(part);
      renderPose();
      notify();
      return;
    }
    const src = state.doc?.parts.find((p) => p.id === dragged.partId);
    if (!src || pathMoveRefusal(src, part) !== null) return;
    const destIndex = crossPartDropIndex(part, path.id, zone);
    if (destIndex < 0) return;
    checkpoint();
    if (!movePathToPart(src, part, dragged.pathId, destIndex)) return;
    selectPart(part.id); // moved path stays selected in its NEW part (see pathDropOnPartRow)
    state.selectedPathId = dragged.pathId;
    notify();
  });
}
