/**
 * Node-editing chrome: the per-node handle glyphs (Inkscape's corner/smooth/symmetric
 * shape language), their control-handle lines, selected-node contrast rings, and the
 * "editing base shape — bone deformation paused" hint shown while a skinned part's
 * deformation is suspended for node editing. Split out of overlay.ts's render loop
 * (CLAUDE.md "Small, focused files") — pure chrome-building, no top-level orchestration.
 */

import { ctx, SVG_NS, nodeKey, parseNodeKey } from './context';
import { state, RigPart } from '../core/model';
import { parsePath } from '../geometry/paths';
import { handleSize } from './coords';

export function renderNodeHandles(part: RigPart): void {
  const g = ctx.partGroups.get(part.id)!;
  // With a path "entered", node editing scopes to it; otherwise every path is editable.
  const paths = state.selectedPathId
    ? part.paths.filter((p) => p.id === state.selectedPathId)
    : part.paths;
  // Prune stale node selections (path gone, or the path shrank under them).
  for (const key of [...ctx.selectedNodes]) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    if (!paths.some((p) => p.id === pathId && cmdIndex < parsePath(p.d).length)) {
      ctx.selectedNodes.delete(key);
    }
  }
  if (ctx.selectedNode && !ctx.selectedNodes.has(nodeKey(ctx.selectedNode.pathId, ctx.selectedNode.cmdIndex))) {
    ctx.selectedNode = null;
  }
  for (const path of paths) {
    const cmds = parsePath(path.d);
    const types = path.nodeTypes ?? '';
    const holder = document.createElementNS(SVG_NS, 'g');
    // Same accumulated transform as the drawn path (root + part + path), so raw path
    // coordinates land exactly on the rendered artwork.
    const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
    const groupTransform = g.getAttribute('transform') ?? '';
    holder.setAttribute(
      'transform',
      [rootTransform, groupTransform, path.transform].filter(Boolean).join(' '),
    );
    const size = handleSize();
    // A control handle "coincides" with its node (retracted, effectively zero-length)
    // when it's within a small on-screen distance through the zoom — hide the dot AND
    // its handle-line rather than clutter the view with a handle sitting on top of the
    // node it belongs to. Expressed via handleSize() like every other radius here, so
    // it scales the same way through the zoom as the handles themselves.
    const zeroLenThreshold = size * 0.4;

    // Handle lines first (underneath): control points connect to their nodes —
    // x1 to the segment's start node, x2 to its end node.
    let prev: { x: number; y: number } | null = null;
    cmds.forEach((c) => {
      if (c.cmd === 'Z') return;
      if (c.cmd === 'C' && prev) {
        if (Math.hypot(c.x1 - prev.x, c.y1 - prev.y) >= zeroLenThreshold) {
          addHandleLine(holder, prev.x, prev.y, c.x1, c.y1);
        }
        if (Math.hypot(c.x2 - c.x, c.y2 - c.y) >= zeroLenThreshold) {
          addHandleLine(holder, c.x, c.y, c.x2, c.y2);
        }
      }
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    });

    let nodeIdx = -1;
    prev = null;
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      nodeIdx++;
      if (c.cmd === 'C') {
        if (prev && Math.hypot(c.x1 - prev.x, c.y1 - prev.y) >= zeroLenThreshold) {
          addHandle(holder, path.id, i, 'x1', c.x1, c.y1, size * 0.6, 'ctrl');
        }
        if (Math.hypot(c.x2 - c.x, c.y2 - c.y) >= zeroLenThreshold) {
          addHandle(holder, path.id, i, 'x2', c.x2, c.y2, size * 0.6, 'ctrl');
        }
      }
      const isSelected = ctx.selectedNodes.has(nodeKey(path.id, i));
      addHandle(
        holder, path.id, i, 'x',
        (c as { x: number }).x, (c as { y: number }).y,
        size * (isSelected ? 1.05 : 0.8), 'node', isSelected,
        types[nodeIdx], // persistent type tints the node
      );
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    });
    ctx.overlay!.appendChild(holder);
  }
}

function addHandleLine(holder: SVGGElement, x1: number, y1: number, x2: number, y2: number): void {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', 'handle-line');
  holder.appendChild(line);
}

/**
 * A node/control handle. Node endpoints take Inkscape's shape language: corner
 * ('c') = diamond, smooth ('s') = square, symmetric ('z') = circle; untyped nodes
 * are small circles. Control points are always small circles.
 */
function addHandle(
  holder: SVGGElement, pathId: string, cmdIndex: number,
  field: 'x' | 'x1' | 'x2', x: number, y: number, r: number, kind: 'node' | 'ctrl',
  selected = false, typeChar?: string,
): void {
  let c: SVGElement;
  if (kind === 'node' && typeChar === 'c') {
    c = document.createElementNS(SVG_NS, 'rect');
    c.setAttribute('x', String(x - r * 0.9));
    c.setAttribute('y', String(y - r * 0.9));
    c.setAttribute('width', String(r * 1.8));
    c.setAttribute('height', String(r * 1.8));
    c.setAttribute('transform', `rotate(45 ${x} ${y})`); // diamond
  } else if (kind === 'node' && typeChar === 's') {
    c = document.createElementNS(SVG_NS, 'rect');
    c.setAttribute('x', String(x - r * 0.85));
    c.setAttribute('y', String(y - r * 0.85));
    c.setAttribute('width', String(r * 1.7));
    c.setAttribute('height', String(r * 1.7));
  } else {
    c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', String(r));
  }
  const typeClass =
    typeChar === 's' ? ' nt-s' : typeChar === 'z' ? ' nt-z' : typeChar === 'c' ? ' nt-c' : '';
  c.setAttribute(
    'class',
    (kind === 'node' ? 'node-handle' : 'ctrl-handle') +
      (selected ? ' selected' : '') + typeClass,
  );
  c.dataset.role = 'node';
  c.dataset.pathId = pathId;
  c.dataset.cmdIndex = String(cmdIndex);
  c.dataset.field = field;
  holder.appendChild(c);

  // Selected endpoints get a contrasting ring IN ADDITION to the size bump above —
  // a plain fill/size change reads poorly once several nodes are multi-selected.
  // Always a circle (regardless of the underlying type glyph) so it reads the same
  // for every node shape; non-interactive, drawn on top.
  if (selected && kind === 'node') {
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', String(x));
    ring.setAttribute('cy', String(y));
    ring.setAttribute('r', String(r * 1.7));
    ring.setAttribute('class', 'node-handle-ring');
    holder.appendChild(ring);
  }
}

/**
 * The node-editing equivalent of the `.skin-hint` "posed by its bones" label (item
 * v2.13 follow-up): while this part's deformation is suspended for node editing, say so
 * — the art on screen is its base/bind shape, not its current pose.
 */
export function drawSkinSuspendHint(part: RigPart, size: number): void {
  const g = ctx.partGroups.get(part.id);
  if (!g || !ctx.overlay) return;
  const box = g.getBBox();
  const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
  const groupTransform = g.getAttribute('transform') ?? '';
  const hint = document.createElementNS(SVG_NS, 'text');
  hint.setAttribute('x', String(box.x));
  hint.setAttribute('y', String(box.y - size * 0.6));
  hint.setAttribute('class', 'skin-hint');
  hint.setAttribute('font-size', String(size * 1.5));
  hint.textContent = 'editing base shape — bone deformation paused';
  const wrap = document.createElementNS(SVG_NS, 'g');
  wrap.setAttribute('class', 'overlay-passive');
  wrap.setAttribute('transform', [rootTransform, groupTransform].filter(Boolean).join(' '));
  wrap.appendChild(hint);
  ctx.overlay.appendChild(wrap);
}
