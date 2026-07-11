/**
 * Bezier node editing (Setup mode): node/handle drags with smooth-node mirroring,
 * segment geometry helpers (start point, point-on-segment, nearest-segment hit,
 * subpath start), insert/delete structural edits, the one-shot node ops driven by the
 * inspector (smooth/symmetric/retract/toCurve/toLine), and the weld/bridge/break
 * segment operations.
 *
 * The bendSegment pointermove branch lives with the other interactions in view.ts; it
 * imports the segment geometry helpers (segmentStart, pointOnSegment, subpathStart,
 * ensureNodeTypes, nodeIndexOf) from here.
 */

import {
  RigPath, RigPart, state, notify, selectedPart, freshId, dropSkinOverridesForPath,
} from '../core/model';
import {
  parsePath, serializePath, insertNodeAfter, PathCmd,
  deleteSegment, closePath, joinPaths, isSingleSubpath, isClosedPath, nodeCount,
} from '../geometry/paths';
import { applyMat, invertMat } from '../geometry/transforms';
import { snapPoint } from '../geometry/snap';
import { checkpoint } from '../core/history';
import {
  ctx, DragState, linearOnly, nodeKey, parseNodeKey, snappingActive,
} from './context';
import { pointerInPathSpace, pathHolderMat } from './coords';
import { nodeSnapCandidates } from './snapping';
import { renderPose } from './render';
import { syncPartPathDom } from './partDom';
import { invalidateSkinCache } from './skinRender';
import { renderOverlay } from './overlay';

/**
 * Structural node edits (insert/delete/join/split) shift a path's command indexes, so a
 * skinned part's per-node weight overrides on that path no longer point at the intended
 * nodes — drop them (and invalidate the cached weights). No-op for unskinned parts.
 */
function dropOverridesForStructuralEdit(part: RigPart, pathId: string): void {
  if (!part.skin) return;
  dropSkinOverridesForPath(part, pathId);
  invalidateSkinCache(part.id);
}

/** Index of a command among the drawing commands (Z excluded) — nodeTypes position. */
export function nodeIndexOf(cmds: PathCmd[], cmdIndex: number): number {
  let n = 0;
  for (let i = 0; i < cmdIndex; i++) {
    if (cmds[i].cmd !== 'Z') n++;
  }
  return n;
}

/** The nodeTypes string padded/created to match the path's drawing-command count. */
export function ensureNodeTypes(path: RigPath): string {
  const count = parsePath(path.d).filter((c) => c.cmd !== 'Z').length;
  let types = path.nodeTypes ?? '';
  if (types.length > count) types = types.slice(0, count);
  while (types.length < count) types += 'c';
  path.nodeTypes = types;
  return types;
}

/** The start point of the segment ending at cmds[i] (previous node, Z-aware). */
export function segmentStart(cmds: PathCmd[], i: number): { x: number; y: number } | null {
  let prev: { x: number; y: number } | null = null;
  let subStart: { x: number; y: number } | null = null;
  for (let k = 0; k < i; k++) {
    const c = cmds[k];
    if (c.cmd === 'M') {
      prev = { x: c.x, y: c.y };
      subStart = prev;
    } else if (c.cmd === 'Z') {
      prev = subStart;
    } else {
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    }
  }
  return prev;
}

/** The point at parameter t on the segment ending at cmds[i] (L or C). */
export function pointOnSegment(
  p0: { x: number; y: number }, c: PathCmd, t: number,
): { x: number; y: number } {
  if (c.cmd === 'C') {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
      y: u * u * u * p0.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
    };
  }
  const q = c as { x: number; y: number };
  return { x: p0.x + (q.x - p0.x) * t, y: p0.y + (q.y - p0.y) * t };
}

/**
 * The segment (and parameter) nearest to a path-space point, within `tol`.
 * L and C segments are sampled directly; a Z is the subpath's implicit CLOSING line
 * (last node back to its M) — it hits too, and the bend converts it to a real curve.
 */
export function segmentHit(
  cmds: PathCmd[], p: { x: number; y: number }, tol: number,
): { cmdIndex: number; t: number; d: number } | null {
  let best = { d: Infinity, cmdIndex: -1, t: 0.5 };
  let prev: { x: number; y: number } | null = null;
  let subStart: { x: number; y: number } | null = null;
  cmds.forEach((c, i) => {
    if (c.cmd === 'M') {
      prev = { x: c.x, y: c.y };
      subStart = prev;
      return;
    }
    if (c.cmd === 'Z') {
      // The implicit closing line prev → subStart.
      if (prev && subStart) {
        const closing: PathCmd = { cmd: 'L', x: subStart.x, y: subStart.y };
        for (let s = 0; s <= 16; s++) {
          const t = s / 16;
          const q = pointOnSegment(prev, closing, t);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < best.d) best = { d, cmdIndex: i, t };
        }
      }
      prev = subStart;
      return;
    }
    if (prev && (c.cmd === 'L' || c.cmd === 'C')) {
      const samples = c.cmd === 'L' ? 16 : 28;
      for (let s = 0; s <= samples; s++) {
        const t = s / samples;
        const q = pointOnSegment(prev, c, t);
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < best.d) best = { d, cmdIndex: i, t };
      }
    }
    prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
  });
  if (best.d > tol || best.cmdIndex < 0) return null;
  // Clamp t away from the endpoints so the bend solve stays well-conditioned.
  return { cmdIndex: best.cmdIndex, t: Math.min(0.85, Math.max(0.15, best.t)), d: best.d };
}

/** The M starting the subpath containing cmds[i]. */
export function subpathStart(cmds: PathCmd[], i: number): { x: number; y: number } | null {
  let start: { x: number; y: number } | null = null;
  for (let k = 0; k <= i; k++) {
    const c = cmds[k];
    if (c.cmd === 'M') start = { x: c.x, y: c.y };
  }
  return start;
}

/**
 * The opposite control handle of the node a control point attaches to, when the two
 * handles are currently collinear-and-opposed (a smooth node) — dragging one then
 * mirrors the other's direction, preserving its length. Alt breaks the pairing.
 */
export function mirrorInfoFor(
  cmds: PathCmd[], cmdIndex: number, field: 'x1' | 'x2', nodeTypes: string | null,
): { cmdIndex: number; field: 'x1' | 'x2'; len: number; matchLen: boolean } | null {
  const cur = cmds[cmdIndex];
  if (!cur || cur.cmd !== 'C') return null;
  let node: { x: number; y: number };
  let nodeCmdIndex: number;
  let partner: { cmdIndex: number; field: 'x1' | 'x2'; x: number; y: number };
  let own: { x: number; y: number };
  if (field === 'x1') {
    // x1 leaves the PREVIOUS node; its sibling is the previous segment's x2.
    const prev = cmds[cmdIndex - 1];
    if (!prev || prev.cmd !== 'C') return null;
    node = { x: prev.x, y: prev.y };
    nodeCmdIndex = cmdIndex - 1;
    own = { x: cur.x1, y: cur.y1 };
    partner = { cmdIndex: cmdIndex - 1, field: 'x2', x: prev.x2, y: prev.y2 };
  } else {
    // x2 arrives at THIS node; its sibling is the next segment's x1.
    const next = cmds[cmdIndex + 1];
    if (!next || next.cmd !== 'C') return null;
    node = { x: cur.x, y: cur.y };
    nodeCmdIndex = cmdIndex;
    own = { x: cur.x2, y: cur.y2 };
    partner = { cmdIndex: cmdIndex + 1, field: 'x1', x: next.x1, y: next.y1 };
  }
  const b = { x: partner.x - node.x, y: partner.y - node.y };
  const lb = Math.hypot(b.x, b.y);

  // Persistent node type decides first: 's' mirrors direction, 'z' also matches
  // length, 'c' never mirrors. Untyped nodes fall back to collinearity detection.
  const flag = nodeTypes?.[nodeIndexOf(cmds, nodeCmdIndex)];
  if (flag === 'c') return null;
  if (flag === 's' || flag === 'z') {
    if (lb < 1e-6 && flag === 's') return null; // retracted partner: nothing to aim
    return {
      cmdIndex: partner.cmdIndex, field: partner.field, len: lb, matchLen: flag === 'z',
    };
  }

  const a = { x: own.x - node.x, y: own.y - node.y };
  const la = Math.hypot(a.x, a.y);
  if (la < 1e-6 || lb < 1e-6) return null; // a retracted handle is a corner
  const cos = (a.x * b.x + a.y * b.y) / (la * lb);
  if (cos > -0.985) return null; // not opposed within ~10° — treat as a corner
  return { cmdIndex: partner.cmdIndex, field: partner.field, len: lb, matchLen: false };
}

/**
 * Apply the smooth/symmetric mirror constraint to the OPPOSITE handle of the node
 * that `cmds[cmdIndex]`'s `field` control point attaches to: 's' mirrors direction
 * keeping the partner's own length, 'z' mirrors direction AND matches length, 'c'
 * (or an untyped/non-opposed pair) does nothing — exactly `mirrorInfoFor`'s policy.
 * Guards against a retracted moved handle (len < 1e-6: nothing to aim the partner at).
 *
 * Shared by moveNode (direct handle drags) and the bendSegment pointermove branch in
 * interactions.ts, which used to write bent control points directly and bypass this
 * entirely — an 's'/'z' node's opposite handle silently stopped opposing when its
 * segment was bent instead of dragged (P2b bug fix).
 */
export function applyMirrorConstraint(
  cmds: PathCmd[], cmdIndex: number, field: 'x1' | 'x2', nodeTypes: string | null,
): void {
  const mirror = mirrorInfoFor(cmds, cmdIndex, field, nodeTypes);
  if (!mirror) return;
  const c = cmds[cmdIndex] as PathCmd & Record<string, number>;
  if (!c || c.cmd !== 'C') return;
  const node = field === 'x1'
    ? (cmds[cmdIndex - 1] as { x: number; y: number })
    : { x: c.x, y: c.y };
  const own = field === 'x1' ? { x: c.x1, y: c.y1 } : { x: c.x2, y: c.y2 };
  const dx = own.x - node.x;
  const dy = own.y - node.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return; // retracted onto the node: nothing to aim the partner at
  const partner = cmds[mirror.cmdIndex] as PathCmd & Record<string, number>;
  if (!partner || partner.cmd !== 'C') return;
  const plen = mirror.matchLen ? len : mirror.len;
  const px = node.x - (dx / len) * plen;
  const py = node.y - (dy / len) * plen;
  if (mirror.field === 'x1') { partner.x1 = px; partner.y1 = py; }
  else { partner.x2 = px; partner.y2 = py; }
}

/** Move one endpoint (and its attached handles rigidly) within a parsed command list. */
function shiftEndpoint(cmds: PathCmd[], cmdIndex: number, dx: number, dy: number): void {
  const c = cmds[cmdIndex] as PathCmd & Record<string, number>;
  if (!c || c.cmd === 'Z') return;
  if (c.cmd === 'C') {
    c.x2 += dx; c.y2 += dy;
  }
  const next = cmds[cmdIndex + 1];
  if (next && next.cmd === 'C') {
    next.x1 += dx; next.y1 += dy;
  }
  c.x += dx; c.y += dy;
}

export function moveNode(d: Extract<DragState, { kind: 'node' }>, ev: PointerEvent): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const local = pointerInPathSpace(ev, d.part, path);
  const cmds = parsePath(path.d);
  const c = cmds[d.cmdIndex] as PathCmd & Record<string, number>;
  if (!c || c.cmd === 'Z') return;

  // Node drags (endpoints only) snap to other visible nodes of the same part's paths.
  ctx.snapMarker = null;
  if (d.field === 'x' && snappingActive()) {
    const scoped = state.selectedPathId
      ? d.part.paths.filter((p) => p.id === state.selectedPathId)
      : d.part.paths;
    const moving = new Set(ctx.selectedNodes);
    moving.add(nodeKey(d.pathId, d.cmdIndex)); // exclude the dragged node even if unselected
    const { candidates, threshold } = nodeSnapCandidates(d.part, path, scoped, moving);
    const match = snapPoint({ x: local.x, y: local.y }, candidates, threshold);
    if (match) {
      local.x = match.point.x;
      local.y = match.point.y;
      ctx.snapMarker = applyMat(pathHolderMat(d.part, path), local.x, local.y); // path → user
    }
  }

  if (d.field === 'x') {
    const dx = local.x - c.x;
    const dy = local.y - c.y;
    const key = nodeKey(d.pathId, d.cmdIndex);
    if (ctx.selectedNodes.has(key) && ctx.selectedNodes.size > 1) {
      // Multi-node drag: the same ROOT-space delta moves every selected endpoint,
      // converted into each path's own local frame.
      const draggedLin = linearOnly(pathHolderMat(d.part, path));
      const rootD = applyMat(draggedLin, dx, dy);
      const byPath = new Map<string, number[]>();
      for (const k of ctx.selectedNodes) {
        const { pathId, cmdIndex } = parseNodeKey(k);
        if (!byPath.has(pathId)) byPath.set(pathId, []);
        byPath.get(pathId)!.push(cmdIndex);
      }
      for (const [pathId, indexes] of byPath) {
        const p = d.part.paths.find((q) => q.id === pathId);
        if (!p) continue;
        const localD = pathId === d.pathId
          ? { x: dx, y: dy }
          : applyMat(linearOnly(invertMat(pathHolderMat(d.part, p))), rootD.x, rootD.y);
        const pCmds = pathId === d.pathId ? cmds : parsePath(p.d);
        for (const idx of indexes) shiftEndpoint(pCmds, idx, localD.x, localD.y);
        p.d = serializePath(pCmds);
        ctx.svg!.querySelector(`[data-path-id="${p.id}"]`)?.setAttribute('d', p.d);
      }
      renderOverlay();
      return;
    }
    shiftEndpoint(cmds, d.cmdIndex, dx, dy);
  } else if (d.field === 'x1' && c.cmd === 'C') {
    c.x1 = local.x; c.y1 = local.y;
  } else if (d.field === 'x2' && c.cmd === 'C') {
    c.x2 = local.x; c.y2 = local.y;
  }

  // Smooth-node behavior: the opposite handle stays opposed; symmetric ('z') nodes
  // also match the dragged handle's length. Alt breaks the pairing for this drag.
  if (!ev.altKey && (d.field === 'x1' || d.field === 'x2')) {
    applyMirrorConstraint(cmds, d.cmdIndex, d.field, path.nodeTypes ?? null);
  }

  path.d = serializePath(cmds);
  const el = ctx.svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}

// ---- One-shot node operations (driven by the inspector in node mode) ----

export type NodeOp = 'smooth' | 'symmetric' | 'retract' | 'toCurve' | 'toLine';

export function hasSelectedNode(): boolean {
  return ctx.selectedNodes.size > 0;
}

export function selectedNodeCount(): number {
  return ctx.selectedNodes.size;
}

/**
 * Select every node of the edited path (or every path of the current part when none is
 * "entered") — Ctrl+A in node-editing mode. Mirrors the scoping renderNodeHandles uses
 * so the selection always matches what's drawn. Returns the number of nodes selected.
 */
export function selectAllNodes(): number {
  const part = selectedPart();
  if (!part) return 0;
  const paths = state.selectedPathId
    ? part.paths.filter((p) => p.id === state.selectedPathId)
    : part.paths;
  ctx.selectedNodes.clear();
  for (const path of paths) {
    const cmds = parsePath(path.d);
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      ctx.selectedNodes.add(nodeKey(path.id, i));
    });
  }
  ctx.selectedNode = null;
  renderOverlay();
  return ctx.selectedNodes.size;
}

/** The primary node's persistent type char ('c'/'s'/'z'), or null when untyped. */
export function primaryNodeType(): string | null {
  const part = selectedPart();
  if (!part || !ctx.selectedNode) return null;
  const path = part.paths.find((p) => p.id === ctx.selectedNode!.pathId);
  if (!path?.nodeTypes) return null;
  return path.nodeTypes[nodeIndexOf(parsePath(path.d), ctx.selectedNode.cmdIndex)] ?? null;
}

/** Ops set the PERSISTENT node type too: smooth→'s', symmetric→'z', retract→'c'. */
const OP_FLAG: Partial<Record<NodeOp, string>> = { smooth: 's', symmetric: 'z', retract: 'c' };

/** Apply a node op to every selected node. Returns whether anything changed. */
export function applyNodeOp(op: NodeOp): boolean {
  const part = selectedPart();
  if (!part || ctx.selectedNodes.size === 0) return false;
  let changed = false;
  const touched = new Set<RigPath>();

  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const path = part.paths.find((p) => p.id === pathId);
    if (!path) continue;
    const cmds = parsePath(path.d);
    if (applyNodeOpToCmds(cmds, cmdIndex, op)) {
      path.d = serializePath(cmds);
      const flag = OP_FLAG[op];
      if (flag) {
        const types = ensureNodeTypes(path);
        const ni = nodeIndexOf(cmds, cmdIndex);
        path.nodeTypes = types.slice(0, ni) + flag + types.slice(ni + 1);
      }
      touched.add(path);
      changed = true;
    }
  }
  for (const path of touched) {
    ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
  }
  if (changed) renderOverlay();
  return changed;
}

function applyNodeOpToCmds(cmds: PathCmd[], i: number, op: NodeOp): boolean {
  const cur = cmds[i];
  if (!cur || cur.cmd === 'Z') return false;
  const node = { x: (cur as { x: number }).x, y: (cur as { y: number }).y };
  const inC = cur.cmd === 'C' ? cur : null; // handle arriving at this node (x2/y2)
  const next = cmds[i + 1];
  const outC = next && next.cmd === 'C' ? next : null; // handle leaving it (x1/y1)

  if (op === 'toCurve') {
    if (!next || next.cmd !== 'L') return false;
    cmds[i + 1] = {
      cmd: 'C',
      x1: node.x + (next.x - node.x) / 3, y1: node.y + (next.y - node.y) / 3,
      x2: node.x + (2 * (next.x - node.x)) / 3, y2: node.y + (2 * (next.y - node.y)) / 3,
      x: next.x, y: next.y,
    };
    return true;
  }
  if (op === 'toLine') {
    if (!next || next.cmd !== 'C') return false;
    cmds[i + 1] = { cmd: 'L', x: next.x, y: next.y };
    return true;
  }
  if (op === 'retract') {
    if (!inC && !outC) return false;
    if (inC) { inC.x2 = node.x; inC.y2 = node.y; }
    if (outC) { outC.x1 = node.x; outC.y1 = node.y; }
    return true;
  }
  // smooth / symmetric: both handles align on one axis through the node.
  if (!inC || !outC) return false;
  const a = { x: inC.x2 - node.x, y: inC.y2 - node.y };
  const b = { x: outC.x1 - node.x, y: outC.y1 - node.y };
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < 1e-6 && lb < 1e-6) return false;
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = a.x; dy = a.y; len = la; } // handles coincide: keep in-axis
  dx /= len; dy /= len;
  const lenIn = op === 'symmetric' ? (la + lb) / 2 : (la || lb);
  const lenOut = op === 'symmetric' ? (la + lb) / 2 : (lb || la);
  inC.x2 = node.x + dx * lenIn; inC.y2 = node.y + dy * lenIn;
  outC.x1 = node.x - dx * lenOut; outC.y1 = node.y - dy * lenOut;
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
    const types = path.nodeTypes ? ensureNodeTypes(path) : null;
    let list = types;
    // Highest index first so earlier indexes stay valid while splicing.
    for (const idx of [...indexes].sort((a, b) => b - a)) {
      if (cmds.length <= 3 || !cmds[idx] || cmds[idx].cmd === 'M') continue;
      const ni = nodeIndexOf(cmds, idx);
      cmds.splice(idx, 1);
      if (list) list = list.slice(0, ni) + list.slice(ni + 1);
      changed = true;
    }
    if (changed) {
      path.d = serializePath(cmds);
      path.nodeTypes = list;
      dropOverridesForStructuralEdit(part, path.id);
      ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
    }
  }
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
  if (changed) renderOverlay();
  return changed;
}

/** Nudge every selected node by a document-space delta (arrow keys in node mode). */
export function nudgeSelectedNodes(dx: number, dy: number): boolean {
  const part = selectedPart();
  if (!part || ctx.selectedNodes.size === 0) return false;
  const byPath = new Map<string, number[]>();
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    if (!byPath.has(pathId)) byPath.set(pathId, []);
    byPath.get(pathId)!.push(cmdIndex);
  }
  for (const [pathId, indexes] of byPath) {
    const path = part.paths.find((p) => p.id === pathId);
    if (!path) continue;
    const local = applyMat(linearOnly(invertMat(pathHolderMat(part, path))), dx, dy);
    const cmds = parsePath(path.d);
    for (const idx of indexes) shiftEndpoint(cmds, idx, local.x, local.y);
    path.d = serializePath(cmds);
    ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
  }
  renderOverlay();
  return true;
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
  dropOverridesForStructuralEdit(part, path.id);
  path.d = serializePath(pieces[0].cmds);
  path.nodeTypes = pieces[0].nodeTypes;
  const extra: RigPath[] = [];
  for (let k = 1; k < pieces.length; k++) {
    extra.push({
      ...path,
      id: freshId('path'),
      label: `${path.label}·${k + 1}`,
      d: serializePath(pieces[k].cmds),
      nodeTypes: pieces[k].nodeTypes,
    });
  }
  part.paths.splice(idx + 1, 0, ...extra);
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
  state.selectedPathId = null; // un-scope so both resulting pieces stay node-selectable
  syncPartPathDom(part);
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
    dropOverridesForStructuralEdit(part, path.id);
    path.d = serializePath(piece.cmds);
    path.nodeTypes = piece.nodeTypes;
    ctx.selectedNodes.clear();
    ctx.selectedNode = null;
    syncPartPathDom(part);
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
  dropOverridesForStructuralEdit(part, first.path.id);
  dropOverridesForStructuralEdit(part, removedId);
  first.path.d = serializePath(piece.cmds);
  first.path.nodeTypes = piece.nodeTypes;
  part.paths = part.paths.filter((p) => p.id !== removedId);
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
  state.selectedPathId = null;
  syncPartPathDom(part);
  renderPose();
  notify();
  return true;
}

export function editNodeStructure(d: Extract<DragState, { kind: 'node' }>, op: 'insert' | 'delete'): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const cmds = parsePath(path.d);
  const types = path.nodeTypes ? ensureNodeTypes(path) : null;
  const ni = nodeIndexOf(cmds, d.cmdIndex);
  const countBefore = cmds.filter((c) => c.cmd !== 'Z').length;
  if (op === 'insert') {
    if (!insertNodeAfter(cmds, d.cmdIndex)) return;
    if (types) {
      // New nodes appear right after this one; splitting a segment makes them smooth.
      const added = cmds.filter((c) => c.cmd !== 'Z').length - countBefore;
      path.nodeTypes = types.slice(0, ni + 1) + 's'.repeat(added) + types.slice(ni + 1);
    }
  } else {
    if (cmds.length <= 3 || cmds[d.cmdIndex].cmd === 'M') return;
    cmds.splice(d.cmdIndex, 1);
    if (types) path.nodeTypes = types.slice(0, ni) + types.slice(ni + 1);
  }
  // Command indexes shifted: a stale node selection would point at the wrong nodes.
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
  dropOverridesForStructuralEdit(d.part, path.id);
  path.d = serializePath(cmds);
  const el = ctx.svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}
