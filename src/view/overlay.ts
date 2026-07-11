/**
 * Overlay chrome: selection boxes, Inkscape-style scale/rotate/skew handles, the pivot
 * crosshair, live joint ghosts + bone lines, bone/group glyphs, the transform-tool and
 * drag gizmos, node-editing handles, and the snap marker.
 *
 * renderOverlay() rebuilds #overlay from scratch each call (innerHTML=''), and carries
 * two deliberate render-time side effects: it resets the Setup handle cycle to 'scale'
 * when the primary selection changes, and renderNodeHandles prunes stale node
 * selections. Overlay strokes use vector-effect: non-scaling-stroke so widths stay
 * screen-constant; radii are in doc units via handleSize().
 */

import { ctx, SVG_NS, round1, nodeKey, parseNodeKey } from './context';
import { state, RigPart, selectedPart, selectedParts, ancestorChain } from '../core/model';
import { parsePath } from '../geometry/paths';
import { handleSize } from './coords';
import { poseTime, effectivePivot, effectiveTip, partRootBoxes } from './pose';

// ---- Overlay: selection box, handles, pivots, drag gizmos, node handles ----

export function renderOverlay(): void {
  if (!ctx.overlay || !ctx.svg || !ctx.rootGroup) return;
  ctx.overlay.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  const setup = state.editorMode === 'setup';

  // Reset the handle cycle when the primary selection changes.
  if (state.selectedPartId !== ctx.handlePartId) {
    ctx.handlePartId = state.selectedPartId;
    ctx.handleMode = 'scale';
  }

  if (state.mode === 'nodes' && setup) {
    const part = selectedPart();
    if (part) renderNodeHandles(part);
    drawSnapMarker();
    return;
  }

  const size = handleSize();
  const t = poseTime();
  const rootTransform = ctx.rootGroup.getAttribute('transform') ?? '';

  // Everything positioned in root coordinates rides in one passive holder.
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'overlay-passive');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  ctx.overlay.appendChild(holder);

  // Ghost markers: every art part's live joint, so the skeleton is visible at a
  // glance. Bones and groups get interactive glyphs below instead.
  for (const part of doc.parts) {
    if (part.id === state.selectedPartId || part.paths.length === 0) continue;
    const p = effectivePivot(part, t);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(p.x));
    dot.setAttribute('cy', String(p.y));
    dot.setAttribute('r', String(size * 0.55));
    dot.setAttribute('class', 'pivot-ghost');
    holder.appendChild(dot);
  }

  // Bone lines: connect each parented part's joint to its parent's joint.
  for (const part of doc.parts) {
    if (!part.parentId) continue;
    const parent = doc.parts.find((p) => p.id === part.parentId);
    if (!parent) continue;
    const a = effectivePivot(parent, t);
    const b = effectivePivot(part, t);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('class', 'bone-line');
    line.setAttribute('stroke-dasharray', `${size * 0.5} ${size * 0.5}`);
    holder.appendChild(line);
  }

  // Highlight the "entered" path, if any (Setup path selection).
  if (setup && state.selectedPathId) {
    const part = selectedPart();
    const g = part ? ctx.partGroups.get(part.id) : null;
    const path = part?.paths.find((p) => p.id === state.selectedPathId);
    if (part && g && path) {
      const hl = document.createElementNS(SVG_NS, 'path');
      hl.setAttribute('d', path.d);
      hl.setAttribute('class', 'path-highlight');
      hl.setAttribute('stroke-dasharray', `${size * 0.8} ${size * 0.6}`);
      const wrap = document.createElementNS(SVG_NS, 'g');
      wrap.setAttribute('class', 'overlay-passive');
      wrap.setAttribute(
        'transform',
        [rootTransform, g.getAttribute('transform') ?? '', path.transform]
          .filter(Boolean)
          .join(' '),
      );
      wrap.appendChild(hl);
      ctx.overlay.appendChild(wrap);
    }
  }

  // Bone/group glyphs: partless parts have no artwork to click, so they get an
  // interactive diamond (bone) or square (group) at their live joint. Carrying
  // data-part-id makes the normal part hit-testing, drags and auto-key work on them.
  for (const part of doc.parts) {
    if (part.paths.length > 0) continue;
    const p = effectivePivot(part, t);
    const s = size * 1.6;
    const glyph = document.createElementNS(SVG_NS, 'g');
    glyph.dataset.partId = part.id;
    const sel = state.selectedPartIds.includes(part.id) ? ' selected' : '';
    glyph.setAttribute('class', `null-glyph ${part.kind}${sel}`);
    if (rootTransform) glyph.setAttribute('transform', rootTransform);
    const tip = effectiveTip(part, t);
    if (part.kind === 'group') {
      glyph.innerHTML =
        `<rect x="${p.x - s * 0.8}" y="${p.y - s * 0.8}" width="${s * 1.6}" height="${s * 1.6}" />`;
    } else if (tip) {
      // Classic bone: a kite from the joint to the tip, widest near the joint.
      glyph.innerHTML = boneKitePath(p, tip, size);
    } else {
      glyph.innerHTML =
        `<path d="M ${p.x},${p.y - s} L ${p.x + s * 0.7},${p.y} L ${p.x},${p.y + s} ` +
        `L ${p.x - s * 0.7},${p.y} Z" />`;
    }
    ctx.overlay.appendChild(glyph);

    // The selected bone's tip is editable in Setup (re-aim / re-length).
    if (setup && tip && part.id === state.selectedPartId) {
      const th = document.createElementNS(SVG_NS, 'circle');
      th.setAttribute('cx', String(tip.x));
      th.setAttribute('cy', String(tip.y));
      th.setAttribute('r', String(size * 0.9));
      th.setAttribute('class', 'bone-tip-handle');
      th.dataset.role = 'bone-tip';
      const wrap = document.createElementNS(SVG_NS, 'g');
      if (rootTransform) wrap.setAttribute('transform', rootTransform);
      wrap.appendChild(th);
      ctx.overlay.appendChild(wrap);
    }
  }

  // Selected GROUPS get a dashed box around everything they contain (root-space
  // AABB of the descendants' rendered boxes — groups have no artwork of their own).
  for (const part of selectedParts()) {
    if (part.kind !== 'group') continue;
    const descendantIds = doc.parts
      .filter((p) => p.paths.length > 0 && ancestorChain(p).some((a) => a.id === part.id))
      .map((p) => p.id);
    const boxes = [...partRootBoxes(descendantIds).values()];
    if (boxes.length === 0) continue;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = size * 0.8;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x0 - pad));
    rect.setAttribute('y', String(y0 - pad));
    rect.setAttribute('width', String(x1 - x0 + pad * 2));
    rect.setAttribute('height', String(y1 - y0 + pad * 2));
    rect.setAttribute(
      'class',
      part.id === state.selectedPartId ? 'select-box' : 'select-box secondary',
    );
    rect.setAttribute('stroke-dasharray', `${size * 0.9} ${size * 0.7}`);
    holder.appendChild(rect); // root-coordinate passive holder
  }

  // Dashed transform boxes around every selected part, rotating live with the pose.
  for (const part of selectedParts()) {
    const g = ctx.partGroups.get(part.id);
    if (!g || part.paths.length === 0) continue;
    const primary = part.id === state.selectedPartId;
    const partTransform = g.getAttribute('transform') ?? '';
    const boxTransform = [rootTransform, partTransform].filter(Boolean).join(' ');
    const box = g.getBBox();
    const pad = size * 0.6;
    const x0 = box.x - pad, y0 = box.y - pad;
    const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;

    const boxHolder = document.createElementNS(SVG_NS, 'g');
    boxHolder.setAttribute('class', 'overlay-passive');
    boxHolder.setAttribute('transform', boxTransform);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x0));
    rect.setAttribute('y', String(y0));
    rect.setAttribute('width', String(x1 - x0));
    rect.setAttribute('height', String(y1 - y0));
    rect.setAttribute('class', primary ? 'select-box' : 'select-box secondary');
    rect.setAttribute('stroke-dasharray', `${size * 0.9} ${size * 0.7}`);
    boxHolder.appendChild(rect);
    ctx.overlay.appendChild(boxHolder);

    if (!primary) continue;

    if (setup && !part.skin) {
      // Interactive Inkscape-style handles for the primary part.
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (ctx.handleMode === 'scale') {
        const spots: [string, number, number][] = [
          ['nw', x0, y0], ['ne', x1, y0], ['se', x1, y1], ['sw', x0, y1],
          ['n', cx, y0], ['e', x1, cy], ['s', cx, y1], ['w', x0, cy],
        ];
        for (const [name, hx, hy] of spots) {
          const s = size * 1.1;
          const h = document.createElementNS(SVG_NS, 'rect');
          h.setAttribute('x', String(hx - s / 2));
          h.setAttribute('y', String(hy - s / 2));
          h.setAttribute('width', String(s));
          h.setAttribute('height', String(s));
          h.setAttribute('class', `scale-handle handle-${name}`);
          h.dataset.handle = name;
          handles.appendChild(h);
        }
      } else {
        // Inkscape's second handle set: corners rotate, sides SKEW.
        for (const [name, hx, hy] of [
          ['nw', x0, y0], ['ne', x1, y0], ['se', x1, y1], ['sw', x0, y1],
        ] as [string, number, number][]) {
          const h = document.createElementNS(SVG_NS, 'circle');
          h.setAttribute('cx', String(hx));
          h.setAttribute('cy', String(hy));
          h.setAttribute('r', String(size * 0.9));
          h.setAttribute('class', `rotate-handle handle-${name}`);
          h.dataset.role = 'rotate-handle';
          handles.appendChild(h);
        }
        for (const [name, hx, hy] of [
          ['n', cx, y0], ['e', x1, cy], ['s', cx, y1], ['w', x0, cy],
        ] as [string, number, number][]) {
          const s = size * 1.0;
          const h = document.createElementNS(SVG_NS, 'rect');
          h.setAttribute('x', String(hx - s / 2));
          h.setAttribute('y', String(hy - s / 2));
          h.setAttribute('width', String(s));
          h.setAttribute('height', String(s));
          h.setAttribute('class', `skew-handle handle-${name}`);
          h.dataset.skewSide = name;
          handles.appendChild(h);
        }
      }
      ctx.overlay.appendChild(handles);
    } else {
      // Animate mode: passive corner markers only (drag the body to rotate).
      const boxCorners = document.createElementNS(SVG_NS, 'g');
      boxCorners.setAttribute('class', 'overlay-passive');
      boxCorners.setAttribute('transform', boxTransform);
      for (const [hx, hy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        const corner = document.createElementNS(SVG_NS, 'rect');
        const s = size * 0.9;
        corner.setAttribute('x', String(hx - s / 2));
        corner.setAttribute('y', String(hy - s / 2));
        corner.setAttribute('width', String(s));
        corner.setAttribute('height', String(s));
        corner.setAttribute('class', 'select-corner');
        boxCorners.appendChild(corner);
      }
      ctx.overlay.appendChild(boxCorners);
    }
  }

  renderDragGizmo(holder, size);
  renderToolGizmo(size, t, rootTransform);

  // The selected pivot: crosshair + ring, with a generous invisible grab circle.
  // Drawn last (and in its own interactive group) so it stays on top; draggable only in
  // Setup mode — moving a joint is a rig edit, not an animation edit.
  const part = selectedPart();
  if (part) {
    const ep = effectivePivot(part, t);
    const px = ep.x, py = ep.y;
    const cross = document.createElementNS(SVG_NS, 'g');
    cross.setAttribute('class', setup ? 'pivot-handle' : 'pivot-handle locked');
    if (setup) cross.dataset.role = 'pivot';
    if (rootTransform) cross.setAttribute('transform', rootTransform);
    cross.innerHTML =
      `<circle class="pivot-grab" cx="${px}" cy="${py}" r="${size * 1.6}" />` +
      `<circle class="pivot-ring" cx="${px}" cy="${py}" r="${size * 1.1}" />` +
      `<circle class="pivot-dot" cx="${px}" cy="${py}" r="${size * 0.3}" />` +
      `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
      `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
    ctx.overlay.appendChild(cross);
  }
  drawSnapMarker();
}

/** The classic bone silhouette between two points (joint fat end, pointed tip). */
function boneKitePath(p: { x: number; y: number }, q: { x: number; y: number }, size: number): string {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const ux = dx / len, uy = dy / len;
  const w = Math.min(len * 0.18, size * 1.6);
  const bx = p.x + ux * Math.min(len * 0.22, size * 2);
  const by = p.y + uy * Math.min(len * 0.22, size * 2);
  return (
    `<path d="M ${p.x},${p.y} L ${bx - uy * w},${by + ux * w} L ${q.x},${q.y} ` +
    `L ${bx + uy * w},${by - ux * w} Z" />` +
    `<circle cx="${p.x}" cy="${p.y}" r="${w * 0.5}" />`
  );
}

/** Rive/Blender-style axis gizmo for the translate/rotate tools, at the live pivot. */
function renderToolGizmo(size: number, t: number | null, rootTransform: string): void {
  if (!ctx.overlay || state.mode !== 'rig') return;
  if (state.tool !== 'translate' && state.tool !== 'rotate') return;
  const part = selectedPart();
  if (!part || part.skin) return;
  const p = effectivePivot(part, t);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'tool-gizmo');
  if (rootTransform) g.setAttribute('transform', rootTransform);

  if (state.tool === 'translate') {
    const len = size * 8;
    const head = size * 1.4;
    const box = size * 1.5;
    g.innerHTML =
      // X axis (red): line, arrow head, invisible fat hit line
      `<line class="gizmo-axis-x" x1="${p.x}" y1="${p.y}" x2="${p.x + len}" y2="${p.y}" />` +
      `<path class="gizmo-axis-x head" d="M ${p.x + len + head},${p.y} L ${p.x + len},${p.y - head * 0.6} L ${p.x + len},${p.y + head * 0.6} Z" />` +
      `<line class="gizmo-hit" data-gizmo-axis="x" x1="${p.x + box}" y1="${p.y}" x2="${p.x + len + head}" y2="${p.y}" />` +
      // Y axis (green)
      `<line class="gizmo-axis-y" x1="${p.x}" y1="${p.y}" x2="${p.x}" y2="${p.y + len}" />` +
      `<path class="gizmo-axis-y head" d="M ${p.x},${p.y + len + head} L ${p.x - head * 0.6},${p.y + len} L ${p.x + head * 0.6},${p.y + len} Z" />` +
      `<line class="gizmo-hit" data-gizmo-axis="y" x1="${p.x}" y1="${p.y + box}" x2="${p.x}" y2="${p.y + len + head}" />` +
      // Free-move square in the middle
      `<rect class="gizmo-free" data-gizmo-axis="xy" x="${p.x - box}" y="${p.y - box}" width="${box * 2}" height="${box * 2}" />`;
  } else {
    const r = size * 7;
    g.innerHTML =
      `<circle class="gizmo-ring-visual" cx="${p.x}" cy="${p.y}" r="${r}" />` +
      `<circle class="gizmo-ring-hit" data-role="gizmo-ring" cx="${p.x}" cy="${p.y}" r="${r}" />`;
  }
  ctx.overlay.appendChild(g);
}

/** Rotation arc + angle readout, translation deltas, or scale % while a drag is live. */
function renderDragGizmo(holder: SVGGElement, size: number): void {
  if (!ctx.drag || ctx.drag.kind === 'pan' || ctx.drag.kind === 'placeBone' || ctx.drag.kind === 'nodeMarquee') {
    // Bone placement previews the segment being drawn.
    if (ctx.drag?.kind === 'placeBone' && ctx.drag.current) {
      const ghost = document.createElementNS(SVG_NS, 'g');
      ghost.setAttribute('class', 'null-glyph bone placing');
      ghost.innerHTML = boneKitePath(ctx.drag.originRoot, ctx.drag.current, size);
      holder.appendChild(ghost);
    }
    return;
  }
  if (!ctx.drag.active) return;

  if (ctx.drag.kind === 'rotate' && ctx.drag.current) {
    const p = { x: ctx.drag.pivotX, y: ctx.drag.pivotY };
    const r = size * 5;
    const a0 = ctx.drag.startAngle;
    const a1 = Math.atan2(ctx.drag.current.y - p.y, ctx.drag.current.x - p.x);
    let delta = a1 - a0;
    // Normalize the drawn arc into (-2π, 2π) so multi-turn wind-ups stay readable.
    while (delta > Math.PI * 2) delta -= Math.PI * 2;
    while (delta < -Math.PI * 2) delta += Math.PI * 2;

    const sx = p.x + r * Math.cos(a0), sy = p.y + r * Math.sin(a0);
    const ex = p.x + r * Math.cos(a0 + delta), ey = p.y + r * Math.sin(a0 + delta);
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const sweep = delta > 0 ? 1 : 0;

    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute(
      'd',
      `M ${p.x},${p.y} L ${sx},${sy} A ${r} ${r} 0 ${largeArc} ${sweep} ${ex},${ey} Z`,
    );
    arc.setAttribute('class', 'gizmo-arc');
    holder.appendChild(arc);

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(p.x));
    line.setAttribute('y1', String(p.y));
    line.setAttribute('x2', String(ctx.drag.current.x));
    line.setAttribute('y2', String(ctx.drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);

    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `${ctx.drag.currentDelta.toFixed(1)}°${ctx.drag.snapped ? ' (snap)' : ''}`,
      size,
    );
  } else if (ctx.drag.kind === 'translate' && ctx.drag.current) {
    const dx = ctx.drag.current.x - ctx.drag.startX;
    const dy = ctx.drag.current.y - ctx.drag.startY;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(ctx.drag.startX));
    line.setAttribute('y1', String(ctx.drag.startY));
    line.setAttribute('x2', String(ctx.drag.current.x));
    line.setAttribute('y2', String(ctx.drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);
    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `Δ ${round1(dx)}, ${round1(dy)}`,
      size,
    );
  } else if (ctx.drag.kind === 'scale' && ctx.drag.current) {
    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `${Math.round(ctx.drag.part.rest.sx * 100)}% × ${Math.round(ctx.drag.part.rest.sy * 100)}%`,
      size,
    );
  }
}

function addGizmoText(holder: SVGGElement, x: number, y: number, text: string, size: number): void {
  const bg = document.createElementNS(SVG_NS, 'text');
  bg.setAttribute('x', String(x));
  bg.setAttribute('y', String(y));
  bg.setAttribute('class', 'gizmo-text-halo');
  bg.setAttribute('font-size', String(size * 2));
  bg.textContent = text;
  holder.appendChild(bg);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('class', 'gizmo-text');
  t.setAttribute('font-size', String(size * 2));
  t.textContent = text;
  holder.appendChild(t);
}

function renderNodeHandles(part: RigPart): void {
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

    // Handle lines first (underneath): control points connect to their nodes —
    // x1 to the segment's start node, x2 to its end node.
    let prev: { x: number; y: number } | null = null;
    cmds.forEach((c) => {
      if (c.cmd === 'Z') return;
      if (c.cmd === 'C' && prev) {
        addHandleLine(holder, prev.x, prev.y, c.x1, c.y1);
        addHandleLine(holder, c.x, c.y, c.x2, c.y2);
      }
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    });

    let nodeIdx = -1;
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      nodeIdx++;
      if (c.cmd === 'C') {
        addHandle(holder, path.id, i, 'x1', c.x1, c.y1, size * 0.6, 'ctrl');
        addHandle(holder, path.id, i, 'x2', c.x2, c.y2, size * 0.6, 'ctrl');
      }
      const isSelected = ctx.selectedNodes.has(nodeKey(path.id, i));
      addHandle(
        holder, path.id, i, 'x',
        (c as { x: number }).x, (c as { y: number }).y,
        size * (isSelected ? 1.05 : 0.8), 'node', isSelected,
        types[nodeIdx], // persistent type tints the node
      );
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
}

/** Draw the snap-target marker (a small non-scaling ring + crosshair) if one is live. */
function drawSnapMarker(): void {
  if (!ctx.overlay || !ctx.snapMarker) return;
  const size = handleSize();
  const r = size * 1.3;
  const { x, y } = ctx.snapMarker;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'snap-marker');
  g.style.pointerEvents = 'none';
  g.innerHTML =
    `<circle class="gizmo-line" fill="none" cx="${x}" cy="${y}" r="${r}" />` +
    `<line class="gizmo-line" x1="${x - r}" y1="${y}" x2="${x + r}" y2="${y}" />` +
    `<line class="gizmo-line" x1="${x}" y1="${y - r}" x2="${x}" y2="${y + r}" />`;
  ctx.overlay.appendChild(g);
}
