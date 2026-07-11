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
 * (drag MOVES a part, handles scale/rotate/skew the rest pose, pivots and node editing
 * are available, double-click drills group → part → path). Animate rotates parts around
 * their pivots (Shift translates) and records keyframes; keyed values are ABSOLUTE and
 * the rest pose fills only unkeyed channels. Scroll wheel zooms around the cursor,
 * middle-drag pans, resetView re-fits.
 */

export { buildCanvas } from './view/canvas';
export { partRootBoxes } from './view/pose';
export { clearGroupEntry, enterGroupsFor } from './view/focus';
export { renderPose, setPoseSampler } from './view/render';
export { updatePathAttrs, reorderCanvas, registerPart, unregisterPart } from './view/partDom';
export {
  hasSelectedNode, selectedNodeCount, selectAllNodes, primaryNodeType, applyNodeOp,
  deleteSelectedNodes, nudgeSelectedNodes, canDeleteSegment, canJoinNodes,
  deleteSelectedSegment, joinSelectedNodes,
} from './view/nodeEditing';
export type { NodeOp } from './view/nodeEditing';
export {
  flipSelected, nudgeSelectedParts, applyRootDeltas, bindSelectedToBones,
  unbindSelectedSkin, startBonePlacement, cancelBonePlacement,
} from './view/rigOps';
export { resetView, zoomBy } from './view/camera';
