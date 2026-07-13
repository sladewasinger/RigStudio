/**
 * THE chokepoint (`applyStructuralEdit`) plus every command-count-changing node op:
 * delete a single node (Ctrl+click), insert one at an exact clicked point on a segment
 * (Alt+click — CLAUDE.md item 1), multi-node delete, and the join/delete-segment/close
 * wiring around `geometry/paths.ts`'s pure subpath ops (`deleteSegment`/`closePath`/
 * `joinPaths`), with their eligibility predicates (`canJoinNodes`/`canDeleteSegment`)
 * for the inspector's button disabled-state.
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
  parsePath, serializePath, PathPiece, PathCmd, arcToCubics,
  deleteSegment, closePath, joinPaths, isSingleSubpath, isClosedPath, nodeCount,
} from '../../geometry/paths';
import { checkpoint } from '../../core/history';
import { ctx, DragState, parseNodeKey } from '../context';
import { renderPose } from '../render';
import { syncPartPathDom } from '../partDom';
import { invalidateSkinCache } from '../skinRender';
import { renderOverlay } from '../overlay';
import {
  nodeIndexOf, ensureNodeTypes, segmentStart, subpathStart, seamPartnerIndex,
} from './dragMath';

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

/**
 * The BIND-BAKE's nodeTypes companion (`view/rigOpsBind.ts` is the one caller): the
 * bake runs every path through `pathToCubics`, which expands a literal 'A' into k
 * cubics — a command-count change, so the one-char-per-command string must be spliced
 * in the same pass or every node op on the bound path desyncs afterward. This lives
 * HERE (not in rigOpsBind) so the chokepoint module stays the sole writer of
 * `nodeTypes` — the enforcement test caught the first draft writing it from the bake.
 * It is deliberately NOT `applyStructuralEdit`: the bake manages its own DOM sync and
 * override semantics (fresh binds have no overrides; re-binds skip the bake entirely),
 * so only the lockstep splice applies. The (k−1) synthesized split points get 'c'
 * (free corner: the splits are tangent-smooth by construction, but 'c' never imposes
 * mirror behavior on a later handle drag); the arc's ORIGINAL char stays on its
 * endpoint, so typed nodes survive the bake exactly. Mirrors `pathToCubics`'s
 * current-point walk — including Z resetting to the subpath start — so the counts
 * cannot drift from what the bake actually emits. Untyped (null/absent) stays null
 * (collinearity detection — never fabricate flags); a stale-length string first gets
 * the SAME lazy normalization every node op applies (`ensureNodeTypes` — Inkscape's
 * occasional extra closing char, e.g. the sample's left_leg 'cssssscc', trims rather
 * than nuking the whole typed string). Pinned by `interaction/arcBindNodeTypes.test.ts`.
 */
export function spliceNodeTypesForBake(path: RigPath, cmds: PathCmd[]): void {
  if ((path.nodeTypes ?? null) === null) { path.nodeTypes = null; return; }
  const nodeTypes = ensureNodeTypes(path);
  let out = '';
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c.cmd === 'Z') { cx = sx; cy = sy; continue; }
    const ch = nodeTypes[i++];
    if (c.cmd === 'A') {
      out += 'c'.repeat(arcToCubics(cx, cy, c).length - 1) + ch;
    } else {
      out += ch;
      if (c.cmd === 'M') { sx = c.x; sy = c.y; }
    }
    cx = c.x; cy = c.y;
  }
  path.nodeTypes = out;
}

/**
 * Ctrl+click a node: delete it (Alt+click-to-insert-after-a-node retired — CLAUDE.md
 * item 1, see `view/interactions/pipelines/node.ts`; exact-point insert on a SEGMENT
 * now lives in `insertNodeOnSegment` below, driven by `nodesBendMarquee.ts`). Refuses
 * an M (a path's start can't be spliced out this way) and a seam pair's own indexes
 * (CLAUDE.md item 3 — the coincident pair "splits ONLY via the explicit delete-segment/
 * open-path ops", never an implicit single-node delete).
 */
export function deleteNode(d: Extract<DragState, { kind: 'node' }>): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const cmds = parsePath(path.d);
  if (
    cmds.length <= 3 || cmds[d.cmdIndex].cmd === 'M' || seamPartnerIndex(cmds, d.cmdIndex) != null
  ) return;
  let nodeTypes = path.nodeTypes ? ensureNodeTypes(path) : null;
  const ni = nodeIndexOf(cmds, d.cmdIndex);
  cmds.splice(d.cmdIndex, 1);
  if (nodeTypes) nodeTypes = nodeTypes.slice(0, ni) + nodeTypes.slice(ni + 1);
  applyStructuralEdit(d.part, path, { cmds, nodeTypes });
  renderOverlay();
}

/** De Casteljau split of a single cubic at parameter `t` (0..1). */
function splitCubicAt(
  p0: { x: number; y: number }, c: Extract<PathCmd, { cmd: 'C' }>, t: number,
): { left: PathCmd; right: PathCmd } {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const ax = lerp(p0.x, c.x1), ay = lerp(p0.y, c.y1);
  const bx = lerp(c.x1, c.x2), by = lerp(c.y1, c.y2);
  const cx = lerp(c.x2, c.x), cy = lerp(c.y2, c.y);
  const dx = lerp(ax, bx), dy = lerp(ay, by);
  const ex = lerp(bx, cx), ey = lerp(by, cy);
  const mx = lerp(dx, ex), my = lerp(dy, ey);
  return {
    left: { cmd: 'C', x1: ax, y1: ay, x2: dx, y2: dy, x: mx, y: my },
    right: { cmd: 'C', x1: ex, y1: ey, x2: cx, y2: cy, x: c.x, y: c.y },
  };
}

/**
 * Alt+click ON A SEGMENT (CLAUDE.md item 1 — `nodesBendMarquee.ts` is the one caller,
 * reusing the exact `segmentHit` geometry the bend gesture itself hit-tests against):
 * insert a node at the PRECISE point clicked, identified segmentHit's way — `cmdIndex`
 * is the command owning the segment (its own L/C/Z), `t` the parameter along it — rather
 * than `insertNodeAfter`'s always-midpoint, node-relative split. A straight L (or the
 * implicit Z closing line) splits by linear interpolation; a C splits by de Casteljau.
 * The new node is marked smooth ('s'), matching `insertNodeAfter`'s existing convention
 * (a split point is tangent-continuous by construction).
 */
export function insertNodeOnSegment(
  part: RigPart, path: RigPath, cmdIndex: number, t: number,
): boolean {
  const cmds = parsePath(path.d);
  const c = cmds[cmdIndex];
  const p0 = segmentStart(cmds, cmdIndex);
  if (!c || !p0) return false;
  let nodeTypes = path.nodeTypes ? ensureNodeTypes(path) : null;
  const ni = nodeIndexOf(cmds, cmdIndex);
  if (c.cmd === 'L') {
    cmds.splice(cmdIndex, 0, { cmd: 'L', x: p0.x + (c.x - p0.x) * t, y: p0.y + (c.y - p0.y) * t });
  } else if (c.cmd === 'C') {
    const { left, right } = splitCubicAt(p0, c, t);
    cmds.splice(cmdIndex, 1, left, right);
  } else if (c.cmd === 'Z') {
    const s0 = subpathStart(cmds, cmdIndex);
    if (!s0) return false;
    cmds.splice(cmdIndex, 0, { cmd: 'L', x: p0.x + (s0.x - p0.x) * t, y: p0.y + (s0.y - p0.y) * t });
  } else {
    return false; // arcs aren't sampled by segmentHit, so this is never reached
  }
  if (nodeTypes) nodeTypes = nodeTypes.slice(0, ni) + 's' + nodeTypes.slice(ni);
  applyStructuralEdit(part, path, { cmds, nodeTypes });
  return true;
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
    // Highest index first so earlier indexes stay valid while splicing. A seam pair
    // (CLAUDE.md item 3) is skipped here too — same rule as the single-node delete
    // above: it splits ONLY via the explicit delete-segment/open-path ops.
    for (const idx of [...indexes].sort((a, b) => b - a)) {
      if (
        cmds.length <= 3 || !cmds[idx] || cmds[idx].cmd === 'M'
        || seamPartnerIndex(cmds, idx) != null
      ) continue;
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
