/**
 * The editing canvas — public facade.
 *
 * The canvas view is implemented across `src/view/*` layers (context → coords/pose/focus
 * → skinRender → overlay/snapping → render → partDom/rigOps/nodeEditing/camera →
 * interactions → canvas). This module re-exports the surface that the rest of the app
 * (main, panels, timeline, smPanel) consumes; nothing outside `src/view/` reaches past
 * it into a submodule. The layers themselves never import this facade.
 *
 * Editing modes (state.editorMode): Setup edits the character itself, Inkscape-style
 * (handles scale/rotate/skew the rest pose, pivots and node editing are available);
 * Animate records keyframes (keyed values are ABSOLUTE, the rest pose fills only unkeyed
 * channels). The V/select tool is mode-consistent in both: a body drag TRANSLATES in the
 * translate/scale handle set (first click) and ROTATES around the pivot in the rotate/skew
 * set (second click); Shift always translates. A double-click DIVES into a group (enters
 * it without selecting); the next click selects a child, deeper double-clicks dive further,
 * then into path/node scope; Escape / blank click steps out one level. Scroll wheel zooms
 * around the cursor, middle-drag pans, resetView re-fits.
 */

export { buildCanvas } from './canvas';
export { partRootBoxes } from './pose';
export { clearGroupEntry, enterGroupsFor, stepOutFocus, resetInteractionState } from './focus';
export { renderPose, setPoseSampler, resetSkinRenderWarnings } from './render';
export { updatePathAttrs, reorderCanvas, registerPart, unregisterPart } from './partDom';
export {
  hasSelectedNode, selectedNodeCount, selectAllNodes, primaryNodeType, applyNodeOp,
  deleteSelectedNodes, nudgeSelectedNodes, canDeleteSegment, canJoinNodes,
  deleteSelectedSegment, joinSelectedNodes,
} from './nodeEditing';
export type { NodeOp } from './nodeEditing';
export {
  flipSelected, nudgeSelectedParts, applyRootDeltas, bindSelectedToBones,
  bindPartsToBones, autoBindPlacedBone, unbindSelectedSkin,
  startBonePlacement, cancelBonePlacement, endBoneChain, rebindFrozenChain,
  primaryNodeBinding, setNodeBinding, clearNodeBinding, resetNodeBindings,
  recomputeAutoWeights, bindSelectedNodesToBone, quickNodeBindTarget,
} from './rigOps';
export type { NodeBindingInfo } from './rigOps';
export { resetView, zoomBy } from './camera';
