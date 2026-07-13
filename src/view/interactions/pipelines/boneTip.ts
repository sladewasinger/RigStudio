/**
 * Bone tip reshape (data-role="bone-tip"): re-aim + stretch the bone, in both editor
 * modes. Must precede `pivot` — a child bone's shared-joint marker sits at the exact same
 * point as its own tip handle, and the tip handle wins the direct press (the pivot branch
 * only ever reaches a PARENT's tip through the child's ORIGIN marker, a different element).
 */

import { state, selectedPart, notify } from '../../../core/model';
import { DragState } from '../../context';
import { pointerInRoot } from '../../coords';
import { poseTime } from '../../pose';
import { renderPose } from '../../render';
import { aimBoneAtTip, refreshBindForChain } from '../../rigOps';
import { startIkDrag, updateIkDrag } from '../../ikDrag';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const BONE_TIP_PIPELINE: GesturePipeline = {
  name: 'boneTip',
  claim(hit, ev) {
    if (!hit.isBoneTip) return null;
    const part = selectedPart();
    if (!part) return 'handled';
    // IK tool: even a direct tip-handle press solves the WHOLE chain (Fix 2) instead of
    // the single-bone aim+stretch below — grabbing the tip is just the on-axis case of a
    // grab-point-relative IK drag (startIkDrag reads the actual press position).
    if (state.tool === 'ik') {
      startIkDrag(part, pointerInRoot(ev), ev);
      notify();
      return 'handled';
    }
    const d: DragState = {
      kind: 'boneTip', part, startClient: { x: ev.clientX, y: ev.clientY }, active: false,
    };
    capturePointer(ev);
    return d;
  },
  move(ev, d) {
    if (d.kind === 'ik') {
      // Full drag pipeline (chain build, FABRIK solve, root-first write-back) lives in
      // ikDrag.ts — see its module doc for the grab-point-relative design (Fix 2).
      updateIkDrag(ev);
      return;
    }
    if (d.kind !== 'boneTip') return;
    const p = pointerInRoot(ev);
    const part = d.part;
    const tt = poseTime();
    // Rotate + stretch the bone toward the pointer; child origins ride the new tip (the
    // shared joint stays connected). Outside freeze the LBS delta rotates+stretches the
    // skinned art (posing the limb from its bones); inside freeze the bind refreshes each
    // move so the art stays put (fitting the rig against static art).
    aimBoneAtTip(part, { x: p.x, y: p.y }, tt);
    if (state.freezeMode) refreshBindForChain(part.id, tt);
    renderPose();
  },
};
