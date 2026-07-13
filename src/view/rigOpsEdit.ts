/**
 * Rig-edit operations: Setup-mode flips, arrow-key part nudge, align/distribute
 * application, distributed group-scale, and bone reshaping (aim-at-tip + child-origin
 * carry — the freeze/non-freeze pose model's actual reshape math; the freeze-mode BIND
 * refresh that keeps art static during a freeze reshape lives in rigOpsBind.ts). Split
 * out of rigOps.ts (CLAUDE.md "Small, focused files"); shares its layer (may reach
 * render.ts/partDom.ts/skinRender.ts, never interactions.ts or higher).
 */

import {
  state, selectedParts, setKeyframe, channelValue, ancestorChain, RigPart,
} from '../core/model';
import { applyMat, invertMat, matrixOfTransform } from '../geometry/transforms';
import { ctx, linearOnly, round1, round2, round3, wrapToPi } from './context';
import {
  poseTime, groupTransformOf, chainMatOf, effectivePivot, effectiveTip, fullPoseTransform,
  ownTranslateOf, groupDescendants,
} from './pose';
import { renderPose } from './render';

// ---- Vector-editing operations (Setup mode) ----

/**
 * Flip the selected art parts in place — around each part's own rendered bbox center,
 * stored as negated rest scale (axes follow the artwork like all rest scaling), with
 * the bbox center pinned by rest-translation compensation. The joint doesn't move.
 */
export function flipSelected(axis: 'h' | 'v'): boolean {
  if (state.editorMode !== 'setup') return false;
  const parts = selectedParts().filter((p) => p.paths.length > 0 && ctx.partGroups.has(p.id));
  if (parts.length === 0) return false;
  const t = poseTime();
  for (const part of parts) {
    const g = ctx.partGroups.get(part.id)!;
    const box = g.getBBox();
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    if (axis === 'h') part.rest.sx = -part.rest.sx;
    else part.rest.sy = -part.rest.sy;
    const after = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    const local = applyMat(
      linearOnly(invertMat(chainMatOf(part, t))), before.x - after.x, before.y - after.y,
    );
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
  return true;
}

/** One descendant's frozen drag-start snapshot for a group scale (see applyGroupScale). */
export interface GroupScaleMember {
  part: RigPart;
  startSx: number; startSy: number;
  /** Root-space effective pivot at drag start — the position that scales about the
   *  group's own pivot. */
  startPivotRoot: { x: number; y: number };
}

/**
 * Snapshot every descendant of `group` for a distributed group-scale drag, ANCESTOR-
 * FIRST (shallower ancestorChain first). Order matters: applyGroupScale re-solves each
 * member's chain matrix LIVE (not frozen) against the CURRENT doc, so a member must be
 * processed only after every member that is one of its own ancestors — otherwise a
 * grandchild (e.g. an art part nested inside another member) would read a stale,
 * pre-correction chain for that ancestor.
 */
export function groupScaleMembers(group: RigPart, t: number | null): GroupScaleMember[] {
  const members = groupDescendants(group).map((part) => ({
    part,
    startSx: part.rest.sx, startSy: part.rest.sy,
    startPivotRoot: effectivePivot(part, t),
  }));
  members.sort((a, b) => ancestorChain(a.part).length - ancestorChain(b.part).length);
  return members;
}

/**
 * Group scale handle drag (the flipSelected family, generalized from reflection to
 * non-uniform scale): apply a (fx,fy) scale about `pivotRoot` to every snapshotted
 * descendant. Each part's OWN rest scale multiplies — its artwork grows/shrinks about
 * its own local pivot, per the rest-scale convention (innerLocalTransform) — and its
 * rendered PIVOT position scales about the GROUP's pivot: a true root-space point-scale
 * (target = pivotRoot + f*(startPivot - pivotRoot)). The local rest.tx/ty needed to land
 * there is solved by inverting the part's CURRENT (not frozen) chain matrix — members
 * are processed ancestor-first (groupScaleMembers), so by the time a nested member is
 * solved, any of ITS OWN ancestors that are also members already carry their corrected
 * rest.tx/ty, and chainMatOf reads that live value. Solving against a frozen ancestor
 * chain instead double-applies the ancestor's own shift on top of the nested member's —
 * the bug this replaced (caught live on an imported nested group, girl_example.svg's
 * RightArm ⊃ Arm ⊃ g291-2). A part whose own axes are rotated relative to root only
 * gets this exactly right when fx==fy (uniform) — a non-uniform scale of a rotated
 * child would need a local shear this model has no field for; same pragmatic
 * limitation as flipSelected's local-axis negation, accepted by design. Idempotent per
 * pointermove: solved fresh from the FROZEN start pivots every call, so per-frame
 * rounding never compounds.
 */
export function applyGroupScale(
  members: GroupScaleMember[], t: number | null,
  pivotRoot: { x: number; y: number }, fx: number, fy: number,
): void {
  for (const m of members) {
    m.part.rest.sx = round2(m.startSx * fx);
    m.part.rest.sy = round2(m.startSy * fy);
    const target = {
      x: pivotRoot.x + fx * (m.startPivotRoot.x - pivotRoot.x),
      y: pivotRoot.y + fy * (m.startPivotRoot.y - pivotRoot.y),
    };
    // chainMatOf recomputes FRESH from live doc state on every call (not cached) — for
    // an ancestor-member processed earlier in this same loop, that live read already
    // reflects its just-written rest.tx/ty.
    const chain = chainMatOf(m.part, t);
    const local = applyMat(invertMat(chain), target.x, target.y);
    m.part.rest.tx = round1(local.x - m.part.pivot.x);
    m.part.rest.ty = round1(local.y - m.part.pivot.y);
  }
}

/**
 * Nudge the selected parts by a SCREEN-pixel delta (arrow keys), converted through
 * the current zoom and each part's parent chain — the keyboard twin of a translate
 * drag (Setup writes rest, Animate keys tx/ty at the playhead). Sub-0.1 steps at
 * high zoom survive thanks to finer rounding. Returns whether anything moved.
 */
export function nudgeSelectedParts(dxPx: number, dyPx: number): boolean {
  if (!ctx.svg) return false;
  const parts = selectedParts().filter((p) => !p.skin);
  if (parts.length === 0) return false;
  const ctm = ctx.svg.getScreenCTM();
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
  const dx = dxPx / scale;
  const dy = dyPx / scale;
  const t = poseTime();
  const setup = state.editorMode === 'setup';
  for (const part of parts) {
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), dx, dy);
    if (setup) {
      part.rest.tx = round3(part.rest.tx + local.x);
      part.rest.ty = round3(part.rest.ty + local.y);
    } else {
      setKeyframe(part.id, 'tx', round3(channelValue(part, 'tx', t) + local.x));
      setKeyframe(part.id, 'ty', round3(channelValue(part, 'ty', t) + local.y));
    }
  }
  renderPose();
  return true;
}

/** Apply root-space translation deltas (from align/distribute) via rest translation. */
export function applyRootDeltas(deltas: Map<string, { dx: number; dy: number }>): void {
  const doc = state.doc;
  if (!doc) return;
  const t = poseTime();
  for (const [id, d] of deltas) {
    if (d.dx === 0 && d.dy === 0) continue;
    const part = doc.parts.find((p) => p.id === id);
    if (!part) continue;
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), d.dx, d.dy);
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
}

// ---- Bone reshaping (the freeze / non-freeze pose model) ----
//
// A bone is posed by ROTATION (around its origin) + LENGTH (its tip). There is no free
// translation of a bone — a child bone's origin IS its parent's tip (one shared joint),
// so translating a bone independently would tear the chain apart. Reshaping a bone rotates
// its rest, which deforms any skinned art through the existing LBS delta-from-bind (art
// follows). In FREEZE mode the SAME reshapes run but the bind reference is refreshed so the
// art stays put (the rig is fitted against static art) — see rigOpsBind.ts's
// refreshBindForChain/captureFrozenBaseline, called by interactions.ts around this reshape.

/**
 * Reshape a bone to reach `targetRoot` (root coords): AIM it (rotate `rest.rotate` so the
 * origin→tip ray points at the target — this rotates any skinned art via the LBS delta) and
 * set its LENGTH (its tip lands exactly on the target). Direct child origins ride the new tip
 * (the shared joint stays connected; deeper joints stay connected through inheritance). The
 * caller owns the checkpoint, freeze re-bind, and repaint.
 */
export function aimBoneAtTip(
  bone: RigPart, targetRoot: { x: number; y: number }, t: number | null,
): void {
  const doc = state.doc;
  if (!doc) return;
  const origin = effectivePivot(bone, t);
  const curTip = effectiveTip(bone, t) ?? { x: origin.x + 5, y: origin.y };
  const curAng = Math.atan2(curTip.y - origin.y, curTip.x - origin.x);
  const tgtAng = Math.atan2(targetRoot.y - origin.y, targetRoot.x - origin.x);
  const dDeg = (wrapToPi(tgtAng - curAng) * 180) / Math.PI;
  bone.rest.rotate = round1(bone.rest.rotate + dDeg);
  // Set the tip so the rendered tip lands exactly on the target (length captured), measured
  // against the freshly-rotated pose so effectiveTip == targetRoot.
  const invNew = invertMat(matrixOfTransform(fullPoseTransform(bone, t)));
  const tipLocal = applyMat(invNew, targetRoot.x, targetRoot.y);
  bone.boneTip = { x: round1(tipLocal.x), y: round1(tipLocal.y) };
  carryChildOrigins(bone, t);
}

/**
 * Glue each direct child bone's origin to this bone's tip (the shared joint), preserving
 * every descendant's own LOCAL geometry: a child's `boneTip − pivot` vector (its length
 * and direction relative to its own rotation) must stay byte-identical when its origin is
 * carried onto a moved joint, or it silently shortens/lengthens as a side effect of its
 * PARENT reshaping (the reported bug). Shifting `boneTip` by the exact same delta as
 * `pivot` keeps that vector exactly unchanged — the delta cancels algebraically — then
 * recurses so grandchildren ride this child's (now also moved) tip. round3, not round1:
 * double-rounding pivot and boneTip independently at the coarser 0.1 grid could itself
 * introduce up to ~0.1 of drift in the preserved length. Mirrors `core/model.ts`'s
 * `carryChildBoneOrigins` (the inspector length-field path); freeze mode's bind refresh
 * runs on top of this and needs no separate handling — the geometry it re-binds is
 * already correct either way.
 */
export function carryChildOrigins(bone: RigPart, t: number | null): void {
  const doc = state.doc;
  if (!doc || !bone.boneTip) return;
  for (const child of doc.parts) {
    if (child.kind !== 'bone' || child.parentId !== bone.id) continue;
    const ot = ownTranslateOf(child, t);
    const newPivot = { x: round3(bone.boneTip.x - ot.x), y: round3(bone.boneTip.y - ot.y) };
    if (child.boneTip) {
      const dx = newPivot.x - child.pivot.x;
      const dy = newPivot.y - child.pivot.y;
      child.boneTip = { x: round3(child.boneTip.x + dx), y: round3(child.boneTip.y + dy) };
    }
    child.pivot = newPivot;
    carryChildOrigins(child, t);
  }
}
