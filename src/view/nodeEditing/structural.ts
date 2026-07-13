/**
 * THE chokepoint (`applyStructuralEdit`) plus every command-count-changing node op:
 * insert/delete a single node (Alt/Ctrl+click), multi-node delete, and the
 * join/delete-segment/close wiring around `geometry/paths.ts`'s pure subpath ops
 * (`deleteSegment`/`closePath`/`joinPaths`), with their eligibility predicates
 * (`canJoinNodes`/`canDeleteSegment`) for the inspector's button disabled-state.
 *
 * THREE-WAY LOCKSTEP INVARIANT (see `view/nodeEditing/index.ts`'s package doc): any
 * edit that changes a path's drawing-COMMAND COUNT (Z excluded) must splice
 * `RigPath.nodeTypes` to match, drop that path's skin overrides (keyed by command
 * index) and invalidate the cached weights, and resync the DOM — in that bundle,
 * always. `applyStructuralEdit` is the ONE door that bundle passes through; every
 * function below routes its command-count-changing write through it, and so does the
 * bend pipeline's implicit-Z split (`view/interactions/pipelines/
 * nodesBendMarquee.ts`, the one caller of this package outside `view/nodeEditing/`
 * itself). Enforced structurally by `__tests__/nodeEditingChokepoint.test.ts`.
 */

import {
  RigPath, RigPart, state, notify, selectedPart, freshId, dropSkinOverridesForPath,
} from '../../core/model';
import {
  parsePath, serializePath, insertNodeAfter, PathPiece,
  deleteSegment, closePath, joinPaths, isSingleSubpath, isClosedPath, nodeCount,
} from '../../geometry/paths';
import { checkpoint } from '../../core/history';
import { ctx, DragState, parseNodeKey } from '../context';
import { renderPose } from '../render';
import { syncPartPathDom } from '../partDom';
import { invalidateSkinCache } from '../skinRender';
import { renderOverlay } from '../overlay';
import { nodeIndexOf, ensureNodeTypes } from './dragMath';

/**
 * THE chokepoint (see the file header's THREE-WAY LOCKSTEP INVARIANT): commit a
 * command-count-changing edit to `path` — write its `d`/`nodeTypes`, drop its skin
 * overrides (a no-op for an unskinned part or one with none on this path) and
 * invalidate the cached weights, resync the DOM (`syncPartPathDom` — also reconciles
 * path ELEMENTS when the caller already spliced/filtered `part.paths`, not just this
 * path's `d`), and clear the node selection (command indexes just shifted, so any prior
 * selection would now point at the wrong nodes). `edit` is a `PathPiece` — the shape
 * `geometry/paths.ts`'s pure structural ops (`deleteSegment`/`closePath`/`joinPaths`)
 * already return, so their output plugs in directly.
 */
export function applyStructuralEdit(part: RigPart, path: RigPath, edit: PathPiece): void {
  path.d = serializePath(edit.cmds);
  path.nodeTypes = edit.nodeTypes;
  dropSkinOverridesForPath(part, path.id);
  invalidateSkinCache(part.id);
  syncPartPathDom(part);
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
}

export function editNodeStructure(d: Extract<DragState, { kind: 'node' }>, op: 'insert' | 'delete'): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const cmds = parsePath(path.d);
  let nodeTypes = path.nodeTypes ? ensureNodeTypes(path) : null;
  const ni = nodeIndexOf(cmds, d.cmdIndex);
  const countBefore = cmds.filter((c) => c.cmd !== 'Z').length;
  if (op === 'insert') {
    if (!insertNodeAfter(cmds, d.cmdIndex)) return;
    if (nodeTypes) {
      // New nodes appear right after this one; splitting a segment makes them smooth.
      const added = cmds.filter((c) => c.cmd !== 'Z').length - countBefore;
      nodeTypes = nodeTypes.slice(0, ni + 1) + 's'.repeat(added) + nodeTypes.slice(ni + 1);
    }
  } else {
    if (cmds.length <= 3 || cmds[d.cmdIndex].cmd === 'M') return;
    cmds.splice(d.cmdIndex, 1);
    if (nodeTypes) nodeTypes = nodeTypes.slice(0, ni) + nodeTypes.slice(ni + 1);
  }
  applyStructuralEdit(d.part, path, { cmds, nodeTypes });
  renderOverlay();
}

/** Delete every selected node (kept above each path's minimum). Main wires Delete. */
export function deleteSelectedNodes(): boolean {
  const part = selectedPart();
  if (!part || ctx.selectedNodes.size === 0) return false;
  let changed = false;
  const byPath = new Map<string, number[]>();
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    if (!byPath.has(pathId)) byPath.set(pathId, []);
    byPath.get(pathId)!.push(cmdIndex);
  }
  for (const [pathId, indexes] of byPath) {
    const path = part.paths.find((p) => p.id === pathId);
    if (!path) continue;
    const cmds = parsePath(path.d);
    let list = path.nodeTypes ? ensureNodeTypes(path) : null;
    let touched = false;
    // Highest index first so earlier indexes stay valid while splicing.
    for (const idx of [...indexes].sort((a, b) => b - a)) {
      if (cmds.length <= 3 || !cmds[idx] || cmds[idx].cmd === 'M') continue;
      const ni = nodeIndexOf(cmds, idx);
      cmds.splice(idx, 1);
      if (list) list = list.slice(0, ni) + list.slice(ni + 1);
      touched = true;
    }
    if (touched) {
      applyStructuralEdit(part, path, { cmds, nodeTypes: list });
      changed = true;
    }
  }
  if (changed) renderOverlay();
  return changed;
}

// ---- Structural node ops: break a segment, weld/bridge two ends (inspector buttons) ----

interface SelectedNodeRef { path: RigPath; cmdIndex: number; }

/** The currently selected endpoint nodes resolved to their paths (within the part). */
function selectedNodeRefs(): SelectedNodeRef[] {
  const part = selectedPart();
  if (!part) return [];
  const refs: SelectedNodeRef[] = [];
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const path = part.paths.find((p) => p.id === pathId);
    if (path) refs.push({ path, cmdIndex });
  }
  return refs;
}

/** Which free end of an OPEN single subpath a node command index is, or null. */
function endOfOpenPath(path: RigPath, cmdIndex: number): 'start' | 'end' | null {
  const cmds = parsePath(path.d);
  if (!isSingleSubpath(cmds) || isClosedPath(cmds)) return null;
  const D = nodeCount(cmds);
  if (cmdIndex === 0) return 'start';
  if (cmdIndex === D - 1) return 'end';
  return null;
}

/** True when exactly two selected nodes are an adjacent, deletable segment of one path. */
export function canDeleteSegment(): boolean {
  const refs = selectedNodeRefs();
  if (refs.length !== 2 || refs[0].path.id !== refs[1].path.id) return false;
  const path = refs[0].path;
  return deleteSegment(
    parsePath(path.d), path.nodeTypes ?? null, refs[0].cmdIndex, refs[1].cmdIndex,
  ) != null;
}

/** True when exactly two selected nodes are joinable END nodes (same path or two paths). */
export function canJoinNodes(): boolean {
  const refs = selectedNodeRefs();
  if (refs.length !== 2) return false;
  const e0 = endOfOpenPath(refs[0].path, refs[0].cmdIndex);
  const e1 = endOfOpenPath(refs[1].path, refs[1].cmdIndex);
  if (!e0 || !e1) return false;
  if (refs[0].path.id === refs[1].path.id) return e0 !== e1; // the two distinct ends
  return true;
}

/** Break the segment between the two selected adjacent nodes (FEATURE: del seg). */
export function deleteSelectedSegment(): boolean {
  const part = selectedPart();
  const refs = selectedNodeRefs();
  if (!part || refs.length !== 2 || refs[0].path.id !== refs[1].path.id) return false;
  const path = refs[0].path;
  const pieces = deleteSegment(
    parsePath(path.d), path.nodeTypes ?? null, refs[0].cmdIndex, refs[1].cmdIndex,
  );
  if (!pieces || pieces.length === 0) return false;
  checkpoint();
  const idx = part.paths.indexOf(path);
  // Splice any extra split-off pieces in FIRST so the chokepoint's DOM sync (below)
  // sees the final part.paths array in one pass instead of needing a second sync.
  const extra: RigPath[] = pieces.slice(1).map((piece, k) => ({
    ...path,
    id: freshId('path'),
    label: `${path.label}·${k + 2}`,
    d: serializePath(piece.cmds),
    nodeTypes: piece.nodeTypes,
  }));
  part.paths.splice(idx + 1, 0, ...extra);
  applyStructuralEdit(part, path, pieces[0]);
  state.selectedPathId = null; // un-scope so both resulting pieces stay node-selectable
  renderPose();
  notify();
  return true;
}

/** Weld (merge) or bridge the two selected end nodes (FEATURE: join / join seg). */
export function joinSelectedNodes(mode: 'weld' | 'segment'): boolean {
  const part = selectedPart();
  const refs = selectedNodeRefs();
  if (!part || refs.length !== 2) return false;
  const e0 = endOfOpenPath(refs[0].path, refs[0].cmdIndex);
  const e1 = endOfOpenPath(refs[1].path, refs[1].cmdIndex);
  if (!e0 || !e1) return false;

  // Same open path → close it.
  if (refs[0].path.id === refs[1].path.id) {
    if (e0 === e1) return false;
    const path = refs[0].path;
    const piece = closePath(parsePath(path.d), path.nodeTypes ?? null, mode);
    if (!piece) return false;
    checkpoint();
    applyStructuralEdit(part, path, piece);
    renderPose();
    notify();
    return true;
  }

  // Two different open paths in the same part → merge; the earlier path survives.
  let first = refs[0], firstEnd = e0, second = refs[1], secondEnd = e1;
  if (part.paths.indexOf(refs[1].path) < part.paths.indexOf(refs[0].path)) {
    first = refs[1]; firstEnd = e1; second = refs[0]; secondEnd = e0;
  }
  const piece = joinPaths(
    { cmds: parsePath(first.path.d), nodeTypes: first.path.nodeTypes ?? null, end: firstEnd },
    { cmds: parsePath(second.path.d), nodeTypes: second.path.nodeTypes ?? null, end: secondEnd },
    mode,
  );
  if (!piece) return false;
  checkpoint();
  const removedId = second.path.id;
  // The removed path had its own (now-dangling) overrides, separate from the surviving
  // first.path's — applyStructuralEdit only owns the SURVIVOR's, so drop these directly.
  dropSkinOverridesForPath(part, removedId);
  invalidateSkinCache(part.id);
  part.paths = part.paths.filter((p) => p.id !== removedId);
  applyStructuralEdit(part, first.path, piece);
  state.selectedPathId = null;
  renderPose();
  notify();
  return true;
}
