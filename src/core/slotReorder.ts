/**
 * U4 (unified child ordering — the user-visible layer): `moveChildSlot`, THE reorder op
 * every slot-space gesture funnels through — Layers-panel drag-reorders between mixed
 * path/part rows, PageUp/PageDown stepping, and the inspector stacking arrows (the
 * latter two via `structuralOps.ts`'s `moveSelectedInDrawOrder`).
 *
 * WHY THIS INVERTS U1's AUTHORITY FLOW, ON PURPOSE: `core/childOrder.ts`'s header pins
 * rule 4 — `doc.parts` sibling order is the authority for part-vs-part order, `paths[]`
 * for path-vs-path, and every U1 mutation site only ever MIRRORS those authorities into
 * `childOrder`. A U4 gesture is the one place that runs the other way: the user grabs a
 * ROW in the Layers tree, and rows ARE slots — the gesture is authored in slot space, so
 * the slot list moves FIRST (`slotMoveWithin`, still the chokepoint's own primitive) and
 * the two authorities are then re-derived to agree (`mirrorAuthoritiesToSlots` below).
 * Rule 4 holds again by construction the moment this function returns — it is only ever
 * suspended INSIDE the op, never observable outside it. The alternative (reorder the
 * authorities first, then `reconcileChildOrder`) cannot work here: reconcile deliberately
 * preserves the existing INTERLEAVING (it only reassigns which id occupies each existing
 * kind-position), so it can never express the new interleaving a cross-kind drop creates
 * — which is exactly why U1 parked `slotMoveWithin` "for later waves". This is that wave.
 *
 * `toIndex` is in POST-REMOVAL index space (the `slotMoveWithin` convention: the moved
 * slot's final resting index once it's out of the way). For a ±1 step from current index
 * `i`, that is simply `i + delta`.
 */
import { RigPart } from './docTypes';
import { state } from './appState';
import { effectiveChildOrder, reconcileChildOrder, slotMoveWithin } from './childOrder';
import { partById, subtreeIds } from './partHierarchy';

/**
 * Re-derive both order authorities from `parent.childOrder` after a slot move:
 *  - `parent.paths` is reordered to the path-slot sequence (same objects, new order);
 *  - `parent`'s direct children's SUBTREE BLOCKS are re-spliced in `doc.parts` to the
 *    part-slot sequence. On a canonical array the children's blocks sit contiguously
 *    right after `parent` itself (each child immediately follows the previous sibling's
 *    block), so extracting every child block and re-inserting the lot, permuted,
 *    immediately after `parent` reproduces exactly that canonical shape — no survivor
 *    outside the parent's own block ever moves.
 * Defensive: a path/part that somehow has no slot (childOrder was just reconciled by the
 * caller, so this means a concurrent-mutation bug elsewhere) is appended rather than
 * dropped — losing artwork to a reorder would be far worse than a stale position.
 */
function mirrorAuthoritiesToSlots(parent: RigPart): void {
  const doc = state.doc;
  if (!doc || !parent.childOrder) return;
  const order = parent.childOrder;

  const pathSeq = order.filter((s) => s.kind === 'path').map((s) => s.id);
  const pathsById = new Map(parent.paths.map((p) => [p.id, p]));
  const newPaths = pathSeq.map((id) => pathsById.get(id)).filter((p) => p !== undefined);
  for (const p of parent.paths) if (!pathSeq.includes(p.id)) newPaths.push(p); // defensive append
  parent.paths = newPaths;

  const partSeq = order.filter((s) => s.kind === 'part').map((s) => s.id);
  const currentSeq = doc.parts.filter((p) => p.parentId === parent.id).map((p) => p.id);
  const alreadyAgrees =
    partSeq.length === currentSeq.length && partSeq.every((id, i) => id === currentSeq[i]);
  if (alreadyAgrees) return;

  const blockIds = new Set<string>();
  const blocks: RigPart[][] = [];
  for (const id of [...partSeq, ...currentSeq.filter((id) => !partSeq.includes(id))]) {
    const child = partById(id);
    if (!child || child.parentId !== parent.id) continue; // defensive: dangling slot
    const ids = subtreeIds(child, doc.parts);
    blocks.push(doc.parts.filter((p) => ids.has(p.id)));
    for (const sub of ids) blockIds.add(sub);
  }
  const rest = doc.parts.filter((p) => !blockIds.has(p.id));
  const insertAt = rest.indexOf(parent) + 1; // parent always survives into `rest`
  rest.splice(insertAt, 0, ...blocks.flat());
  doc.parts = rest;
}

/**
 * Move the slot holding `slotId` (a path OR a direct child part — ids are unique
 * doc-wide) to `toIndex` within `parent`'s childOrder, then restore rule 4 (see the
 * module doc). Materializes a still-absent childOrder first (`reconcileChildOrder` — an
 * explicit reorder gesture is a real structural edit, so the lazy synthesis rightfully
 * becomes concrete here; the synthesized list it starts from is exactly what the user
 * was looking at). Returns false — with ZERO mutation — when the slot doesn't resolve
 * or the move is a no-op, so callers can gate their checkpoint on it.
 */
export function moveChildSlot(parent: RigPart, slotId: string, toIndex: number): boolean {
  const doc = state.doc;
  if (!doc) return false;
  // No-op probe on the EFFECTIVE order (a pure read — the same order the caller's UI
  // rendered) so a do-nothing call never even materializes a lazy childOrder.
  const preview = effectiveChildOrder(parent, doc.parts);
  const previewFrom = preview.findIndex((s) => s.id === slotId);
  if (previewFrom < 0) return false;
  if (Math.max(0, Math.min(toIndex, preview.length - 1)) === previewFrom) return false;
  // A real move: materialize/repair first, then re-resolve the index against the actual
  // list — a present-but-stale childOrder (the nodeEditing staleness window documented
  // in childOrder.ts) can shift indices across the repair.
  reconcileChildOrder(parent, doc.parts);
  const order = parent.childOrder!;
  const from = order.findIndex((s) => s.id === slotId);
  if (from < 0) return false; // repaired away — a dangling id; the repair itself stands
  slotMoveWithin(parent, slotId, Math.max(0, Math.min(toIndex, order.length - 1)));
  mirrorAuthoritiesToSlots(parent);
  return true;
}
