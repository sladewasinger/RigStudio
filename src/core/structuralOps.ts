// ---- Structural edits: AI rig changes, delete/duplicate, draw order ----

import { RigPart, Vec2 } from './docTypes';
import { selectedPart, selectPart, state } from './appState';
import { addNullPart, ancestorChain, partById, setParent, subtreeIds } from './partHierarchy';
import {
  isUsableBoneTip, boneDeletionCascade, restWorldMatOf, foldRestWorldIntoOwnPose,
} from './boneOps';
import { freshId } from './idGen';
import { reconcileChildOrder, seedChildOrderIfActive, slotAddChild } from './childOrder';
import { IDENTITY, Mat } from '../geometry/transforms';

/** Structural edits the AI assistant may request (opt-in). */
export interface RigChanges {
  addBones: {
    label: string;
    pivot: Vec2;
    parent: string | null;
    /**
     * Bone tip (Bones 2.0), in the same frame as `pivot` — mirrors how interactive
     * placement stores `RigPart.boneTip` (see `view/interactions.ts`'s commitBone):
     * both fields go through the identical parent-chain conversion, so passing `pivot`
     * and `tip` straight through here (as this function already did for `pivot`) keeps
     * them consistent with each other. Omitted/null = a partless joint with no visible
     * length (fine for a plain reparent target; auto-bind needs a real tip to form a
     * segment).
     */
    tip?: Vec2 | null;
    /**
     * Part LABELS to auto-bind (LBS skin) to this bone's full chain once created. Model
     * layer only carries the request through — binding needs the live canvas (baking
     * geometry into the bind pose), so it is applied by the caller (panels/ai.ts) via
     * the view facade's bindPartsToBones, not here.
     */
    bindParts?: string[];
  }[];
  reparent: { part: string; parent: string | null }[];
  movePivots: { part: string; x: number; y: number }[];
}

/**
 * Apply AI structural edits by part LABEL (the AI never sees ids). Returns the
 * label → id map including newly created bones, for resolving clip targets after.
 * Invalid references and cycle-creating reparents are skipped, not fatal. Does NOT
 * apply `addBones[].bindParts` — see the RigChanges doc comment; the caller binds
 * separately once the canvas can bake geometry.
 */
export function applyRigChanges(changes: RigChanges): Map<string, string> {
  const doc = state.doc!;
  const byLabel = new Map<string, string>(doc.parts.map((p) => [p.label, p.id]));

  for (const b of changes.addBones ?? []) {
    if (byLabel.has(b.label)) continue; // labels must stay unique
    const parentId = b.parent ? (byLabel.get(b.parent) ?? null) : null;
    const bone = addNullPart('bone', b.pivot, parentId, b.label.replace(/\s+/g, '_'));
    // A degenerate requested tip (on/near its own pivot — seen from AI-generated
    // requests) is treated the same as an omitted one: boneTip stays null, the
    // already-documented "partless joint, no visible length" state, rather than
    // fabricating a length the caller never asked for.
    if (b.tip && isUsableBoneTip(b.pivot, b.tip)) bone.boneTip = { x: b.tip.x, y: b.tip.y };
    byLabel.set(bone.label, bone.id);
  }
  for (const r of changes.reparent ?? []) {
    const childId = byLabel.get(r.part);
    if (!childId) continue;
    setParent(childId, r.parent ? (byLabel.get(r.parent) ?? null) : null);
  }
  for (const m of changes.movePivots ?? []) {
    const id = byLabel.get(m.part);
    const part = id ? partById(id) : null;
    if (part) part.pivot = { x: m.x, y: m.y };
  }
  return byLabel;
}

/**
 * Delete parts (layers). Children of a deleted part re-adopt its nearest SURVIVING
 * ancestor (artwork is never deleted implicitly), UNLESS the dying parent is itself a
 * BONE: a bone's own (non-attachedRoot) bone children are shared-joint CONTINUATIONS of
 * the same chain, not independent parts, so deleting a bone cascades its ENTIRE
 * same-chain bone subtree (`boneOps.ts`'s `boneDeletionCascade`) — orphaning them left
 * meaningless floating bones (the user's report: "when I delete the top most parent
 * bone, the other two stay alive"). An `attachedRoot` child (a deliberately LOOSE
 * cross-chain coupling, Unified Skeleton Phase 1) is the exception: it does NOT cascade
 * — it DETACHES world-preserving, re-parenting to the dying bone's nearest surviving
 * ancestor via the same closed-form fold `view/rigOpsAttach.ts`'s `reattachRootBone`
 * uses (mirrored core-side as `boneOps.ts`'s `foldRestWorldIntoOwnPose`, since
 * `geometry/pose.ts` imports `core/model` and would cycle if called from here).
 *
 * A skinned part whose EVERY skin bone dies gets a proper model-level UNBIND rather than
 * just losing its `skin` field: bind baked the part's full ancestor chain into its
 * (now-static) ROOT-space geometry and zeroed its own pose, so re-entering the normal
 * render pipeline with a non-identity ancestor chain would double-transform it (the
 * reported "the arm went nuts" bug — deleting the bones teleported/mangled the art). The
 * fix folds the INVERSE of the part's current rest-chain matrix into its own rest so
 * chain·own composes to the identity in root space — the baked geometry keeps rendering
 * exactly where it was baked, discarding whatever pose the part itself had accumulated
 * since bind (a skinned part's own rotate/translate posing only ever carried its BONES,
 * never its own render — see CLAUDE.md's "Skinned-part UX" — so there is nothing
 * meaningful to preserve there). A part that keeps SOME surviving skin bones needs no
 * such fold: its render pipeline is untouched (still `transform=''`, still deformed by
 * the remaining bones); only the scrubbed bone/override lists change, so its weights
 * RELAX onto the survivors through the ordinary auto-weight cache (skinRender.ts's cache
 * signature includes `skin.bones`, so a bone-set change alone forces a recompute — no
 * explicit invalidation call is needed, or reachable from this module without cycling
 * into view/).
 *
 * The parts' tracks vanish from every clip, and skin bindings (bones AND any per-node
 * overrides pinned to them) referencing deleted bones are dropped. Returns EVERY deleted
 * id (including the cascade) so the canvas can unregister their groups.
 *
 * CANONICAL ORDER is preserved BY CONSTRUCTION exactly as before: this still only ever
 * REMOVES array elements (never moves a survivor) and re-adopts orphans — cascaded or
 * not, detached or not — to an ANCESTOR, never a sibling; on a canonical starting doc,
 * excising any subset of interior nodes (with their children promoted to the nearest
 * surviving ancestor) can't create a gap or interleave a foreign subtree, because every
 * survivor's position relative to every other survivor is untouched; only the now-closer
 * index gaps left by deletions shift things down uniformly.
 */
export function deleteParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const requested = new Set(ids.filter((id) => doc.parts.some((p) => p.id === id)));
  if (requested.size === 0) return [];
  const { dead, detach } = boneDeletionCascade(doc.parts, requested);
  const detachIds = new Set(detach.map((b) => b.id));

  // Snapshot everything the folds below need BEFORE any mutation runs: every
  // ATTACHED-ROOT bone's current rest-only world matrix (the detach target — must be
  // reproduced across the reparent, so it has to be read while the OLD chain is still
  // live) and the SET of skinned survivors whose skin bones are ALL about to die (the
  // unbind target is always the identity, computed fresh at fold time — this only needs
  // the membership test, done here because it's simplest before skin.bones is mutated).
  const detachWorlds = new Map(detach.map((b) => [b.id, restWorldMatOf(doc.parts, b)]));
  const unbinding = doc.parts.filter(
    (p) => !dead.has(p.id) && p.skin && p.skin.bones.every((b) => dead.has(b.id)),
  );

  for (const part of doc.parts) {
    if (dead.has(part.id) || !part.parentId || !dead.has(part.parentId)) continue;
    let anc: RigPart | null = partById(part.parentId);
    while (anc && dead.has(anc.id)) anc = anc.parentId ? partById(anc.parentId) : null;
    part.parentId = anc?.id ?? null;
  }

  // World-preserving folds (detached attached-root bones + fully-unbound skinned parts),
  // ANCESTOR-FIRST — mirrors view/rigOpsBind.ts's bindPartsToBones ordering rationale: a
  // detached bone can land under a part that is ITSELF being unbound in this SAME call
  // (or the reverse), so whichever one sits shallower in the FINAL (already-reparented)
  // hierarchy must be folded first, or the deeper one would read a still-stale ancestor
  // rest value and solve against the wrong chain.
  const folds: { part: RigPart; target: Mat }[] = [
    ...detach.map((bone) => ({ part: bone, target: detachWorlds.get(bone.id)! })),
    ...unbinding.map((part) => ({ part, target: IDENTITY })),
  ].sort((a, b) => ancestorChain(a.part).length - ancestorChain(b.part).length);
  for (const { part, target } of folds) {
    foldRestWorldIntoOwnPose(doc.parts, part, target);
    if (!detachIds.has(part.id)) continue; // the rest is the detach-only flag correction
    const newParent = part.parentId ? partById(part.parentId) : null;
    // Still true when it landed on another bone (re-anchored higher up the same original
    // parent chain), cleared when it landed on a non-bone part/root — exactly
    // `reattachRootBone`'s rule.
    if (newParent?.kind === 'bone') part.attachedRoot = true;
    else delete part.attachedRoot;
  }

  doc.parts = doc.parts.filter((p) => !dead.has(p.id));
  // childOrder: a batch delete can drop several dead children off ONE surviving parent's
  // list and/or land several promoted orphans on another, all at once — rather than
  // duplicating the reparent loop's ancestor-walk to compute each individual slot
  // position, a doc-wide reconcile (childOrder.ts) re-derives every part's childOrder
  // fresh from the now-final parentId graph: dangling (dead) child slots drop out,
  // promoted orphans get appended, and part-slot order is re-derived from doc.parts
  // (rule 4) — all in one pass, per-part idempotent, over parts whose childOrder is
  // absent (LAZY rule) it's a no-op.
  for (const part of doc.parts) reconcileChildOrder(part, doc.parts);
  for (const clip of doc.clips) {
    clip.tracks = clip.tracks.filter((t) => !dead.has(t.target));
  }
  for (const part of doc.parts) {
    if (!part.skin) continue;
    part.skin.bones = part.skin.bones.filter((b) => !dead.has(b.id));
    if (part.skin.bones.length === 0) { part.skin = null; continue; } // fold already applied above
    // A deleted bone can still be pinned by a per-node override even though it's gone
    // from skin.bones above — prune those too (mirrors normalizeDoc's dangling-ref
    // pruning, but live: this runs on an in-session mutation, not just on load).
    if (part.skin.overrides) {
      for (const pathId of Object.keys(part.skin.overrides)) {
        const rec = part.skin.overrides[pathId];
        for (const key of Object.keys(rec)) {
          const ov = rec[key];
          if ((ov.a != null && dead.has(ov.a)) || (ov.b != null && dead.has(ov.b))) delete rec[key];
        }
        if (Object.keys(rec).length === 0) delete part.skin.overrides[pathId];
      }
      if (Object.keys(part.skin.overrides).length === 0) delete part.skin.overrides;
    }
  }
  if (state.selectedPartId && dead.has(state.selectedPartId)) selectPart(null);
  else state.selectedPartIds = state.selectedPartIds.filter((id) => !dead.has(id));
  return [...dead];
}

/**
 * Duplicate parts (Ctrl+D, Setup only): deep-clones each part and its paths with fresh
 * ids, keeps the same parent, and nudges the rest translation by (+12,+12) doc units so
 * the copy is visibly offset from the source. No animation tracks are copied — a fresh
 * id has none by construction, since clip tracks are keyed by target id. Skinned parts
 * are skipped (their geometry is baked to a bind pose; a naive clone would double-bind
 * the same bones). Each copy is inserted immediately after its source's WHOLE SUBTREE
 * (not just the source's own slot — the clone is a SIBLING, never the source's child, so
 * landing it between a duplicated parent and its own real children would split the
 * source's canonical block), so the whole duplicated set stays contiguous. Returns the
 * new parts' ids, input order preserved.
 */
export function duplicateParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const newIds: string[] = [];
  for (const id of ids) {
    const part = doc.parts.find((p) => p.id === id);
    if (!part || part.skin) continue;
    const clone: RigPart = structuredClone(part);
    clone.id = freshId('part');
    clone.label = `${part.label} copy`;
    clone.pivotHint = null;
    clone.rest.tx += 12;
    clone.rest.ty += 12;
    clone.paths = part.paths.map((p) => ({ ...structuredClone(p), id: freshId('path') }));
    // structuredClone above copied `part.childOrder` VERBATIM — stale path ids (just
    // replaced above) and any child-PART slots (children are never duplicated, so those
    // ids aren't actually the clone's own children). seedChildOrderIfActive discards
    // that stale copy and rejoins with the clone's own fresh path ids only, when the doc
    // already uses childOrder; otherwise leaves it absent like any brand-new part on a
    // never-normalized doc (childOrder.ts's LAZY rule).
    seedChildOrderIfActive(clone, doc.parts, clone.paths.map((p) => p.id));
    const sourceIds = subtreeIds(part, doc.parts);
    let insertAt = doc.parts.length;
    for (let i = 0; i < doc.parts.length; i++) if (sourceIds.has(doc.parts[i].id)) insertAt = i + 1;
    doc.parts.splice(insertAt, 0, clone);
    // The clone is a SIBLING inserted immediately after the source's whole subtree (see
    // this function's own doc comment) — mirror that exact position in the parent's
    // childOrder, right after the source's own slot (not necessarily the very end, if
    // the source wasn't already topmost among its siblings).
    const parent = part.parentId ? partById(part.parentId) : null;
    if (parent) {
      const sourceSlot = parent.childOrder?.findIndex((s) => s.kind === 'part' && s.id === part.id) ?? -1;
      slotAddChild(parent, clone.id, sourceSlot < 0 ? undefined : sourceSlot + 1);
    }
    newIds.push(clone.id);
  }
  return newIds;
}

// ---- Draw order (z-order) ----
// doc.parts array order IS the AUTHORED paint order: last = drawn on top. The layers panel
// lists topmost first, so "up the layer list" means "later in doc.parts". On top of that,
// every part carries a keyable `z` OFFSET channel (stepped, absolute, rest 0) that lifts it
// forward/back per frame; the rendered order sorts by (effective z, doc.parts index).
//
// Since the "Layer order IS z-order" wave, doc.parts is also always CANONICAL (see
// isCanonicalPartOrder below): every part's own index precedes its whole, contiguous
// descendant block. The layers panel's nested tree is a direct read of this same array, so
// reordering a subtree in the panel really does move its whole paint block, and PageUp/
// PageDown/the stacking row are SIBLING-scoped (a part can't be draw-order-stepped into a
// different parent's block — that's what re-parenting is for). Every structural op keeps
// the invariant: setParent/addNullPart/groupParts (partHierarchy.ts) move whole subtrees by
// construction; duplicateParts above and moveSelectedInDrawOrder/movePartRelativeTo below do
// the same here; deleteParts/ungroupPart are safe by construction (see their own doc
// comments). normalizeDoc (serialization.ts) canonicalizes on load as legacy/hand-edit
// repair.

/**
 * Whether `parts` is in CANONICAL paint order: a depth-first pre-order traversal where
 * every part's own array index is immediately followed by its full descendant subtree —
 * each child's block starts exactly where the previous sibling's block (or the parent
 * itself, for the first child) ends, with no other subtree's content interleaved. A
 * dangling parentId (points at no part in `parts`) is treated as a root — normalizeDoc
 * repairs those separately; this checker stays meaningful even before that repair runs.
 * Cycle-safe: a parentId cycle can never resolve to a valid contiguous range, so it
 * reports false rather than recursing forever. PURE.
 */
export function isCanonicalPartOrder(parts: RigPart[]): boolean {
  const indexOf = new Map(parts.map((p, i) => [p.id, i]));
  const childrenOf = new Map<string, RigPart[]>();
  for (const p of parts) {
    if (p.parentId == null || !indexOf.has(p.parentId)) continue;
    if (!childrenOf.has(p.parentId)) childrenOf.set(p.parentId, []);
    childrenOf.get(p.parentId)!.push(p);
  }
  const visiting = new Set<string>(); // recursion-stack cycle guard
  const covered = new Set<string>(); // every part reached from a declared root
  const subtreeEnd = (part: RigPart): number | null => {
    if (visiting.has(part.id)) return null; // cycle guard
    visiting.add(part.id);
    covered.add(part.id);
    let end = indexOf.get(part.id)!;
    for (const child of childrenOf.get(part.id) ?? []) {
      if (indexOf.get(child.id)! !== end + 1) return null; // gap, or out of order
      const childEnd = subtreeEnd(child);
      if (childEnd == null) return null;
      end = childEnd;
    }
    visiting.delete(part.id);
    return end;
  };
  for (const part of parts) {
    const isRoot = part.parentId == null || !indexOf.has(part.parentId);
    if (isRoot && subtreeEnd(part) == null) return false;
  }
  // A pure parentId cycle with no declared root (every member points at another member,
  // so isRoot is false for all of them) never gets visited above — reject it too, rather
  // than vacuously reporting canonical because no root-driven check ever ran against it.
  return covered.size === parts.length;
}

/**
 * Repair `parts` into canonical paint order (see isCanonicalPartOrder above) — STABLE
 * (preserves each part's relative order among its current siblings, and every subtree's
 * internal order) and IDEMPOTENT (canonicalizing an already-canonical array returns the
 * same order; a second call never moves anything further, since the output of the first
 * call is itself canonical). A dangling/self-referential parentId is treated as a root
 * (normalizeDoc's separate dangling-parent repair usually runs first, but this stays safe
 * standalone); a parentId cycle (only reachable via a hand-edited file — setParent refuses
 * to create one) is broken at whichever member the traversal reaches first, with the rest
 * of the cycle appended, unmoved, at the end, so nothing is ever silently dropped. PURE
 * (returns a new array; never mutates `parts` or any part in it).
 */
export function canonicalizePartOrder(parts: RigPart[]): RigPart[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const childrenOf = new Map<string, RigPart[]>();
  const roots: RigPart[] = [];
  for (const p of parts) {
    if (p.parentId != null && p.parentId !== p.id && byId.has(p.parentId)) {
      if (!childrenOf.has(p.parentId)) childrenOf.set(p.parentId, []);
      childrenOf.get(p.parentId)!.push(p);
    } else {
      roots.push(p);
    }
  }
  const out: RigPart[] = [];
  const visited = new Set<string>();
  const emit = (part: RigPart): void => {
    if (visited.has(part.id)) return;
    visited.add(part.id);
    out.push(part);
    for (const child of childrenOf.get(part.id) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  for (const p of parts) if (!visited.has(p.id)) emit(p); // leftover cycle members, if any
  return out;
}

/**
 * Parts in paint order for a given effective-z map: sorted by (z ascending, doc.parts index
 * ascending). PURE and STABLE — equal z preserves authored order, so an all-zero z map
 * returns exactly `parts` order (an unkeyed doc renders byte-identically to the pre-z-channel
 * behavior). render.ts feeds this the per-frame effective z (view/pose.ts's `effectiveZ`);
 * keeping the rule here makes it a single unit-testable function instead of inline DOM code.
 */
export function drawOrder(parts: RigPart[], zOf: (part: RigPart) => number): RigPart[] {
  return parts
    .map((part, i) => ({ part, z: zOf(part), i }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((e) => e.part);
}

/** Parts sharing `part`'s parent, in current relative sibling order — on a canonical
 *  array this is exactly the sequence PageUp/PageDown/the stacking row step through:
 *  distinct siblings' subtree blocks never interleave, so this flat filtered list is the
 *  whole story regardless of how large any one sibling's own subtree is. */
function siblingsOf(part: RigPart, parts: RigPart[]): RigPart[] {
  return parts.filter((p) => p.parentId === part.parentId);
}

/** Whether the current selection (entered path, else part) can move a step in z. Part
 *  moves are SIBLING-scoped (see siblingsOf): a part can't be draw-order-stepped past its
 *  own parent's children into a different parent's block — that's what re-parenting is
 *  for. */
export function canMoveSelectedInDrawOrder(delta: 1 | -1): boolean {
  const doc = state.doc;
  const part = selectedPart();
  if (!doc || !part) return false;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    return i >= 0 && i + delta >= 0 && i + delta < part.paths.length;
  }
  const sibs = siblingsOf(part, doc.parts);
  const i = sibs.indexOf(part);
  return i + delta >= 0 && i + delta < sibs.length;
}

/**
 * Move the entered path (within its part) or the selected part one z step (+1 = up). A
 * part with children moves as ONE paint-order unit: its whole subtree block swaps places
 * with its adjacent sibling's whole subtree block (see siblingsOf/subtreeIds) — neither
 * block is ever split, and the move never crosses into a different parent's children.
 */
export function moveSelectedInDrawOrder(delta: 1 | -1): boolean {
  if (!canMoveSelectedInDrawOrder(delta)) return false;
  const doc = state.doc!;
  const part = selectedPart()!;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    [part.paths[i], part.paths[i + delta]] = [part.paths[i + delta], part.paths[i]];
    // The swapped pair need not be childOrder-adjacent (a child part could sit between
    // their slots) — reconcile re-derives the path-slot run fresh from the now-swapped
    // paths[] (the path-order authority) rather than hand-deriving the target index.
    reconcileChildOrder(part, doc.parts);
    return true;
  }
  const sibs = siblingsOf(part, doc.parts);
  const i = sibs.indexOf(part);
  const neighbor = sibs[i + delta];
  // `earlier`/`later` = which of the two currently sits at the lower/higher array index —
  // always `part` then `neighbor` for delta=1 (siblingsOf preserves array order, so the
  // NEXT sibling is always later), and the reverse for delta=-1.
  const earlier = delta === 1 ? part : neighbor;
  const later = delta === 1 ? neighbor : part;
  const earlierIds = subtreeIds(earlier, doc.parts);
  const laterIds = subtreeIds(later, doc.parts);
  const startIdx = doc.parts.findIndex((p) => earlierIds.has(p.id));
  const earlierBlock = doc.parts.filter((p) => earlierIds.has(p.id));
  const laterBlock = doc.parts.filter((p) => laterIds.has(p.id));
  const rest = doc.parts.filter((p) => !earlierIds.has(p.id) && !laterIds.has(p.id));
  const insertAt = doc.parts.slice(0, startIdx).filter(
    (p) => !earlierIds.has(p.id) && !laterIds.has(p.id),
  ).length;
  rest.splice(insertAt, 0, ...laterBlock, ...earlierBlock); // swap: later's block now leads
  doc.parts = rest;
  // `earlier`/`later` are SIBLINGS (see siblingsOf above) — only their shared parent's
  // part-slot order could have changed; reconcile re-derives it from the now-swapped
  // doc.parts (rule 4). A root-level swap has no parent childOrder to fix.
  const parent = part.parentId ? partById(part.parentId) : null;
  if (parent) reconcileChildOrder(parent, doc.parts);
  return true;
}

/**
 * Drop a part just above/below another in the layers tree: it draws immediately on top of
 * ('above') or beneath ('below') `refId`'s WHOLE SUBTREE and becomes its sibling — adopting
 * ref's parent, like dropping between rows in any layer tree. Moves the dragged part's
 * WHOLE SUBTREE as one contiguous block (a part with children takes them along) and never
 * splits `ref`'s own subtree either: "below" lands at ref's own index (always the minimum
 * of its subtree, by canonical construction), while "above" lands one past the END of
 * ref's subtree — so a ref with children never gets a foreign sibling spliced between it
 * and them. Refuses when adopting that parent would create a cycle.
 */
export function movePartRelativeTo(
  partId: string, refId: string, place: 'above' | 'below',
): boolean {
  const doc = state.doc;
  if (!doc || partId === refId) return false;
  const part = partById(partId);
  const ref = partById(refId);
  if (!part || !ref) return false;
  if (ref.parentId !== part.parentId && !setParent(partId, ref.parentId)) return false;
  const moveIds = subtreeIds(part, doc.parts);
  const block = doc.parts.filter((p) => moveIds.has(p.id));
  const rest = doc.parts.filter((p) => !moveIds.has(p.id));
  let insertAt: number;
  if (place === 'below') {
    insertAt = rest.indexOf(ref);
  } else {
    const refIds = subtreeIds(ref, doc.parts);
    insertAt = -1;
    for (let i = 0; i < rest.length; i++) if (refIds.has(rest[i].id)) insertAt = i + 1;
  }
  if (insertAt < 0) return false; // defensive: ref should always survive into `rest`
  rest.splice(insertAt, 0, ...block);
  doc.parts = rest;
  // `part` and `ref` are now siblings (setParent above, or already were); reconcile
  // re-derives their shared parent's part-slot order from the just-finalized doc.parts
  // (rule 4) rather than hand-deriving the above/below childOrder index. No parent
  // childOrder to fix when both are root-level.
  const parent = ref.parentId ? partById(ref.parentId) : null;
  if (parent) reconcileChildOrder(parent, doc.parts);
  return true;
}
