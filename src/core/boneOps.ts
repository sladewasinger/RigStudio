// ---- Bone chains ----

import { RigPart, Vec2 } from './docTypes';

/**
 * The full bone chain a bone belongs to (Bones 2.0 auto-bind): its ROOT bone (walking
 * up parent links while they stay bones) plus every bone descended from that root
 * through bone-only links. Returned in doc-parts order (placement order == root first
 * for a normally-built chain). Pure over the parts array, so it is unit-testable.
 *
 * UNIFIED SKELETON (Phase 1): an `attachedRoot` bone is treated as the root of its OWN
 * chain even though it has a bone `parentId` reaching into another chain — `rootOf`
 * stops climbing the instant it lands on one, so a chain never crosses a cross-chain
 * attach in either direction. Walking UP from a descendant of an attached sub-chain
 * resolves to the attached root, not the parent chain's root (extending an arm chain
 * must never re-target the body's art via auto-bind); walking DOWN from the parent
 * chain's root excludes the attached sub-chain entirely (its members' `rootOf` resolves
 * to the attached root, not the parent root, so the `rootOf(p).id === root.id` filter
 * below drops them). POSE composition is untouched — it just follows `parentId` — so the
 * attached sub-chain still rides the parent chain's motion; only chain-scoped ops (auto-
 * bind targeting, freeze bind-refresh, the no-gap invariant) stop at the boundary.
 */
export function boneChain(parts: RigPart[], boneId: string): RigPart[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const start = byId.get(boneId);
  if (!start || start.kind !== 'bone') return [];
  const rootOf = (b: RigPart): RigPart => {
    let r = b;
    const seen = new Set([r.id]);
    while (!r.attachedRoot && r.parentId) {
      const par = byId.get(r.parentId);
      if (!par || par.kind !== 'bone' || seen.has(par.id)) break;
      r = par;
      seen.add(par.id);
    }
    return r;
  };
  const root = rootOf(start);
  return parts.filter((p) => p.kind === 'bone' && rootOf(p).id === root.id);
}

// ---- Bone position model (root-only position; children are rotation + length) ----
//
// A chain's ROOT bone has a position (its pivot). Every CHILD bone is defined by rotation
// + length off the parent tip — its origin IS the parent's tip (one shared joint), so it
// is never independently positioned. These pure helpers back the bone inspector and the
// canvas tip drag: length/angle are read from the pivot→tip vector in the bone's own
// frame (rigid chain transforms preserve distance, so it matches the on-canvas length).

/**
 * Minimum doc-space length a bone's `boneTip` may sit from its `pivot`. This is NOT a
 * float-noise guard — the skin/render math already tolerates a literal zero-length bind
 * segment gracefully (`geometry/skin.ts` `distToSegment`'s point-distance fallback, the
 * LBS stretch factor's `s=1` default). It exists to keep the bone's AXIS direction
 * well-conditioned (IK aim, LBS along-axis stretch, `boneAxisAngle`) and the bone
 * visually/interactively meaningful — a "bone" a user can't see or grab isn't one.
 * Small relative to any real limb segment, comfortably above float-rounding noise.
 */
export const MIN_BONE_LENGTH = 0.5;

/** Whether a proposed bone tip is far enough from its pivot to form a real segment
 *  (finite and at least MIN_BONE_LENGTH away). Pure. */
export function isUsableBoneTip(pivot: Vec2, tip: Vec2): boolean {
  return (
    Number.isFinite(tip.x) && Number.isFinite(tip.y)
    && Math.hypot(tip.x - pivot.x, tip.y - pivot.y) >= MIN_BONE_LENGTH
  );
}

/**
 * Heal a bone whose `boneTip` is PRESENT but degenerate (non-finite, or within
 * MIN_BONE_LENGTH of its pivot) by nudging it out along +x in the bone's own frame —
 * the same "default axis" `boneTipForLength` already falls back to for a lengthless
 * bone. No-op for a non-bone part, a bone with `boneTip: null` (the well-defined
 * "partless joint, no visible length yet" state — nothing to heal), or a bone whose
 * tip is already usable. Returns whether it healed anything.
 *
 * HEAL, not drop: a degenerate tip is almost always a numeric artifact (hand-edited
 * file, a placement/AI request landing on its own pivot) on an otherwise-intentional
 * bone. Dropping the bone's skin participation instead would cascade into orphaned
 * per-node overrides and shrink chain coverage for no numeric necessity — the skin
 * math tolerates a zero-length bind segment fine; healing just keeps the AXIS sane.
 */
export function healDegenerateBoneTip(part: RigPart): boolean {
  if (part.kind !== 'bone' || !part.boneTip) return false;
  if (isUsableBoneTip(part.pivot, part.boneTip)) return false;
  part.boneTip = { x: part.pivot.x + MIN_BONE_LENGTH, y: part.pivot.y };
  return true;
}

/** A bone's length: the pivot→tip distance in its own frame (0 when it has no tip). Pure. */
export function boneLength(bone: RigPart): number {
  if (!bone.boneTip) return 0;
  return Math.hypot(bone.boneTip.x - bone.pivot.x, bone.boneTip.y - bone.pivot.y);
}

/** A bone's axis angle (degrees, atan2) from pivot to tip in its own frame. Pure. */
export function boneAxisAngle(bone: RigPart): number {
  if (!bone.boneTip) return 0;
  return (Math.atan2(bone.boneTip.y - bone.pivot.y, bone.boneTip.x - bone.pivot.x) * 180) / Math.PI;
}

/** The tip position for a target length along the bone's CURRENT axis (pure). A
 *  degenerate bone (tip == pivot, or no tip) defaults its axis to +x so a length is
 *  still settable. */
export function boneTipForLength(bone: RigPart, length: number): Vec2 {
  const tip = bone.boneTip ?? { x: bone.pivot.x + 1, y: bone.pivot.y };
  const dx = tip.x - bone.pivot.x, dy = tip.y - bone.pivot.y;
  const len = Math.hypot(dx, dy);
  const ux = len < 1e-9 ? 1 : dx / len;
  const uy = len < 1e-9 ? 0 : dy / len;
  return { x: bone.pivot.x + ux * length, y: bone.pivot.y + uy * length };
}

/**
 * Set a bone's LENGTH (pivot→tip distance) along its current axis: moves the tip, and
 * carries any child bones' origins with it — a child bone's origin IS this bone's tip
 * (one shared joint). The bone position model keeps child rest translate at 0, so
 * child.pivot lands exactly on the new tip. Mutates `parts` in place; caller repaints.
 */
export function setBoneLength(parts: RigPart[], bone: RigPart, length: number): void {
  const tip = boneTipForLength(bone, Math.max(0, length));
  bone.boneTip = { x: tip.x, y: tip.y };
  carryChildBoneOrigins(parts, bone);
}

/**
 * Carry every DIRECT child bone's origin onto `bone`'s (just-moved) tip — one shared
 * joint — then recurse so grandchildren follow their own (also-moved) parent tip.
 *
 * A child bone's own LOCAL geometry (its `boneTip − pivot` vector, i.e. its length and
 * direction relative to its own rotation) must stay byte-identical: only `child.pivot`
 * is solved for the new joint position, so `child.boneTip` has to shift by the exact
 * same delta or the child SHORTENS/LENGTHENS as a side effect of its parent moving (the
 * reported bug — dragging a parent tip left every descendant bone's length wrong).
 * Shifting boneTip by the identical delta keeps (boneTip − pivot) exactly unchanged
 * (the delta cancels algebraically), independent of any rounding applied to the delta
 * itself. Shared by the canvas tip-drag path (`rigOps.ts` `aimBoneAtTip`/
 * `carryChildOrigins`, which mirrors this) and the inspector length field above.
 *
 * UNIFIED SKELETON: skips a direct child flagged `attachedRoot` — its origin is
 * deliberately LOOSE (not glued to this bone's tip; see the field's doc comment), so
 * carrying it here would silently snap a cross-chain attach back onto the tip the moment
 * this bone's length changes, destroying the fixed offset the attach fold solved for.
 */
export function carryChildBoneOrigins(parts: RigPart[], bone: RigPart): void {
  if (!bone.boneTip) return;
  for (const child of parts) {
    if (child.kind !== 'bone' || child.parentId !== bone.id || child.attachedRoot) continue;
    const newPivot = { x: bone.boneTip.x - child.rest.tx, y: bone.boneTip.y - child.rest.ty };
    if (child.boneTip) {
      const dx = newPivot.x - child.pivot.x;
      const dy = newPivot.y - child.pivot.y;
      child.boneTip = { x: child.boneTip.x + dx, y: child.boneTip.y + dy };
    }
    child.pivot = newPivot;
    carryChildBoneOrigins(parts, child); // grandchildren ride this child's moved tip too
  }
}

/**
 * Every bone chained directly under `part` (Bones 2.0 hierarchy-as-assignment): the
 * union of `boneChain` for each of the part's direct bone children. Pure over the parts
 * array. Used by node editing — bones of the edited part's own chain stay visible and
 * selectable while every other part dims (`view/focus.ts`) — and by the node-editing
 * "bind to bone…" quick action, which only offers a part's own chain (`view/rigOps.ts`).
 */
export function chainBonesOfPart(parts: RigPart[], part: RigPart): RigPart[] {
  const roots = parts.filter((p) => p.kind === 'bone' && p.parentId === part.id);
  const seen = new Set<string>();
  const out: RigPart[] = [];
  for (const root of roots) {
    for (const b of boneChain(parts, root.id)) {
      if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
    }
  }
  return out;
}

/**
 * Translate an entire bone chain (its root + every descendant bone) rigidly by (dx,dy):
 * every bone's pivot AND tip shift together, so all shared joints stay connected. This
 * is how a ROOT bone's position edit moves the whole limb. Exact for chains with no baked
 * rest rotation (the common fitting case); a rotated chain translates approximately, but
 * the anchors still stay mutually connected. Mutates `parts` in place.
 */
export function translateBoneChain(parts: RigPart[], boneId: string, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const b of boneChain(parts, boneId)) {
    b.pivot = { x: b.pivot.x + dx, y: b.pivot.y + dy };
    if (b.boneTip) b.boneTip = { x: b.boneTip.x + dx, y: b.boneTip.y + dy };
  }
}

/**
 * Drop a skinned part's per-node weight overrides for one path. Structural node edits
 * (insert/delete/join/split) shift command indexes, so the keyed overrides no longer
 * point at the intended nodes — the honest fix is to drop them. No-op when the part is
 * unskinned or has no overrides on that path.
 */
export function dropSkinOverridesForPath(part: RigPart, pathId: string): void {
  const overrides = part.skin?.overrides;
  if (overrides && pathId in overrides) {
    delete overrides[pathId];
    if (Object.keys(overrides).length === 0) delete part.skin!.overrides;
  }
}
