/**
 * Shared gesture mechanics applied UNIFORMLY by the router, regardless of which
 * pipeline claimed the press: the drag-threshold + checkpoint-once-per-gesture
 * deferral, pointer capture, the freeze-mode bind-refresh bracket, the handle-set
 * toggle-on-click, and the translate/rotate move math shared by every pipeline that
 * can produce those two DragState kinds (gizmo, handles' rotate-handle, artwork's
 * body-drag — three different presses, one honest set of math). Verbatim extraction
 * from the old interactions.ts; no behavior changed.
 */

import { state, setKeyframe, selectedPart } from '../../core/model';
import { checkpoint } from '../../core/history';
import {
  ctx, DragState, ROTATE_SNAP_DEGREES, DRAG_THRESHOLD_PX, round1, wrapToPi,
  notifyTimelineOnly, snappingActive,
} from '../context';
import { snapThreshold, rootToUser, pointerInRoot } from '../coords';
import { poseTime } from '../pose';
import { snapDelta, SnapAxis } from '../../geometry/snap';
import { applyMat } from '../../geometry/transforms';
import { translateSnapFeatures } from '../snapping';
import { renderPose } from '../render';
import {
  captureFrozenBaseline, refreshFrozenSkinWeights, refreshBindForChain,
} from '../rigOps';

/** First real movement of a drag: fire the deferred checkpoint exactly once. */
export function activateDrag(
  d: Exclude<DragState, { kind: 'pan' } | { kind: 'nodeMarquee' }>,
  ev: PointerEvent,
): boolean {
  if (d.active) return true;
  const dx = ev.clientX - d.startClient.x;
  const dy = ev.clientY - d.startClient.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;
  checkpoint();
  d.active = true;
  return true;
}

/** try/catch wrapper for setPointerCapture — a no-op for synthetic test events, which
 *  don't implement it. Every pipeline that hand-builds a DragState calls this right
 *  after (ikDrag.ts's startIkDrag captures internally, so IK-producing claims don't). */
export function capturePointer(ev: PointerEvent): void {
  try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
}

/** The bone whose chain a freeze bone drag edits (any chain member — the helpers
 *  resolve the full chain from it), or null when the drag isn't a bone reshape. */
function frozenChainBoneId(d: DragState): string | null {
  if (d.kind === 'boneTip') return d.part.kind === 'bone' ? d.part.id : null;
  if (d.kind === 'pivot') return d.part.kind === 'bone' ? d.part.id : null;
  if (d.kind === 'rotate') return d.targets.find((tt) => tt.part.kind === 'bone')?.part.id ?? null;
  return null;
}

/**
 * FREEZE: at the FIRST activated move of a bone reshape, snapshot the art's CURRENT
 * look as its bind baseline (BEFORE the bone moves), so the reshape edits the rig
 * against the static art even when the art was already posed in non-freeze. Per-move
 * refreshBind then holds that look. A no-op in effect when the art is at its bind
 * appearance. Called by the router before dispatching to the claimant's move().
 */
export function captureFreezeBaselineIfNeeded(wasActive: boolean, d: DragState): void {
  if (wasActive || !state.freezeMode) return;
  const bid = frozenChainBoneId(d);
  if (bid) captureFrozenBaseline(bid, poseTime());
}

/**
 * The bone(s) a drag reshaped, for the freeze gesture-end weight refresh (empty when
 * the gesture didn't reshape a bone). A pivot drag on a CHILD bone reshapes its PARENT
 * (the shared joint); on a ROOT bone it translates that bone's chain.
 * refreshFrozenSkinWeights resolves the full chain from any member, so returning one id
 * per touched chain suffices.
 */
function frozenReshapedBoneIds(d: DragState): string[] {
  if (d.kind === 'boneTip' && d.active) return d.part.kind === 'bone' ? [d.part.id] : [];
  if (d.kind === 'pivot' && d.active && d.part.kind === 'bone') {
    const parent = d.part.parentId
      ? state.doc?.parts.find((p) => p.id === d.part.parentId && p.kind === 'bone')
      : null;
    return [parent?.id ?? d.part.id];
  }
  if (d.kind === 'rotate' && d.active) {
    return d.targets.filter((tt) => tt.part.kind === 'bone').map((tt) => tt.part.id);
  }
  return [];
}

/** Gesture-end: rebuild bound parts' auto weights ONCE from the final bind segments, so
 *  later posing deforms correctly from the new bone layout. Router-level generic hook —
 *  keyed off DragState fields, not off which pipeline claimed. */
export function refreshFreezeWeightsAfterDrag(d: DragState): void {
  if (!state.freezeMode) return;
  for (const id of frozenReshapedBoneIds(d)) refreshFrozenSkinWeights(id);
}

/** A motionless click on the already-selected part cycles scale↔rotate handles (from
 *  either a translate or a rotate body-drag press — only artwork's body-drag ever sets
 *  toggleOnClick true; gizmo/handle-set rotates leave it unset). Router-level generic
 *  hook, exactly mirroring the old shared end() function. */
export function applyToggleOnClick(d: DragState): void {
  if ((d.kind === 'translate' || d.kind === 'rotate') && !d.active && d.toggleOnClick) {
    ctx.handleMode = ctx.handleMode === 'scale' ? 'rotate' : 'scale';
  }
}

/**
 * Shared 'translate' move math: gizmo's translate arrows, and artwork's body-drag both
 * produce this DragState kind and both delegate their move() here (Ctrl axis-lock +
 * snapping application belongs here per the redesign spec).
 */
export function moveTranslate(ev: PointerEvent, d: Extract<DragState, { kind: 'translate' }>): void {
  const setup = state.editorMode === 'setup';
  const p = pointerInRoot(ev);
  let dx = p.x - d.startX;
  let dy = p.y - d.startY;
  // Axis lock (gizmo arrow or Ctrl) applies to the delta BEFORE snapping; the FREE
  // axis is the one still moving, so snapping can only correct along it — the lock
  // is never broken.
  let freeAxis: SnapAxis = null;
  if (d.axis === 'x') { dy = 0; freeAxis = 'x'; }
  else if (d.axis === 'y') { dx = 0; freeAxis = 'y'; }
  else if (ev.ctrlKey) {
    // Ctrl constrains a free move to the dominant axis (Inkscape-style).
    if (Math.abs(dx) >= Math.abs(dy)) { dy = 0; freeAxis = 'x'; }
    else { dx = 0; freeAxis = 'y'; }
  }
  ctx.snapMarker = null;
  const primary = selectedPart();
  if (snappingActive() && primary) {
    if (!d.snapFeatures) d.snapFeatures = translateSnapFeatures(primary, poseTime());
    const snapped = snapDelta(
      d.snapFeatures.moving, d.snapFeatures.targets,
      { dx, dy }, snapThreshold(), freeAxis,
    );
    dx = snapped.dx;
    dy = snapped.dy;
    if (snapped.target) ctx.snapMarker = rootToUser(snapped.target);
  }
  // The constrained point, so the dashed line + Δ readout show the applied move.
  d.current = { x: d.startX + dx, y: d.startY + dy };
  for (const { part, startTx, startTy, invLinear } of d.targets) {
    const local = applyMat(invLinear, dx, dy);
    const tx = round1(startTx + local.x);
    const ty = round1(startTy + local.y);
    if (setup) {
      part.rest.tx = tx;
      part.rest.ty = ty;
    } else {
      setKeyframe(part.id, 'tx', tx);
      setKeyframe(part.id, 'ty', ty);
    }
  }
  renderPose();
  notifyTimelineOnly();
}

/**
 * Shared 'rotate' move math: gizmo's rotate ring, the classic rotate-handle corners,
 * and artwork's body-drag all produce this DragState kind and delegate here.
 */
export function moveRotate(ev: PointerEvent, d: Extract<DragState, { kind: 'rotate' }>): void {
  const setup = state.editorMode === 'setup';
  const p = pointerInRoot(ev);
  const angle = Math.atan2(p.y - d.pivotY, p.x - d.pivotX);
  // Accumulate the WRAPPED per-step angle rather than diffing against the drag's start
  // snapshot: a raw (angle - startAngle) jumps by ±360° the instant the drag crosses the
  // atan2 ±180° branch cut, and since keyed values are absolute and sampled linearly,
  // that jump got recorded (and played back) verbatim — a multi-turn wind-up rotated the
  // "wrong direction". Each step is bounded to (-180°, 180°], so accumDeg tracks the
  // honest total no matter how many times the pointer crosses the ray.
  const step = wrapToPi(angle - d.lastAngle);
  d.accumDeg += (step * 180) / Math.PI;
  d.lastAngle = angle;
  const deltaDeg = d.accumDeg;
  d.snapped = ev.ctrlKey;
  d.current = { x: p.x, y: p.y };
  for (const { part, start } of d.targets) {
    let value = start + deltaDeg;
    if (ev.ctrlKey) value = Math.round(value / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
    value = round1(value);
    if (part.id === d.targets[0]?.part.id) d.currentDelta = round1(value - start);
    if (setup) part.rest.rotate = value;
    else setKeyframe(part.id, 'rotate', value);
  }
  // Freeze: a bone rotate reshapes the rig against static art — refresh the bind so the
  // skinned art doesn't swing with the bone (outside freeze it deforms, as intended).
  if (state.freezeMode) {
    for (const { part } of d.targets) {
      if (part.kind === 'bone') refreshBindForChain(part.id, poseTime());
    }
  }
  renderPose();
  notifyTimelineOnly();
}
