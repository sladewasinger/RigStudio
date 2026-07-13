/**
 * IK drag pipeline: chain resolution, grab-point bookkeeping, and the FABRIK write-back —
 * split out of interactions.ts (which only routes pointer events into these entry points)
 * in the "Post-A bone feel fixes" wave. Sits at the rigOps layer: may reach into
 * context/coords/pose/geometry but never the facade, interactions.ts, or canvas.ts.
 *
 * Fix 2 (grab-point-relative IK, no tip snap): the effector is wherever the user actually
 * pressed. `startIkDrag` maps the click's ROOT point into the grabbed bone's own
 * (pre-pose) frame via its inverse full-pose transform, so `grabLocal` is that exact
 * material point — not always the tip. A press near the tip yields grabLocal ≈ boneTip
 * (the classic "tip grab" case, unchanged in effect); a press mid-body yields whatever
 * point is under the cursor, and THAT point — not the tip — tracks the pointer for the
 * rest of the gesture (`updateIkDrag`'s `effectorNow`, re-evaluated every move). The
 * chain polyline's last segment is origin(grabbed bone)→grabLocal, whatever its length —
 * `solveChainIK` derives every segment length from the input points, so no bone-length
 * field is ever consulted for that segment; the tip then follows RIGIDLY beyond the
 * grabbed point exactly as it always has (it's downstream of the same bone rotation, and
 * only rest.rotate is ever written — never pivot/boneTip — so lengths stay byte-exact).
 */

import {
  RigPart, state, ancestorChain, setKeyframe, channelValue,
} from '../core/model';
import { applyMat, invertMat, matrixOfTransform } from '../geometry/transforms';
import { solveChainIK, chainStepDelta, Pt } from '../geometry/ik';
import { ctx, notifyTimelineOnly, round1 } from './context';
import { pointerInRoot } from './coords';
import { poseTime, effectivePivot, fullPoseTransform } from './pose';
import { renderPose } from './render';

/**
 * Bones ROOT→effector (outermost first) — the full chain a FABRIK IK drag rotates. The
 * art a chain roots on is filtered out (only `kind === 'bone'` ancestors), so it's never
 * mistaken for a joint.
 *
 * UNIFIED SKELETON (Phase 1): stops at an `attachedRoot` boundary — IK never solves
 * ACROSS a cross-chain attach (Phase 2, whether grabbing a hand should FABRIK through
 * the spine, is an explicit deferred decision, not built). Walking nearest-parent-first
 * so the first `attachedRoot` bone encountered is INCLUDED (it's the effector's own
 * local chain root) but that bone's own ancestors — the OTHER chain — are excluded. When
 * the effector itself is an attached root, its chain is just itself: no ancestor bone
 * (all of which belong to the other chain) participates.
 */
export function ikBoneChain(effector: RigPart): RigPart[] {
  if (effector.attachedRoot) return [effector];
  const ancestors = ancestorChain(effector); // outermost first
  const chain: RigPart[] = [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.kind !== 'bone') continue;
    chain.unshift(a);
    if (a.attachedRoot) break; // a's own ancestors are a DIFFERENT chain — stop here
  }
  chain.push(effector);
  return chain;
}

/**
 * Start a full-chain IK drag with `effector` as the grabbed bone. `rootPoint` (root/doc
 * space) is wherever the user actually pressed — mapped into the bone's own frame so it
 * stays the rigidly-attached grab point for the whole gesture.
 */
export function startIkDrag(effector: RigPart, rootPoint: Pt, ev: PointerEvent): void {
  const inv = invertMat(matrixOfTransform(fullPoseTransform(effector, poseTime())));
  const grabLocal = applyMat(inv, rootPoint.x, rootPoint.y);
  ctx.drag = {
    kind: 'ik',
    chain: ikBoneChain(effector),
    grabbed: effector,
    grabLocal,
    current: { x: rootPoint.x, y: rootPoint.y },
    startClient: { x: ev.clientX, y: ev.clientY },
    active: false,
  };
  try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
}

/**
 * IK entry gesture #2: grabbing a SKINNED ART part (no bone glyph under the cursor) drives
 * its deepest-in-chain bone's effector to `rootPoint` — the same grab-point anchoring as a
 * direct bone press, so the art's own click position (not always its tip) is what tracks
 * the cursor. Returns false (starts nothing) when the part has no bone chain to solve.
 */
export function startIkDragOnSkinnedArt(part: RigPart, rootPoint: Pt, ev: PointerEvent): boolean {
  const doc = state.doc;
  if (!doc || !part.skin) return false;
  const bones = part.skin.bones
    .map((b) => doc.parts.find((pp) => pp.id === b.id))
    .filter((b): b is RigPart => !!b && b.kind === 'bone');
  if (bones.length === 0) return false;
  bones.sort((a, b) => ancestorChain(a).length - ancestorChain(b).length);
  startIkDrag(bones[bones.length - 1], rootPoint, ev);
  return true;
}

/**
 * FABRIK pointermove step for an in-flight IK drag: build the chain's joint polyline
 * (every bone's origin, then the grabbed point), solve it against the pointer, and write
 * each bone's rest.rotate back ROOT-FIRST from its solved segment direction (a bone's
 * rest.rotate is RELATIVE — its parent's rotation reframes it — so aiming reads each
 * bone's CURRENT origin/axis, which already reflects the parents just written this same
 * pass). Only rest.rotate changes (never pivot/boneTip), so every bone length stays
 * byte-exact and the shared-joint connection (child origin == parent tip) is untouched.
 */
export function updateIkDrag(ev: PointerEvent): void {
  const d = ctx.drag;
  if (!d || d.kind !== 'ik') return;
  const p = pointerInRoot(ev);
  const t = poseTime();
  const setup = state.editorMode === 'setup';
  d.current = { x: p.x, y: p.y }; // drives the overlay's effector→pointer target line
  const chain = d.chain;
  if (chain.length > 0) {
    const effectorNow = () =>
      applyMat(matrixOfTransform(fullPoseTransform(d.grabbed, t)), d.grabLocal.x, d.grabLocal.y);
    const joints = chain.map((b) => effectivePivot(b, t));
    joints.push(effectorNow());
    const solved = solveChainIK(joints, { x: p.x, y: p.y });
    for (let i = 0; i < chain.length; i++) {
      const bone = chain[i];
      const origin = effectivePivot(bone, t);
      const axisEnd = i < chain.length - 1 ? effectivePivot(chain[i + 1], t) : effectorNow();
      const deltaDeg = chainStepDelta(origin, axisEnd, solved[i], solved[i + 1]);
      if (Math.abs(deltaDeg) < 1e-4) continue;
      if (setup) bone.rest.rotate = round1(bone.rest.rotate + deltaDeg);
      else {
        setKeyframe(bone.id, 'rotate', round1(channelValue(bone, 'rotate', state.currentTime) + deltaDeg));
      }
    }
  }
  renderPose();
  notifyTimelineOnly();
}
