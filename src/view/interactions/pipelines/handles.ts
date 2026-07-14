/**
 * The classic Inkscape-style Setup handle set on the primary selected part: corner/side
 * SCALE handles, side SKEW handles (both Setup-only), and the corner ROTATE handles
 * (rendered — and draggable — in both Edit and Animate, see overlayHandles.ts). Three
 * DOM-distinct hit targets with nothing else interleaved between them in the old cascade,
 * so one pipeline claims all three in their original sub-order.
 */

import {
  state, RigPart, selectedPart, selectedParts, channelValue, ancestorChain, isGroupLike,
} from '../../../core/model';
import {
  DragState, MIN_SCALE, MAX_SCALE, linearOnly, round1, round2, partOwnBBox,
} from '../../context';
import { handleSize, pointerInRoot } from '../../coords';
import { poseTime, groupTransformOf, chainMatOf, effectivePivot } from '../../pose';
import { applyMat, invertMat, matrixOfTransform } from '../../../geometry/transforms';
import { renderPose } from '../../render';
import { groupScaleMembers, applyGroupScale, GroupScaleMember } from '../../rigOps';
import { groupLikeUnionBox } from '../../overlayHandles';
import { capturePointer, moveRotate } from '../lifecycle';
import { GesturePipeline } from '../priority';

/**
 * The members a group-scale drag distributes across: `groupScaleMembers`'s descendant
 * set PLUS the group-like part's OWN geometry when it has paths (art-with-children —
 * Pip's `face`: its mouth should grow with the rest of the composite, not sit frozen
 * while `eyes` scales around it). The self-entry's `startPivotRoot` equals the drag's
 * own `pivotRoot` exactly (both read `effectivePivot(part, t)` at the same instant), so
 * `applyGroupScale`'s point-scale formula resolves its target to `pivotRoot` unchanged —
 * the part's own joint never moves, only its rest.sx/sy and the tx/ty that keeps the
 * pivot pinned, exactly like the group's own-pivot anchor invariant for a partless
 * `group` null. Re-sorted ancestor-first (matching `groupScaleMembers`) so a descendant
 * (e.g. `eyes`) reads the self-member's WRITTEN rest via `chainMatOf` before its own
 * turn, the same ordering guarantee `groupScaleMembers` documents.
 */
function scaleMembersFor(part: RigPart, t: number | null): GroupScaleMember[] {
  const members = groupScaleMembers(part, t);
  if (part.paths.length > 0) {
    members.push({
      part, startSx: part.rest.sx, startSy: part.rest.sy, startPivotRoot: effectivePivot(part, t),
    });
    members.sort((a, b) => ancestorChain(a.part).length - ancestorChain(b.part).length);
  }
  return members;
}

type Spot = { g: { x: number; y: number }; a: { x: number; y: number } };

/** The 8 scale-handle / 4 skew-handle anchor spots around a padded box — shared geometry
 *  for both handle families. */
function handleSpots(x0: number, y0: number, x1: number, y1: number): Record<string, Spot> {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    nw: { g: { x: x0, y: y0 }, a: { x: x1, y: y1 } },
    ne: { g: { x: x1, y: y0 }, a: { x: x0, y: y1 } },
    se: { g: { x: x1, y: y1 }, a: { x: x0, y: y0 } },
    sw: { g: { x: x0, y: y1 }, a: { x: x1, y: y0 } },
    n: { g: { x: cx, y: y0 }, a: { x: cx, y: y1 } },
    s: { g: { x: cx, y: y1 }, a: { x: cx, y: y0 } },
    e: { g: { x: x1, y: cy }, a: { x: x0, y: cy } },
    w: { g: { x: x0, y: cy }, a: { x: x1, y: cy } },
  };
}

export const HANDLES_PIPELINE: GesturePipeline = {
  name: 'handles',
  claim(hit, ev) {
    // ---- Scale handle (Setup mode). A GROUP has no artwork/local frame of its own — its
    // handle grabs the root-space union bbox (groupUnionBox, same box the dashed outline
    // draws) and starts a DISTRIBUTED rest edit across every descendant instead of the
    // single-part pipeline below (rigOps.ts's groupScaleMembers/applyGroupScale).
    if (hit.scaleHandle) {
      const part = selectedPart();
      if (!part) return 'handled';
      if (isGroupLike(part, hit.doc.parts)) {
        const ub = groupLikeUnionBox(part);
        if (!ub) return 'handled'; // nothing inside yet — nothing to scale
        const t = poseTime();
        const pad = handleSize() * 0.8; // matches overlayHandles.ts's group-box padding
        const spots = handleSpots(ub.x0 - pad, ub.y0 - pad, ub.x1 + pad, ub.y1 + pad);
        const grab = spots[hit.scaleHandle]?.g;
        if (!grab) return 'handled';
        const d: DragState = {
          kind: 'groupScale',
          group: part,
          handle: hit.scaleHandle,
          pivotRoot: effectivePivot(part, t),
          grabRoot: grab,
          members: scaleMembersFor(part, t),
          poseT: t,
          current: null,
          startClient: { x: ev.clientX, y: ev.clientY },
          active: false,
        };
        capturePointer(ev);
        return d;
      }
      const box = partOwnBBox(part.id); // union across every run (U2 interleaving)
      if (!box) return 'handled';
      const pad = handleSize() * 0.6;
      const spots = handleSpots(box.x - pad, box.y - pad, box.x + box.width + pad, box.y + box.height + pad);
      const spot = spots[hit.scaleHandle];
      if (!spot) return 'handled';
      const t = poseTime();
      // groupTransformOf is the part's full rootGroup-relative transform; frozen at
      // drag start so scale factors are measured in a stable local frame.
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      const chainM = chainMatOf(part, t);
      const d: DragState = {
        kind: 'scale',
        part,
        handle: hit.scaleHandle,
        startSx: part.rest.sx, startSy: part.rest.sy,
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainM)),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      capturePointer(ev);
      return d;
    }

    // ---- Skew handle (Setup mode, rotate handle set): shear along the box edge with the
    // opposite edge pinned — Inkscape's rotate-mode side handles.
    if (hit.skewSide) {
      const part = selectedPart();
      const box = part ? partOwnBBox(part.id) : null; // union across every run
      if (!part || !box) return 'handled';
      const pad = handleSize() * 0.6;
      const spots = handleSpots(box.x - pad, box.y - pad, box.x + box.width + pad, box.y + box.height + pad);
      const side = hit.skewSide as 'n' | 'e' | 's' | 'w';
      const spot = spots[side];
      const t = poseTime();
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      const d: DragState = {
        kind: 'skew',
        part,
        side,
        startTanKx: Math.tan((part.rest.kx * Math.PI) / 180),
        startTanKy: Math.tan((part.rest.ky * Math.PI) / 180),
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainMatOf(part, t))),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      capturePointer(ev);
      return d;
    }

    // ---- Rotate handle (rotate/skew handle set's corner circles): spin the rest pose in
    // Edit, or key rotate at the playhead in Animate (these render — and drag identically —
    // in BOTH modes; overlayHandles.ts's bug-fix comment explains why).
    if (hit.isRotateHandle) {
      const part = selectedPart();
      if (!part) return 'handled';
      const p = pointerInRoot(ev);
      const setup = state.editorMode === 'setup';
      const pivot = effectivePivot(part, poseTime());
      const startAngle0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
      const d: DragState = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({
          part: sp,
          start: setup ? sp.rest.rotate : channelValue(sp, 'rotate', state.currentTime),
        })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: startAngle0,
        lastAngle: startAngle0,
        accumDeg: 0,
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      capturePointer(ev);
      return d;
    }
    return null;
  },
  move(ev, d) {
    if (d.kind === 'groupScale') {
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const clampF = (f: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, f));
      let fx = 1, fy = 1;
      const denX = d.grabRoot.x - d.pivotRoot.x;
      const denY = d.grabRoot.y - d.pivotRoot.y;
      if (Math.abs(denX) > 1e-6) fx = clampF((p.x - d.pivotRoot.x) / denX);
      if (Math.abs(denY) > 1e-6) fy = clampF((p.y - d.pivotRoot.y) / denY);
      if (['n', 's'].includes(d.handle)) fx = 1;
      if (['e', 'w'].includes(d.handle)) fy = 1;
      if (ev.ctrlKey && !['n', 's', 'e', 'w'].includes(d.handle)) {
        const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
        fx = f; fy = f;
      }
      applyGroupScale(d.members, d.poseT, d.pivotRoot, fx, fy);
      renderPose();
    } else if (d.kind === 'scale') {
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampF = (f: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, f));
      let fx = 1, fy = 1;
      const denX = d.grabLocal.x - d.anchorLocal.x;
      const denY = d.grabLocal.y - d.anchorLocal.y;
      if (Math.abs(denX) > 1e-6) fx = clampF((local.x - d.anchorLocal.x) / denX);
      if (Math.abs(denY) > 1e-6) fy = clampF((local.y - d.anchorLocal.y) / denY);
      if (['n', 's'].includes(d.handle)) fx = 1;
      if (['e', 'w'].includes(d.handle)) fy = 1;
      if (ev.ctrlKey && !['n', 's', 'e', 'w'].includes(d.handle)) {
        const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
        fx = f; fy = f;
      }
      d.part.rest.sx = round2(d.startSx * fx);
      d.part.rest.sy = round2(d.startSy * fy);
      // Keep the anchor (opposite corner/side) pinned: measure where it lands with the
      // new scale and push the difference back into the rest translation.
      d.part.rest.tx = d.startTx;
      d.part.rest.ty = d.startTy;
      const mNew = matrixOfTransform(groupTransformOf(d.part, poseTime()));
      const after = applyMat(mNew, d.anchorLocal.x, d.anchorLocal.y);
      const deltaLocal = applyMat(
        d.invChainLinear, d.anchorRoot.x - after.x, d.anchorRoot.y - after.y,
      );
      d.part.rest.tx = round1(d.startTx + deltaLocal.x);
      d.part.rest.ty = round1(d.startTy + deltaLocal.y);
      renderPose();
    } else if (d.kind === 'skew') {
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampTan = (v: number) => Math.min(11.4, Math.max(-11.4, v)); // ±≈85°
      if (d.side === 'n' || d.side === 's') {
        // Horizontal shear: displacement along x relative to the pinned edge's height.
        const h = d.grabLocal.y - d.anchorLocal.y;
        if (Math.abs(h) > 1e-6) {
          const tan = clampTan(d.startTanKx + (local.x - d.grabLocal.x) / h);
          d.part.rest.kx = round1((Math.atan(tan) * 180) / Math.PI);
        }
      } else {
        const w = d.grabLocal.x - d.anchorLocal.x;
        if (Math.abs(w) > 1e-6) {
          const tan = clampTan(d.startTanKy + (local.y - d.grabLocal.y) / w);
          d.part.rest.ky = round1((Math.atan(tan) * 180) / Math.PI);
        }
      }
      // Pin the opposite edge midpoint, same recipe as the scale drag.
      d.part.rest.tx = d.startTx;
      d.part.rest.ty = d.startTy;
      const mNew = matrixOfTransform(groupTransformOf(d.part, poseTime()));
      const after = applyMat(mNew, d.anchorLocal.x, d.anchorLocal.y);
      const deltaLocal = applyMat(
        d.invChainLinear, d.anchorRoot.x - after.x, d.anchorRoot.y - after.y,
      );
      d.part.rest.tx = round1(d.startTx + deltaLocal.x);
      d.part.rest.ty = round1(d.startTy + deltaLocal.y);
      renderPose();
    } else if (d.kind === 'rotate') {
      moveRotate(ev, d);
    }
  },
};
