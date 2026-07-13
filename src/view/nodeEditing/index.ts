/**
 * Bezier node editing (Setup mode) — public facade.
 *
 * Implemented across three modules, layered `dragMath.ts` ← `structural.ts` /
 * `typeOps.ts` (both depend on dragMath's shared node-index/nodeTypes/segment-geometry
 * primitives; dragMath depends on neither): `dragMath.ts` (node/handle drag with
 * smooth-node mirroring, arrow-key nudge, and the segment geometry helpers the bend
 * pipeline elsewhere also uses), `structural.ts` (the chokepoint plus insert/delete/
 * join/close/reverse wiring and eligibility predicates), `typeOps.ts` (the one-shot
 * inspector ops: smooth/symmetric/retract/toCurve/toLine, plus node-selection
 * introspection). This file re-exports exactly the surface those three, plus the one
 * external caller outside `view/nodeEditing/` (the bend pipeline in
 * `view/interactions/pipelines/nodesBendMarquee.ts`), consume — nothing outside this
 * package reaches a deep path.
 *
 * THREE-WAY LOCKSTEP INVARIANT: any edit that changes a path's drawing-COMMAND COUNT
 * (Z excluded) must, together — (a) resplice `RigPath.nodeTypes` (one char per
 * command) to match, (b) drop a skinned part's per-node weight overrides on that path
 * (keyed by command index — CLAUDE.md's Bone system "What drops overrides") and
 * invalidate the cached weights, (c) resync the DOM. `structural.ts`'s
 * `applyStructuralEdit` is the ONE door that bundle passes through; every command-
 * count-changing write in this package, and the bend pipeline's implicit-Z split, call
 * it. Index-PRESERVING writes (plain node/handle drags, one-shot type ops, arrow
 * nudges) never change command count, so they keep overrides and skip this door
 * entirely — structurally enforced by `__tests__/nodeEditingChokepoint.test.ts`.
 */

export {
  nodeIndexOf, ensureNodeTypes, segmentStart, pointOnSegment, segmentHit, subpathStart,
  applyMirrorConstraint, moveNode, nudgeSelectedNodes,
} from './dragMath';
export {
  applyStructuralEdit, editNodeStructure, deleteSelectedNodes,
  canDeleteSegment, canJoinNodes, deleteSelectedSegment, joinSelectedNodes,
} from './structural';
export {
  hasSelectedNode, selectedNodeCount, selectAllNodes, primaryNodeType, applyNodeOp,
} from './typeOps';
export type { NodeOp } from './typeOps';
