/**
 * Pen-tool bone-chain placement (CLAUDE.md "Bone system — Placement"). A click while the
 * chain tool is armed is NOT a drag — it commits a bone synchronously and re-arms for the
 * next joint — so this pipeline's `claim()` always returns 'handled', never a DragState;
 * the live preview segment between clicks is driven by `updateBoneChainPreview`, which the
 * router calls directly from its pointermove handler (see index.ts) whenever a chain is
 * armed with no drag in flight.
 */

import { state, selectedPart, addNullPart } from '../../../core/model';
import { checkpoint } from '../../../core/history';
import { ctx, MIN_BONE_LENGTH_PX, round1 } from '../../context';
import { pointerInRoot, screenScaleOf } from '../../coords';
import { poseTime, fullPoseTransform, effectiveTip } from '../../pose';
import { applyMat, invertMat, matrixOfTransform } from '../../../geometry/transforms';
import { renderOverlay } from '../../overlay';
import { renderPose } from '../../render';
import { registerPart } from '../../partDom';
import { GesturePipeline } from '../priority';

export const BONE_CHAIN_PIPELINE: GesturePipeline = {
  name: 'boneChain',
  claim(_hit, ev) {
    // PEN-TOOL BONE CHAINS: the bone tool arms CHAIN mode. A left click either starts the
    // chain (sets the pending origin — anchored at a selected bone's tip so a chain
    // continues) or commits a bone origin→click and advances the origin to that new tip.
    // A click is NOT a drag (no ctx.drag), so middle-drag pan + wheel zoom stay live during
    // chaining and selection never changes. Escape/Enter/double-click finish (endBoneChain).
    if (!((ctx.placingBone || ctx.boneChain) && ev.button === 0)) return null;
    const p = pointerInRoot(ev);
    boneChainClick({ x: p.x, y: p.y });
    return 'handled';
  },
};

/**
 * Handle one pen-tool chain click at `clickRoot` (root/doc space). The FIRST click of a
 * chain seeds ctx.boneChain: with a bone selected the origin anchors at that bone's
 * effective tip (so a chain continues joint-to-joint) and the first bone parents to it;
 * with an art OR GROUP selected the first bone parents to it (hierarchy-as-assignment —
 * Group-level auto-bind then expands the eventual bind set to every art descendant of a
 * group anchor, `rigOps.ts`'s `autoBindPlacedBone`); otherwise a free-form root. Each
 * SUBSEQUENT click commits a bone origin→click (deferring the ONE chain checkpoint to this
 * first commit) and advances the origin to the new tip. A click closer than
 * MIN_BONE_LENGTH to the pending origin commits nothing (mis-click / the second click of a
 * finishing double-click).
 */
function boneChainClick(clickRoot: { x: number; y: number }): void {
  if (!ctx.boneChain) {
    const sel = selectedPart();
    const anchor = sel && (sel.kind === 'art' || sel.kind === 'bone' || sel.kind === 'group')
      ? sel : null;
    const origin = anchor && anchor.kind === 'bone'
      ? effectiveTip(anchor, poseTime()) ?? clickRoot
      : clickRoot;
    ctx.boneChain = {
      origin: { x: origin.x, y: origin.y },
      parentId: anchor ? anchor.id : null,
      committed: [],
      checkpointed: false,
      cursor: null,
    };
    renderOverlay(); // show the chain-origin marker immediately
    return;
  }
  const ch = ctx.boneChain;
  const minLen = MIN_BONE_LENGTH_PX / screenScaleOf();
  if (Math.hypot(clickRoot.x - ch.origin.x, clickRoot.y - ch.origin.y) < minLen) return;
  if (!ch.checkpointed) { checkpoint(); ch.checkpointed = true; } // ONE checkpoint per chain
  const parentId = ch.committed.length > 0 ? ch.committed[ch.committed.length - 1] : ch.parentId;
  const bone = commitBone(ch.origin, clickRoot, parentId);
  ch.committed.push(bone.id);
  ch.origin = { x: clickRoot.x, y: clickRoot.y };
  ch.cursor = null;
  renderPose(); // the committed bone is now a real part → draw its glyph + refresh chrome
}

/**
 * Create one chain bone origin→tip (root/doc space) under `parentId`, converting both into
 * the parent's local frame — which equals the fresh bone's OWN frame, since a just-created
 * bone's own pose is identity (rotate 0). Mirrors the old press-drag-release finalizer.
 */
function commitBone(
  originRoot: { x: number; y: number }, tipRoot: { x: number; y: number }, parentId: string | null,
) {
  const t = poseTime();
  const parent = parentId ? state.doc?.parts.find((p) => p.id === parentId) ?? null : null;
  const inv = parent ? invertMat(matrixOfTransform(fullPoseTransform(parent, t))) : null;
  const toLocal = (pt: { x: number; y: number }) => (inv ? applyMat(inv, pt.x, pt.y) : pt);
  const oL = toLocal(originRoot);
  const tL = toLocal(tipRoot);
  const bone = addNullPart('bone', { x: round1(oL.x), y: round1(oL.y) }, parentId);
  bone.boneTip = { x: round1(tL.x), y: round1(tL.y) };
  registerPart(bone);
  return bone;
}

/** Pen-tool chain preview: the router calls this directly (no drag in flight — a click
 *  isn't a drag) whenever a chain is armed, mirroring the old pointermove's early branch. */
export function updateBoneChainPreview(ev: PointerEvent): void {
  const p = pointerInRoot(ev);
  ctx.boneChain!.cursor = { x: p.x, y: p.y };
  renderOverlay();
}
