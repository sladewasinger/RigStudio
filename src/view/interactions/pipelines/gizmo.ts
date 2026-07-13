/**
 * Transform-gizmo handles: the translate arrows/free-move square (data-gizmo-axis) and the
 * rotate ring (data-role="gizmo-ring"). Two render sources share this exact hit surface —
 * the unified select-tool gizmo (rotate ring + move cross, tool==='select') and the
 * dedicated translate/rotate tool gizmo (`overlay.ts`) — so one pipeline claims both.
 * Drawn on TOP of the Setup handle set and artwork, so it must win over both (must precede
 * `handles` and `artwork` in the priority table).
 */

import { state, selectedPart, selectedParts, channelValue } from '../../../core/model';
import { DragState, linearOnly } from '../../context';
import { pointerInRoot } from '../../coords';
import { poseTime, chainMatOf, effectivePivot } from '../../pose';
import { invertMat } from '../../../geometry/transforms';
import { capturePointer, moveTranslate, moveRotate } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const GIZMO_PIPELINE: GesturePipeline = {
  name: 'gizmo',
  claim(hit, ev) {
    if (hit.gizmoAxis) {
      const part = selectedPart();
      if (!part) return 'handled';
      const p = pointerInRoot(ev);
      const t = poseTime();
      const setup = state.editorMode === 'setup';
      const axisAttr = hit.gizmoAxis;
      const d: DragState = {
        kind: 'translate',
        // Bones never translate (see the body-drag branch); the arrows only move art/nulls.
        targets: selectedParts().filter((sp) => sp.kind !== 'bone').map((sp) => ({
          part: sp,
          startTx: setup ? sp.rest.tx : channelValue(sp, 'tx', state.currentTime),
          startTy: setup ? sp.rest.ty : channelValue(sp, 'ty', state.currentTime),
          invLinear: linearOnly(invertMat(chainMatOf(sp, t))),
        })),
        startX: p.x, startY: p.y,
        current: { x: p.x, y: p.y },
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
        axis: axisAttr === 'x' || axisAttr === 'y' ? axisAttr : null,
        toggleOnClick: false,
      };
      capturePointer(ev);
      return d;
    }
    if (hit.isGizmoRing) {
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
    if (d.kind === 'translate') moveTranslate(ev, d);
    else if (d.kind === 'rotate') moveRotate(ev, d);
  },
};
