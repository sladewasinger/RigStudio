/**
 * Node selection introspection and the one-shot node-type operations driven by the
 * inspector in node-editing mode: smooth/symmetric/corner(retract) set both handles'
 * geometry AND the node's persistent type flag; toCurve/toLine convert a segment's
 * TYPE without touching node count. None of these change a path's drawing-command
 * count, so — unlike structural.ts's ops — they write `path.d`/`nodeTypes` directly
 * and never touch skin overrides (see the package doc's THREE-WAY LOCKSTEP INVARIANT
 * and CLAUDE.md's "What drops overrides": index-preserving edits keep them).
 */

import { RigPath, state, selectedPart } from '../../core/model';
import { parsePath, serializePath, PathCmd } from '../../geometry/paths';
import { ctx, nodeKey, parseNodeKey } from '../context';
import { renderOverlay } from '../overlay';
import { nodeIndexOf, ensureNodeTypes } from './dragMath';

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
