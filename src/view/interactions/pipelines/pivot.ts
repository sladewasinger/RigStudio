/**
 * Freeze-gated joint/pivot drag: a shared bone joint (CHILD bone origin == parent tip,
 * live in BOTH modes) or a freeze-only origin marker (ROOT bone origin, art-part pivot —
 * visible but INERT outside freeze, a hard no-op so it never falls through to a body
 * drag). See CLAUDE.md "Freeze (origin-editing) mode gates all joint editing".
 */

import { state, notify, selectPart, channelValue, translateBoneChain } from '../../../core/model';
import { ctx, DragState, linearOnly, round1, round3, snappingActive } from '../../context';
import { pointerInRoot, snapThreshold, rootToUser } from '../../coords';
import {
  poseTime, innerLocalTransform, chainMatOf, ownTranslateOf, effectivePivot,
} from '../../pose';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../../../geometry/transforms';
import { snapPoint } from '../../../geometry/snap';
import { renderPose } from '../../render';
import { pivotSnapCandidates } from '../../snapping';
import { aimBoneAtTip, refreshBindForChain } from '../../rigOps';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const PIVOT_PIPELINE: GesturePipeline = {
  name: 'pivot',
  claim(hit, ev) {
    if (!hit.pivotEl) return null;
    // Freeze fix: a joint marker now renders for EVERY bone in freeze mode (overlay.ts),
    // each carrying data-part-id — so the press resolves ITS OWN part instead of always
    // `selectedPart()`, and selects it in the SAME gesture (one press, no pre-selecting
    // the bone first — the reported "rotates instead of moving the joint" bug).
    const part = hit.pivotPart;
    if (!part) return 'handled';
    // A CHILD bone's origin IS its parent bone's tip — one shared joint. Dragging it moves
    // that joint (rotating+stretching the parent, art follows outside freeze), so it is
    // LIVE in both modes. Everything else that is an origin — a ROOT bone's origin, an art
    // part's pivot — is freeze-gated: visible but INERT outside freeze so a stray press
    // never re-anchors it (the accidental-origin-drag complaint). Swallow the press as a
    // hard no-op (no drag, no selection change) rather than fall through to a body drag.
    const parentBone = part.kind === 'bone' && part.parentId
      ? state.doc?.parts.find((pp) => pp.id === part.parentId && pp.kind === 'bone')
      : null;
    const isChildJoint = !!parentBone;
    if (!isChildJoint && !state.freezeMode) return 'handled';
    if (part.id !== state.selectedPartId) {
      selectPart(part.id);
      notify();
    }
    const d: DragState = {
      kind: 'pivot',
      part,
      startPivot: { ...part.pivot },
      startTranslate: ownTranslateOf(part, poseTime()),
      startClient: { x: ev.clientX, y: ev.clientY },
      active: false,
    };
    capturePointer(ev);
    return d;
  },
  move(ev, drag) {
    if (drag.kind !== 'pivot') return;
    const d = drag;
    const p = pointerInRoot(ev);
    const part = d.part;
    const t = poseTime();
    // Snap the target joint position (root space) onto the part's own nodes or other joints.
    let sx = p.x, sy = p.y;
    ctx.snapMarker = null;
    if (snappingActive()) {
      const match = snapPoint({ x: sx, y: sy }, pivotSnapCandidates(part, t), snapThreshold());
      if (match) {
        sx = match.point.x;
        sy = match.point.y;
        ctx.snapMarker = rootToUser(match.point);
      }
    }
    const parentBone = part.kind === 'bone' && part.parentId
      ? state.doc?.parts.find((pp) => pp.id === part.parentId && pp.kind === 'bone')
      : null;
    if (part.kind === 'bone' && parentBone) {
      // A child bone's origin IS the shared joint with its parent's tip. Move the joint by
      // reshaping the PARENT toward the pointer (aim + stretch); the child origin is carried
      // onto the new tip, so the chain never disconnects. Identical to dragging the parent's
      // tip handle. Freeze refreshes the bind so the art stays put; otherwise it deforms.
      aimBoneAtTip(parentBone, { x: sx, y: sy }, t);
      if (state.freezeMode) refreshBindForChain(parentBone.id, t);
      renderPose();
    } else if (part.kind === 'bone') {
      // ROOT bone origin (reached only in freeze): translate the whole chain so every shared
      // joint stays connected, then refresh the bind so the art stays put. Approximate for a
      // chain baked with rest rotation (translateBoneChain), but the anchors stay connected.
      const cur = effectivePivot(part, t);
      const localDelta = applyMat(
        linearOnly(invertMat(chainMatOf(part, t))), sx - cur.x, sy - cur.y,
      );
      translateBoneChain(state.doc!.parts, part.id, round3(localDelta.x), round3(localDelta.y));
      if (state.freezeMode) refreshBindForChain(part.id, t);
      renderPose();
    } else {
      // Art-part pivot (freeze-only): re-anchor the joint WITHOUT moving the artwork. The
      // pivot anchors the part's own rotation AND innermost rest scale/skew, so re-anchoring
      // it shifts the render unless the rest translation absorbs the difference. Solve both:
      // find pivot pv with pv + translate(pv) = pointer, where translate(pv) keeps the
      // drag-start own matrix intact — affine in pv, so one Jacobian step solves it exactly.
      const local = applyMat(invertMat(chainMatOf(part, t)), sx, sy);
      const rot = channelValue(part, 'rotate', t);
      const ownMat = (pv: { x: number; y: number }): Mat =>
        matrixOfTransform(
          // t is poseTime() — null in Setup (where art-pivot drags live), so this reads
          // rest scale; if ever reached in Animate it uses the same effective scale the
          // render shows, keeping the pivot-compensation consistent with the artwork.
          [`rotate(${rot},${pv.x},${pv.y})`, part.transform, innerLocalTransform(part, t, pv)]
            .filter(Boolean)
            .join(' '),
        );
      const m0 = ownMat(d.startPivot);
      const translateFor = (pv: { x: number; y: number }) => {
        // m0 · ownMat(pv)⁻¹ is a pure translation (identical linear parts).
        const dm = multiply(m0, invertMat(ownMat(pv)));
        return { x: d.startTranslate.x + dm.e, y: d.startTranslate.y + dm.f };
      };
      const F = (pv: { x: number; y: number }) => {
        const tn = translateFor(pv);
        return { x: pv.x + tn.x, y: pv.y + tn.y };
      };
      const seed = { x: local.x - d.startTranslate.x, y: local.y - d.startTranslate.y };
      const f0 = F(seed);
      const fx = F({ x: seed.x + 1, y: seed.y });
      const fy = F({ x: seed.x, y: seed.y + 1 });
      const ja = fx.x - f0.x, jb = fx.y - f0.y, jc = fy.x - f0.x, jd = fy.y - f0.y;
      const det = ja * jd - jb * jc;
      let pv = seed;
      if (Math.abs(det) > 1e-9) {
        const rx = local.x - f0.x, ry = local.y - f0.y;
        pv = {
          x: seed.x + (jd * rx - jc * ry) / det,
          y: seed.y + (ja * ry - jb * rx) / det,
        };
      }
      part.pivot = { x: round1(pv.x), y: round1(pv.y) };
      // Recompute the compensation for the ROUNDED pivot so the artwork stays put exactly
      // (finer rounding — 0.1 on the translation would visibly wiggle the art).
      const tn = translateFor(part.pivot);
      part.rest.tx = round3(tn.x);
      part.rest.ty = round3(tn.y);
      renderPose();
    }
  },
};
