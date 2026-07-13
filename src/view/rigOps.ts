/**
 * Rig-structure operations invoked from the toolbar / inspector / keyboard — public
 * re-export facade over the rigOps cluster.
 *
 * Implemented across `rigOpsEdit.ts` (Setup flips, arrow-key nudge, align/distribute
 * application, distributed group-scale, bone aim/reshape + child-origin carry),
 * `rigOpsBind.ts` (linear-blend skin bind/unbind + the freeze-mode bind-refresh cycle),
 * `rigOpsNodeBinding.ts` (per-node skin weight override refinement),
 * `rigOpsPlacement.ts` (pen-tool bone-chain placement lifecycle + Bones 2.0 auto-bind
 * targeting), and `rigOpsAttach.ts` (Unified Skeleton Phase 1: world-preserving
 * cross-chain bone attach/detach for the Layers drag). These mutate the doc (rest pose,
 * geometry, skin) and repaint; the caller checkpoints history where appropriate. This
 * file re-exports exactly the surface `view/index.ts` and `view/interactions.ts`
 * consume; nothing outside those two reaches past it into a submodule, and no submodule
 * imports this facade back.
 */

export {
  flipSelected, groupScaleMembers, applyGroupScale, nudgeSelectedParts, applyRootDeltas,
  movePathToPart, pathMoveRefusal, aimBoneAtTip, carryChildOrigins,
} from './rigOpsEdit';
export type { GroupScaleMember } from './rigOpsEdit';

export { reattachRootBone } from './rigOpsAttach';

export {
  bindPartsToBones, bindSelectedToBones, unbindSelectedSkin,
  refreshBindForChain, refreshFrozenSkinWeights, captureFrozenBaseline, rebindFrozenChain,
} from './rigOpsBind';

export {
  primaryNodeBinding, setNodeBinding, quickNodeBindTarget, bindSelectedNodesToBone,
  clearNodeBinding, resetNodeBindings, recomputeAutoWeights,
} from './rigOpsNodeBinding';
export type { NodeBindingInfo } from './rigOpsNodeBinding';

export {
  autoBindPlacedBone, startBonePlacement, cancelBonePlacement, endBoneChain,
} from './rigOpsPlacement';
