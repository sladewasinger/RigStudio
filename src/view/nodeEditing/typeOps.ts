/**
 * Node selection introspection and the one-shot node-type operations driven by the
 * inspector in node-editing mode: smooth/symmetric/corner(retract) set both handles'
 * geometry AND the node's persistent type flag; toCurve/toLine convert a segment's
 * TYPE without touching node count. None of these change a path's drawing-command
 * count, so — unlike structural.ts's ops — they write `path.d`/`nodeTypes` directly
 * and never touch skin overrides (see the package doc's THREE-WAY LOCKSTEP INVARIANT
 * and CLAUDE.md's "What drops overrides": index-preserving edits keep them).
 */

import { RigPath, state, selectedPart, notify } from '../../core/model';
import { parsePath, serializePath, PathCmd } from '../../geometry/paths';
import { ctx, nodeKey, parseNodeKey } from '../context';
import { renderOverlay } from '../overlay';
import { nodeIndexOf, ensureNodeTypes, segmentStart } from './dragMath';

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

/**
 * The node-type char shared by EVERY selected node, or null when the selection is
 * empty, any node is untyped, or the selection is mixed (CLAUDE.md item 4 — the
 * inspector's smooth/symmetric/corner buttons highlight only when the whole selection
 * genuinely agrees, never on a guess from just the primary node).
 */
export function selectedNodesType(): string | null {
  const part = selectedPart();
  if (!part || ctx.selectedNodes.size === 0) return null;
  let shared: string | null | undefined;
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const path = part.paths.find((p) => p.id === pathId);
    const t = path?.nodeTypes ? path.nodeTypes[nodeIndexOf(parsePath(path.d), cmdIndex)] ?? null : null;
    if (shared === undefined) shared = t;
    else if (shared !== t) return null;
  }
  return shared ?? null;
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
  if (changed) {
    renderOverlay();
    // Matches structural.ts's sibling ops (deleteSelectedSegment/joinSelectedNodes),
    // which already notify(): without it the inspector doesn't rebuild, so the node-ops
    // section's own title and the item-4 type-button highlight stay stale showing the
    // node's PREVIOUS type until some unrelated selection click forces a refresh (found
    // live-testing item 4 — clicking "symmetric" left "smooth" highlighted).
    notify();
  }
  return changed;
}

type CubicCmd = Extract<PathCmd, { cmd: 'C' }>;

/** Convert the ARRIVING segment `cmds[i]` (currently 'L', ending at `node`) into a
 *  cubic so it has a real x2/y2 handle — the bend pipeline's "handles grow" 1/3-chord
 *  conversion, except the handle AT `node` takes an explicit `len` when the caller
 *  wants it to match something (symmetric mirroring a real partner) rather than its
 *  own natural 1/3 of the chord. */
function growArriving(
  cmds: PathCmd[], i: number, p0: { x: number; y: number }, node: { x: number; y: number }, len?: number,
): CubicCmd {
  const dx = node.x - p0.x, dy = node.y - p0.y;
  const chord = Math.hypot(dx, dy) || 1;
  const l = len ?? chord / 3;
  const grown: CubicCmd = {
    cmd: 'C',
    x1: p0.x + dx / 3, y1: p0.y + dy / 3,
    x2: node.x - (dx / chord) * l, y2: node.y - (dy / chord) * l,
    x: node.x, y: node.y,
  };
  cmds[i] = grown;
  return grown;
}

/** Same as `growArriving` for the LEAVING segment `cmds[i]` (currently 'L', from
 *  `node` to `end`) — grows its x1/y1 handle at `node`. */
function growLeaving(
  cmds: PathCmd[], i: number, node: { x: number; y: number }, end: { x: number; y: number }, len?: number,
): CubicCmd {
  const dx = end.x - node.x, dy = end.y - node.y;
  const chord = Math.hypot(dx, dy) || 1;
  const l = len ?? chord / 3;
  const grown: CubicCmd = {
    cmd: 'C',
    x1: node.x + (dx / chord) * l, y1: node.y + (dy / chord) * l,
    x2: end.x - (2 * dx) / 3, y2: end.y - (2 * dy) / 3,
    x: end.x, y: end.y,
  };
  cmds[i] = grown;
  return grown;
}

function applyNodeOpToCmds(cmds: PathCmd[], i: number, op: NodeOp): boolean {
  const cur = cmds[i];
  if (!cur || cur.cmd === 'Z') return false;
  const node = { x: (cur as { x: number }).x, y: (cur as { y: number }).y };
  const next = cmds[i + 1];

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
    const inC = cur.cmd === 'C' ? cur : null;
    const outC = next && next.cmd === 'C' ? next : null;
    if (!inC && !outC) return false;
    if (inC) { inC.x2 = node.x; inC.y2 = node.y; }
    if (outC) { outC.x1 = node.x; outC.y1 = node.y; }
    return true;
  }

  // smooth / symmetric — CLAUDE.md item 2: ALWAYS produce both handles, synthesizing
  // whichever side a straight-line neighbor left missing instead of silently no-opping
  // beside a straight edge (the reported bug). A synthesized side starts at its own
  // natural 1/3-chord length UNLESS the other side already had a real handle and the op
  // is symmetric, in which case it starts at that real handle's exact length — so the
  // shared alignment below (which averages the two lengths for symmetric, and leaves
  // each side's own length untouched for smooth) lands on exactly what each op promises:
  // symmetric mirrors a real handle exactly (equal length, opposite direction); smooth
  // mirrors direction only, keeping the grown side's own 1/3-chord length.
  const hadIn = cur.cmd === 'C';
  const hadOut = !!next && next.cmd === 'C';
  let inC: CubicCmd | null = hadIn ? (cur as CubicCmd) : null;
  let outC: CubicCmd | null = hadOut ? (next as CubicCmd) : null;
  if (!hadIn) {
    const p0 = segmentStart(cmds, i);
    if (cur.cmd !== 'L' || !p0) return false;
    const len = op === 'symmetric' && hadOut && outC
      ? Math.hypot(outC.x1 - node.x, outC.y1 - node.y) : undefined;
    inC = growArriving(cmds, i, p0, node, len);
  }
  if (!hadOut) {
    if (!next || next.cmd !== 'L') return false;
    const len = op === 'symmetric' && hadIn && inC
      ? Math.hypot(inC.x2 - node.x, inC.y2 - node.y) : undefined;
    outC = growLeaving(cmds, i + 1, node, next as { x: number; y: number }, len);
  }
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
