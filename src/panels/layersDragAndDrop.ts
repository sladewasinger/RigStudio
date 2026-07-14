/**
 * Layers-panel drag-and-drop wiring — every dragstart/dragover/drop handler the tree's
 * rows carry. Split out of layers.ts (CLAUDE.md "Small, focused files"); layers.ts keeps
 * tree building + inline rename and calls the wire* functions below on each row it makes.
 * The pure "what should this drop do" math lives in `layersDropRules.ts` (U4); this
 * module only dispatches events, shows feedback, and executes the returned plan.
 *
 * The system is a 2×2 ACCEPTANCE TABLE (payload type × row kind); since U4 every cell
 * supports EDGE zones (sibling insertion at the exact slot — paths and parts interleave,
 * so "sibling" means the mixed row list of the reference row's container):
 *
 *   | payload \ target  | PART row                          | PATH row                    |
 *   |-------------------|-----------------------------------|-----------------------------|
 *   | `text/rig-part`   | edges: sibling slot insertion     | edges: become a CHILD of    |
 *   |                   | (root rows: block splice);        | the path's owner, slotted   |
 *   |                   | middle: parent INTO (append top)  | between its rows            |
 *   | `text/rig-path`   | edges: sibling slot insertion in  | edges: reorder (same part)  |
 *   |                   | the row's own container (root     | or cross-part move at the   |
 *   |                   | rows REFUSE — see layersDropRules |exact slot                  |
 *   |                   | for the Inkscape rule); middle:   |                             |
 *   |                   | move INTO (append topmost); own   |                             |
 *   |                   | header row = send to top          |                             |
 *
 * Cross-part path moves go through the view facade's `movePathToPart` (render-neutral
 * frame rebake) and are gated by its `pathMoveRefusal` CHOKEPOINT — a refused (or
 * structurally illegal) PATH hover shows the reason as the row's title and withholds
 * both preventDefault and the drop-zone class, so the browser shows its native "can't
 * drop here" cursor and no 'drop' event fires at all: the rejection is a structural
 * non-event, not a branch that could accidentally mutate. Same-container reorders go
 * through `core/slotReorder.ts`'s `moveChildSlot` — the one chokepoint every slot-space
 * gesture funnels through (PageUp/PageDown and the stacking arrows share it).
 *
 * A PART drop that reparents (`wireDropTarget`'s un-parent strip, `wirePartRowDrop`'s
 * "into" zone) tries the view facade's `reattachRootBone` FIRST (Unified Skeleton Phase
 * 1: a chain-root bone dropped onto another chain's bone, or an already-attached root
 * dropped back to the un-parent strip, reparents world-preservingly instead of jumping)
 * and falls back to plain `setParent` when it declines — `reattachRootBone(...) ||
 * setParent(...)` is safe to chain unconditionally: a decline never mutates, and a cycle
 * refusal inside `reattachRootBone` leaves `setParent`'s own cycle check to fail (and
 * message) identically. EDGE drops stay plain `setParent` sibling insertion (pre-U4
 * parity — attach semantics remain an explicitly "into"-shaped gesture).
 */

import {
  state, selectPart, setParent, movePartRelativeTo, moveChildSlot, notify,
  RigPart, RigPath,
} from '../core/model';
import { checkpoint } from '../core/history';
import { dialog } from '../ui/dialogs';
import {
  renderPose, syncPartPathDom, reorderCanvas, movePathToPart, pathMoveRefusal,
  reattachRootBone,
} from '../view';
import {
  DropZone, SlotDropPlan, planPartEdgeDrop, planPathEdgeDrop, planPathToTop,
} from './layersDropRules';

/** Reparent `draggedId` onto `newParentId` for a Layers "into" drop — see the module doc. */
function reparentForDrop(draggedId: string, newParentId: string | null): boolean {
  const dragged = state.doc?.parts.find((p) => p.id === draggedId);
  return (!!dragged && reattachRootBone(dragged, newParentId)) || setParent(draggedId, newParentId);
}

/** Opens a part's folder in the tree (layers.ts owns the `expanded` set). */
export type ExpandPart = (partId: string) => void;

/**
 * Execute a resolved drop plan (one checkpoint per real mutation; 'none' and 'refuse'
 * never touch history). Returns false for a refusal so PART-payload callers can surface
 * their dialog (path payloads never reach here refused — their hover was never claimed).
 */
function executePlan(plan: SlotDropPlan, expand: ExpandPart): boolean {
  switch (plan.kind) {
    case 'none':
      return true;
    case 'refuse':
      return false;
    case 'reorder': {
      checkpoint();
      if (!moveChildSlot(plan.container, plan.slotId, plan.toIndex)) return true;
      // A slot crossing a slot of the other kind restructures the container's paint
      // RUNS — rebuild them, then the global re-append (which also repaints).
      syncPartPathDom(plan.container);
      reorderCanvas();
      notify();
      return true;
    }
    case 'movePath': {
      checkpoint();
      if (!movePathToPart(plan.src, plan.dest, plan.pathId, plan.pathsIndex, plan.slotIndex)) return true;
      // The moved path stays the working selection in its NEW part (entered-part
      // semantics, like clicking its row).
      selectPart(plan.dest.id);
      state.selectedPathId = plan.pathId;
      expand(plan.dest.id);
      reorderCanvas();
      notify();
      return true;
    }
    case 'reparentAtSlot': {
      checkpoint();
      if (!setParent(plan.partId, plan.container.id)) return false; // cycle (pre-checked; defensive)
      moveChildSlot(plan.container, plan.partId, plan.toIndex);
      syncPartPathDom(plan.container);
      expand(plan.container.id);
      reorderCanvas();
      notify();
      return true;
    }
    case 'rootRelative': {
      checkpoint();
      if (!movePartRelativeTo(plan.partId, plan.refId, plan.place)) return false;
      reorderCanvas();
      notify();
      return true;
    }
  }
}

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
function dropZoneOf(ev: DragEvent, el: HTMLElement): DropZone | 'into' {
  const r = el.getBoundingClientRect();
  const f = (ev.clientY - r.top) / r.height;
  if (f < 0.25) return 'above';
  if (f > 0.75) return 'below';
  return 'into';
}

function showZoneFeedback(row: HTMLElement, zone: DropZone | 'into'): void {
  row.classList.toggle('drop-target', zone === 'into');
  row.classList.toggle('drop-above', zone === 'above');
  row.classList.toggle('drop-below', zone === 'below');
}

/**
 * Part rows accept three drops from ANOTHER PART: top/bottom edge = sibling slot
 * insertion just above/below this row, middle = parent the dragged part into this one.
 * They also accept a PATH drag (see the acceptance table): edges = sibling slot
 * insertion in THIS row's container (refused at the root level), middle = move the path
 * into this part appended last (topmost); a path's own part header row sends it to the
 * top of that same part.
 */
export function wirePartRowDrop(row: HTMLElement, part: RigPart, expand: ExpandPart): void {
  row.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('text/rig-path')) {
      pathOverPartRow(ev, row, part);
      return;
    }
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    showZoneFeedback(row, dropZoneOf(ev, row));
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove(...DROP_CLASSES);
    row.title = part.label; // restore the full-label hover (layers.ts sets it)
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
    if (zone === 'into') {
      checkpoint();
      if (!reparentForDrop(draggedId, part.id)) {
        void dialog.alert('That drop would create a parenting cycle.');
        return;
      }
      expand(part.id);
      reorderCanvas();
      notify();
      return;
    }
    if (!executePlan(planPartEdgeDrop(draggedId, { part }, zone), expand)) {
      void dialog.alert('That drop would create a parenting cycle.');
    }
  });
}

// ---- Path drags (text/rig-path): slot reorders + cross-part moves ----

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

/** Paths don't nest, so a PATH ROW has no "into" zone — just above/below at the midline.
 *  (A part row keeps its three zones — see dropZoneOf.) Also the zone rule for a PART
 *  payload over a path row: a part can't go "into" a path either. */
function pathDropZoneOf(ev: DragEvent, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  return (ev.clientY - r.top) / r.height < 0.5 ? 'above' : 'below';
}

/** Resolve the plan a PATH drag over/onto a part row's zone means: edges = sibling slot
 *  insertion in this row's container, middle = move INTO this part (own header row =
 *  send to top). */
function pathOnPartRowPlan(src: RigPart, pathId: string, part: RigPart, zone: DropZone | 'into'): SlotDropPlan {
  if (zone !== 'into') return planPathEdgeDrop(src, pathId, { part }, zone);
  if (src.id === part.id) return planPathToTop(src, pathId);
  return planPathIntoPart(src, pathId, part);
}

/** Middle drop on a foreign part row: move INTO, appended last = topmost (pre-U4 parity —
 *  the slot appends after EVERY existing slot, which on an interleaved destination is not
 *  the raw `paths.length` position the old code assumed). */
function planPathIntoPart(src: RigPart, pathId: string, dest: RigPart): SlotDropPlan {
  const refusal = pathMoveRefusal(src, dest);
  if (refusal) return { kind: 'refuse', reason: refusal };
  return {
    kind: 'movePath', src, dest, pathId,
    pathsIndex: dest.paths.length,
    slotIndex: dest.childOrder?.length ?? dest.paths.length,
  };
}

/** A path drag hovering a part row: claim it (zone feedback) unless the plan refuses. */
function pathOverPartRow(ev: DragEvent, row: HTMLElement, part: RigPart): void {
  const src = draggingPathSource();
  if (!src) return;
  const zone = dropZoneOf(ev, row);
  const plan = pathOnPartRowPlan(src, draggingPath!.pathId, part, zone);
  if (plan.kind === 'refuse') {
    // No preventDefault → the browser keeps its native "can't drop here" cursor and no
    // 'drop' fires; the title is the visible WHY (the visible-counterpart GOTCHA).
    row.classList.remove(...DROP_CLASSES);
    row.title = plan.reason;
    return;
  }
  ev.preventDefault();
  showZoneFeedback(row, zone);
}

/** A path dropped on a part row: execute whatever the hover's plan said. */
function pathDropOnPartRow(ev: DragEvent, row: HTMLElement, part: RigPart, expand: ExpandPart): void {
  ev.preventDefault();
  row.classList.remove(...DROP_CLASSES);
  row.title = part.label;
  const dragged = draggingPath;
  draggingPath = null;
  if (!dragged) return;
  const src = state.doc?.parts.find((p) => p.id === dragged.partId);
  if (!src) return;
  const plan = pathOnPartRowPlan(src, dragged.pathId, part, dropZoneOf(ev, row));
  executePlan(plan, expand); // refused hovers never claim; a fabricated drop no-ops here
}

/**
 * Path rows accept drops from any other path row (SAME part = slot reorder, ANOTHER
 * part = cross-part move at the exact slot, render-neutrally via `movePathToPart` unless
 * `pathMoveRefusal` refuses) AND from part rows (the dragged part becomes a CHILD of
 * this path's owner, slotted just above/below this row — the "drag a part between two
 * paths" gesture).
 */
export function wirePathRowDrop(row: HTMLElement, part: RigPart, path: RigPath): void {
  const planFor = (ev: DragEvent): SlotDropPlan | null => {
    const zone = pathDropZoneOf(ev, row);
    if (draggingPath) {
      const src = draggingPathSource();
      if (!src || draggingPath.pathId === path.id) return null; // a row never targets its own drag
      return planPathEdgeDrop(src, draggingPath.pathId, { ownerPart: part, pathId: path.id }, zone);
    }
    if (ev.dataTransfer?.types.includes('text/rig-part')) {
      // dataTransfer's payload is unreadable during dragover — but the drop id is all
      // the DROP needs, and the hover only needs "some part is being dragged".
      const draggedId = ev.dataTransfer.getData('text/rig-part');
      if (!draggedId) return { kind: 'none' }; // hover: claim; the drop re-plans with the real id
      return planPartEdgeDrop(draggedId, { ownerPart: part, pathId: path.id }, zone);
    }
    return null;
  };
  row.addEventListener('dragover', (ev) => {
    const plan = planFor(ev);
    if (plan === null) return;
    if (plan.kind === 'refuse') {
      row.classList.remove('drop-above', 'drop-below');
      row.title = plan.reason; // structural non-event rejection — see pathOverPartRow
      return;
    }
    ev.preventDefault();
    showZoneFeedback(row, pathDropZoneOf(ev, row));
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
    row.title = path.label; // restore the full-label hover (layers.ts sets it)
  });
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    row.title = path.label;
    const wasPathDrag = !!draggingPath;
    const plan = planFor(ev);
    draggingPath = null;
    if (plan === null) return;
    const ok = executePlan(plan, () => {});
    if (!ok && !wasPathDrag) void dialog.alert('That drop would create a parenting cycle.');
  });
}
