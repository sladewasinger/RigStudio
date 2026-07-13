/**
 * Node-editing mode's remaining ownership of the canvas: near the edited path's outline a
 * press BENDS that segment (lines auto-grow handles); everywhere else — blank space OR
 * artwork, faded parts are click-through anyway — it rubber-bands a node marquee. Canvas
 * clicks never switch parts here; Layers or Escape leave node mode. Two DragState kinds,
 * ordered as the old cascade tried them (bend hit-test first, marquee fallback).
 */

import { RigPath, state, selectedPart } from '../../../core/model';
import { parsePath, serializePath, PathCmd } from '../../../geometry/paths';
import { ctx, DragState, nodeKey, parseNodeKey } from '../../context';
import { pointerInPathSpace, handleSize } from '../../coords';
import {
  nodeIndexOf, ensureNodeTypes, segmentStart, pointOnSegment, segmentHit, subpathStart,
  applyMirrorConstraint, applyStructuralEdit,
} from '../../nodeEditing';
import { renderOverlay } from '../../overlay';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const NODE_BEND_MARQUEE_PIPELINE: GesturePipeline = {
  name: 'nodesBendMarquee',
  claim(_hit, ev) {
    if (!(state.mode === 'nodes' && state.editorMode === 'setup' && selectedPart())) return null;
    const part = selectedPart()!;
    const scoped = state.selectedPathId
      ? part.paths.filter((p) => p.id === state.selectedPathId)
      : part.paths;
    // Hit-test the EDITED paths' geometry directly (nearest segment within
    // tolerance wins) — the event target is irrelevant, so sibling paths drawn on
    // top (e.g. an inner shadow) can't swallow a bend on the path being edited.
    let bestBend: { path: RigPath; cmdIndex: number; t: number; d: number } | null = null;
    for (const path of scoped) {
      const local = pointerInPathSpace(ev, part, path);
      const bendHit = segmentHit(parsePath(path.d), local, handleSize() * 1.8);
      if (bendHit && (!bestBend || bendHit.d < bestBend.d)) {
        bestBend = { path, cmdIndex: bendHit.cmdIndex, t: bendHit.t, d: bendHit.d };
      }
    }
    if (bestBend) {
      const d: DragState = {
        kind: 'bendSegment', part, pathId: bestBend.path.id,
        cmdIndex: bestBend.cmdIndex, t: bestBend.t,
        startClient: { x: ev.clientX, y: ev.clientY }, active: false,
      };
      capturePointer(ev);
      return d;
    }
    const rect = document.createElement('div');
    rect.className = 'node-marquee';
    ctx.svg!.parentElement?.appendChild(rect);
    const d: DragState = {
      kind: 'nodeMarquee',
      startClient: { x: ev.clientX, y: ev.clientY },
      rect,
      additive: ev.shiftKey,
    };
    capturePointer(ev);
    return d;
  },
  move(ev, drag) {
    if (drag.kind === 'nodeMarquee') {
      const host = ctx.svg!.parentElement!.getBoundingClientRect();
      const x0 = Math.min(drag.startClient.x, ev.clientX);
      const y0 = Math.min(drag.startClient.y, ev.clientY);
      drag.rect.style.left = `${x0 - host.left}px`;
      drag.rect.style.top = `${y0 - host.top}px`;
      drag.rect.style.width = `${Math.abs(ev.clientX - drag.startClient.x)}px`;
      drag.rect.style.height = `${Math.abs(ev.clientY - drag.startClient.y)}px`;
      return;
    }
    if (drag.kind !== 'bendSegment') return;
    const d = drag;
    const path = d.part.paths.find((p) => p.id === d.pathId);
    if (!path) return;
    const cmds = parsePath(path.d);
    const p0 = segmentStart(cmds, d.cmdIndex);
    let c = cmds[d.cmdIndex];
    if (!p0 || !c || (c.cmd !== 'L' && c.cmd !== 'C' && c.cmd !== 'Z')) return;
    if (c.cmd === 'Z') {
      // The implicit closing line becomes a REAL segment: an explicit cubic back
      // to the subpath start, in front of the Z (which then closes a zero-length
      // gap). This is how a handle-less closing edge grows handles. Command count
      // changes (+1), so this goes through the structural chokepoint (drops any
      // skin overrides on this path, resyncs the DOM) exactly like every other
      // count-changing edit in nodeEditing/ — the rest of this handler's control-
      // point solve below is index-preserving and writes path.d directly, as usual.
      const s0 = subpathStart(cmds, d.cmdIndex);
      if (!s0) return;
      const closing: PathCmd = {
        cmd: 'C',
        x1: p0.x + (s0.x - p0.x) / 3, y1: p0.y + (s0.y - p0.y) / 3,
        x2: p0.x + (2 * (s0.x - p0.x)) / 3, y2: p0.y + (2 * (s0.y - p0.y)) / 3,
        x: s0.x, y: s0.y,
      };
      cmds.splice(d.cmdIndex, 0, closing);
      let nodeTypes: string | null = null;
      if (path.nodeTypes) {
        // The new node duplicates the subpath start; give it a corner flag at the
        // exact position so every later node keeps its type.
        const types = ensureNodeTypes(path); // pre-splice length — recompute below
        const ni = nodeIndexOf(cmds, d.cmdIndex);
        nodeTypes = types.slice(0, ni) + 'c' + types.slice(ni);
      }
      applyStructuralEdit(d.part, path, { cmds, nodeTypes });
      c = closing;
    }
    if (c.cmd === 'L') {
      // Auto-add handles: the straight segment becomes an equivalent cubic.
      c = {
        cmd: 'C',
        x1: p0.x + (c.x - p0.x) / 3, y1: p0.y + (c.y - p0.y) / 3,
        x2: p0.x + (2 * (c.x - p0.x)) / 3, y2: p0.y + (2 * (c.y - p0.y)) / 3,
        x: c.x, y: c.y,
      };
      cmds[d.cmdIndex] = c;
    }
    const local = pointerInPathSpace(ev, d.part, path);
    const cur = pointOnSegment(p0, c, d.t);
    // Move both control points (minimal-norm solve) so the curve point at t
    // follows the pointer exactly while the segment's endpoints stay fixed.
    const u = 1 - d.t;
    const b1 = 3 * u * u * d.t;
    const b2 = 3 * u * d.t * d.t;
    const denom = b1 * b1 + b2 * b2;
    const dx = local.x - cur.x;
    const dy = local.y - cur.y;
    c.x1 += (dx * b1) / denom;
    c.y1 += (dy * b1) / denom;
    c.x2 += (dx * b2) / denom;
    c.y2 += (dy * b2) / denom;
    // Re-apply the smooth/symmetric mirror constraint at BOTH endpoint nodes of the
    // bent segment — writing x1/x2 directly above bypassed the mirroring moveNode
    // gives ordinary handle drags, so an 's'/'z' node silently degraded to a corner
    // when its segment was bent instead of dragged (P2b bug fix).
    applyMirrorConstraint(cmds, d.cmdIndex, 'x1', path.nodeTypes ?? null);
    applyMirrorConstraint(cmds, d.cmdIndex, 'x2', path.nodeTypes ?? null);
    path.d = serializePath(cmds);
    ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
    renderOverlay();
  },
  release(_ev, drag) {
    if (drag.kind !== 'nodeMarquee') return;
    // Select every node handle whose center sits inside the rubber band.
    const r = drag.rect.getBoundingClientRect();
    drag.rect.remove();
    if (!drag.additive) ctx.selectedNodes.clear();
    const isClick = r.width < 3 && r.height < 3;
    if (!isClick && ctx.svg) {
      for (const h of ctx.svg.querySelectorAll<SVGCircleElement>('.node-handle')) {
        const hb = h.getBoundingClientRect();
        const cx = hb.left + hb.width / 2;
        const cy = hb.top + hb.height / 2;
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          ctx.selectedNodes.add(nodeKey(h.dataset.pathId!, Number(h.dataset.cmdIndex)));
        }
      }
    }
    const last = [...ctx.selectedNodes].pop();
    ctx.selectedNode = last ? parseNodeKey(last) : null;
  },
};
