/**
 * Pure drop-position rules for the Layers tree (U4 — unified child ordering): given a
 * payload (a dragged path or part), a reference ROW (any sibling row — path or part) and
 * an above/below zone, resolve WHAT should happen as a plan object; the DOM wiring in
 * `layersDragAndDrop.ts` only dispatches events and executes plans. Every slot number
 * here speaks `core/slotReorder.ts`'s `moveChildSlot` convention: POST-REMOVAL index
 * space, where "visually just above row R" = the slot index after R and "just below" =
 * R's own index (the tree renders slots reversed — top row = last slot = topmost paint).
 *
 * THE INKSCAPE EDGE-DROP RULE (U4 decision, documented here): an edge drop makes the
 * dragged row a SIBLING of the reference row — it lands in the reference row's own
 * CONTAINER at that position. For a part row the container is its parent part (or the
 * root level); for a path row it is the path's owning part. Consequences:
 *  - a path dropped at the edge of a NON-sibling row moves cross-part into that row's
 *    container (`movePathToPart`, render-neutral) at the exact slot;
 *  - a path dropped between two ROOT part rows is REFUSED with a visible reason (a
 *    `RigPath` can only live inside a part — Inkscape would let objects sit at the SVG
 *    root, but this model has no root-level geometry; refusing with guidance beats
 *    silently changing which part owns the path, since the row-middle "into" drop is
 *    always available for that);
 *  - a PART dropped at the edge of a path row becomes a CHILD of the path's owner,
 *    slotted between its rows (the "drag a part between two paths" gesture).
 */
import {
  RigPart, effectiveChildOrder, isAncestorOf, state,
} from '../core/model';
import { pathMoveRefusal } from '../view';

export type DropZone = 'above' | 'below';

export type SlotDropPlan =
  /** Same-container slot reorder — `moveChildSlot(container, slotId, toIndex)`. */
  | { kind: 'reorder'; container: RigPart; slotId: string; toIndex: number }
  /** Cross-part path move — `movePathToPart(src, dest, pathId, pathsIndex, slotIndex)`. */
  | {
      kind: 'movePath';
      src: RigPart; dest: RigPart; pathId: string;
      pathsIndex: number; slotIndex: number;
    }
  /** Part becomes `container`'s child at `toIndex` — setParent (if needed) + moveChildSlot. */
  | { kind: 'reparentAtSlot'; partId: string; container: RigPart; toIndex: number }
  /** Root-level part edge drop — no container childOrder; `movePartRelativeTo`. */
  | { kind: 'rootRelative'; partId: string; refId: string; place: DropZone }
  /** Structurally illegal — the wiring shows `reason` and never claims the hover. */
  | { kind: 'refuse'; reason: string }
  /** Nothing to do (self-drop / would land where it started) — no checkpoint. */
  | { kind: 'none' };

const ROOT_PATH_REFUSAL =
  'A path can only live inside a part — drop it ONTO a part row to move it in there.';

/** The container part a row's SIBLINGS live in: a path row's owner, a part row's parent
 *  (null = the root level). */
function rowContainer(row: { ownerPart: RigPart } | { part: RigPart }): RigPart | null {
  if ('ownerPart' in row) return row.ownerPart;
  return row.part.parentId
    ? state.doc?.parts.find((p) => p.id === row.part.parentId) ?? null
    : null;
}

/** A reference row in the tree, as the drop wiring sees it. */
export type ReferenceRow =
  | { ownerPart: RigPart; pathId: string } // a path row (owner = the part holding it)
  | { part: RigPart };                     // a part row

function refSlotIdOf(row: ReferenceRow): string {
  return 'pathId' in row ? row.pathId : row.part.id;
}

/** Target slot index in `container` for landing NEXT TO `refSlotId` at `zone`, in
 *  post-removal space: the effective order WITHOUT the dragged slot (when present), the
 *  reference row's index in that list, +1 for visually-above. -1 when the reference has
 *  no slot (shouldn't happen on a coherent doc — callers bail). */
function targetSlotIndex(
  container: RigPart, draggedSlotId: string, refSlotId: string, zone: DropZone,
): number {
  const doc = state.doc!;
  const withoutDragged = effectiveChildOrder(container, doc.parts)
    .filter((s) => s.id !== draggedSlotId);
  const refIndex = withoutDragged.findIndex((s) => s.id === refSlotId);
  if (refIndex < 0) return -1;
  return zone === 'above' ? refIndex + 1 : refIndex;
}

/** Whether the resolved reorder would land the slot exactly where it already sits. */
function reorderIsNoOp(container: RigPart, slotId: string, toIndex: number): boolean {
  const order = effectiveChildOrder(container, state.doc!.parts);
  const from = order.findIndex((s) => s.id === slotId);
  return from < 0 || Math.max(0, Math.min(toIndex, order.length - 1)) === from;
}

/** A PATH dropped at the edge of any sibling-candidate row. */
export function planPathEdgeDrop(
  src: RigPart, pathId: string, ref: ReferenceRow, zone: DropZone,
): SlotDropPlan {
  const container = rowContainer(ref);
  if (!container) return { kind: 'refuse', reason: ROOT_PATH_REFUSAL };
  const refSlotId = refSlotIdOf(ref);
  if (refSlotId === pathId) return { kind: 'none' }; // a row never targets its own drag
  if (container.id === src.id) {
    const toIndex = targetSlotIndex(container, pathId, refSlotId, zone);
    if (toIndex < 0 || reorderIsNoOp(container, pathId, toIndex)) return { kind: 'none' };
    return { kind: 'reorder', container, slotId: pathId, toIndex };
  }
  const refusal = pathMoveRefusal(src, container);
  if (refusal) return { kind: 'refuse', reason: refusal };
  const slotIndex = targetSlotIndex(container, pathId, refSlotId, zone);
  if (slotIndex < 0) return { kind: 'none' };
  const pathsIndex = effectiveChildOrder(container, state.doc!.parts)
    .slice(0, slotIndex).filter((s) => s.kind === 'path').length;
  return { kind: 'movePath', src, dest: container, pathId, pathsIndex, slotIndex };
}

/** A PART dropped at the edge of any sibling-candidate row. */
export function planPartEdgeDrop(
  draggedId: string, ref: ReferenceRow, zone: DropZone,
): SlotDropPlan {
  const doc = state.doc!;
  const dragged = doc.parts.find((p) => p.id === draggedId);
  if (!dragged) return { kind: 'none' };
  const container = rowContainer(ref);
  const refSlotId = refSlotIdOf(ref);
  if (refSlotId === draggedId) return { kind: 'none' };
  if (!container) {
    // Root-level part rows: no childOrder exists at the root (roots are always parts),
    // so the pre-U4 sibling-block splice is still the whole story.
    if ('pathId' in ref) return { kind: 'refuse', reason: ROOT_PATH_REFUSAL }; // unreachable: path rows always have an owner
    return { kind: 'rootRelative', partId: draggedId, refId: ref.part.id, place: zone };
  }
  if (container.id === draggedId || isAncestorOf(dragged, container)) {
    return { kind: 'refuse', reason: 'That drop would create a parenting cycle.' };
  }
  const toIndex = targetSlotIndex(container, draggedId, refSlotId, zone);
  if (toIndex < 0) return { kind: 'none' };
  if (dragged.parentId === container.id) {
    if (reorderIsNoOp(container, draggedId, toIndex)) return { kind: 'none' };
    return { kind: 'reorder', container, slotId: draggedId, toIndex };
  }
  return { kind: 'reparentAtSlot', partId: draggedId, container, toIndex };
}

/** A path dropped on its OWN part's header row: send to the TOP of the part (last slot). */
export function planPathToTop(src: RigPart, pathId: string): SlotDropPlan {
  const order = effectiveChildOrder(src, state.doc!.parts);
  const toIndex = order.length - 1;
  if (reorderIsNoOp(src, pathId, toIndex)) return { kind: 'none' };
  return { kind: 'reorder', container: src, slotId: pathId, toIndex };
}
