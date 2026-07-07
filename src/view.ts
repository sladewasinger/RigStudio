/**
 * The editing canvas: renders the rig as live SVG and handles direct manipulation.
 *
 * Rig mode:  click a part to select it; drag rotates it around its pivot (auto-keyed at
 *            the current time, Ctrl snaps to 15°); Shift+drag translates; the crosshair
 *            handle moves the pivot (a rig-setup edit, never keyed).
 * Node mode: endpoints (and cubic control handles) of the selected part's paths become
 *            draggable; Alt+click an endpoint inserts a node after it; Ctrl+click
 *            deletes it.
 *
 * Overlay visuals: a dashed transform box around the selection, faint ghost markers on
 * every part's pivot, a prominent crosshair on the selected pivot, and live gizmos
 * while dragging (rotation arc + angle readout, translation delta readout).
 */

import {
  RigPart, state, notify, sampleChannel, setKeyframe, selectedPart,
} from './model';
import { parsePath, serializePath, insertNodeAfter, PathCmd } from './paths';
import { checkpoint } from './history';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROTATE_SNAP_DEGREES = 15;

let svg: SVGSVGElement | null = null;
let rootGroup: SVGGElement | null = null;
let overlay: SVGGElement | null = null;
const partGroups = new Map<string, SVGGElement>();

export function buildCanvas(container: HTMLElement): void {
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  svg = document.createElementNS(SVG_NS, 'svg');
  const { x, y, w, h } = doc.viewBox;
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  svg.id = 'rig-svg';

  rootGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(rootGroup);
  overlay = document.createElementNS(SVG_NS, 'g');
  overlay.id = 'overlay';
  svg.appendChild(overlay);

  partGroups.clear();
  for (const part of doc.parts) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.partId = part.id;
    for (const p of part.paths) {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', p.d);
      el.setAttribute('fill', p.fill ?? 'none');
      el.setAttribute('fill-opacity', String(p.fillOpacity));
      if (p.stroke) {
        el.setAttribute('stroke', p.stroke);
        el.setAttribute('stroke-width', String(p.strokeWidth));
        el.setAttribute('stroke-opacity', String(p.strokeOpacity));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
      }
      if (p.transform) el.setAttribute('transform', p.transform);
      el.dataset.pathId = p.id;
      g.appendChild(el);
    }
    rootGroup.appendChild(g);
    partGroups.set(part.id, g);
  }
  container.appendChild(svg);

  // Apply the rest pose first so each group carries its baked transform, THEN measure:
  // bbox centers must be mapped through the part transform into root coordinates.
  renderPose();
  for (const part of doc.parts) {
    if (part.pivot.x === 0 && part.pivot.y === 0) {
      const g = partGroups.get(part.id)!;
      const box = g.getBBox();
      const local = svgPoint(box.x + box.width / 2, box.y + box.height / 2);
      const m = g.getCTM();
      const rootM = rootGroup.getCTM();
      if (m && rootM) {
        const inRoot = local.matrixTransform(m).matrixTransform(rootM.inverse());
        part.pivot = { x: inRoot.x, y: inRoot.y };
      }
    }
  }

  wireInteractions();
  renderPose();
}

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !rootGroup) return;
  const t = state.currentTime;

  const rtx = sampleChannel('root', 'tx', t);
  const rty = sampleChannel('root', 'ty', t);
  const rsx = sampleChannel('root', 'sx', t);
  const rsy = sampleChannel('root', 'sy', t);
  const rp = doc.rootPivot;
  rootGroup.setAttribute(
    'transform',
    `translate(${rtx},${rty}) translate(${rp.x},${rp.y}) scale(${rsx},${rsy}) translate(${-rp.x},${-rp.y})`,
  );

  for (const part of doc.parts) {
    const g = partGroups.get(part.id);
    if (!g) continue;
    const rot = sampleChannel(part.id, 'rotate', t);
    const tx = sampleChannel(part.id, 'tx', t);
    const ty = sampleChannel(part.id, 'ty', t);
    const anim = `translate(${tx},${ty}) rotate(${rot},${part.pivot.x},${part.pivot.y})`;
    g.setAttribute('transform', part.transform ? `${anim} ${part.transform}` : anim);
  }
  renderOverlay();
}

// ---- Overlay: selection box, pivots, drag gizmos, node handles ----

function renderOverlay(): void {
  if (!overlay || !svg || !rootGroup) return;
  overlay.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  if (state.mode === 'nodes') {
    const part = selectedPart();
    if (part) renderNodeHandles(part);
    return;
  }

  const size = handleSize();
  const rootTransform = rootGroup.getAttribute('transform') ?? '';

  // Everything positioned in root coordinates rides in one passive holder.
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'overlay-passive');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  overlay.appendChild(holder);

  // Ghost markers: every part's pivot, so the whole skeleton is visible at a glance.
  for (const part of doc.parts) {
    if (part.id === state.selectedPartId) continue;
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(part.pivot.x));
    dot.setAttribute('cy', String(part.pivot.y));
    dot.setAttribute('r', String(size * 0.55));
    dot.setAttribute('class', 'pivot-ghost');
    holder.appendChild(dot);
  }

  const part = selectedPart();
  if (!part) return;
  const g = partGroups.get(part.id);
  if (!g) return;

  // Dashed transform box around the selected part, rotating live with the pose.
  const boxHolder = document.createElementNS(SVG_NS, 'g');
  boxHolder.setAttribute('class', 'overlay-passive');
  const partTransform = g.getAttribute('transform') ?? '';
  boxHolder.setAttribute('transform', [rootTransform, partTransform].filter(Boolean).join(' '));
  const box = g.getBBox();
  const pad = size * 0.6;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(box.x - pad));
  rect.setAttribute('y', String(box.y - pad));
  rect.setAttribute('width', String(box.width + pad * 2));
  rect.setAttribute('height', String(box.height + pad * 2));
  rect.setAttribute('class', 'select-box');
  rect.setAttribute('stroke-dasharray', `${size * 0.9} ${size * 0.7}`);
  boxHolder.appendChild(rect);
  for (const [cx, cy] of [
    [box.x - pad, box.y - pad],
    [box.x + box.width + pad, box.y - pad],
    [box.x + box.width + pad, box.y + box.height + pad],
    [box.x - pad, box.y + box.height + pad],
  ]) {
    const corner = document.createElementNS(SVG_NS, 'rect');
    const s = size * 0.9;
    corner.setAttribute('x', String(cx - s / 2));
    corner.setAttribute('y', String(cy - s / 2));
    corner.setAttribute('width', String(s));
    corner.setAttribute('height', String(s));
    corner.setAttribute('class', 'select-corner');
    boxHolder.appendChild(corner);
  }
  overlay.appendChild(boxHolder);

  renderDragGizmo(holder, size);

  // The selected pivot: crosshair + ring, with a generous invisible grab circle.
  // Drawn last (and in its own interactive group) so it stays on top and draggable.
  const px = part.pivot.x, py = part.pivot.y;
  const cross = document.createElementNS(SVG_NS, 'g');
  cross.setAttribute('class', 'pivot-handle');
  cross.dataset.role = 'pivot';
  if (rootTransform) cross.setAttribute('transform', rootTransform);
  cross.innerHTML =
    `<circle class="pivot-grab" cx="${px}" cy="${py}" r="${size * 2.2}" />` +
    `<circle class="pivot-ring" cx="${px}" cy="${py}" r="${size * 1.1}" />` +
    `<circle class="pivot-dot" cx="${px}" cy="${py}" r="${size * 0.3}" />` +
    `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
    `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
  overlay.appendChild(cross);
}

/** Rotation arc + angle readout, or translation deltas, while a drag is live. */
function renderDragGizmo(holder: SVGGElement, size: number): void {
  if (!drag) return;

  if (drag.kind === 'rotate' && drag.current) {
    const { part } = drag;
    const p = part.pivot;
    const r = size * 5;
    const a0 = drag.startAngle;
    const a1 = Math.atan2(drag.current.y - p.y, drag.current.x - p.x);
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
    line.setAttribute('x2', String(drag.current.x));
    line.setAttribute('y2', String(drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);

    addGizmoText(
      holder,
      drag.current.x + size * 1.5,
      drag.current.y - size * 1.5,
      `${drag.currentValue.toFixed(1)}°${drag.snapped ? ' (snap)' : ''}`,
      size,
    );
  } else if (drag.kind === 'translate' && drag.current) {
    const dx = drag.current.x - drag.startX;
    const dy = drag.current.y - drag.startY;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(drag.startX));
    line.setAttribute('y1', String(drag.startY));
    line.setAttribute('x2', String(drag.current.x));
    line.setAttribute('y2', String(drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);
    addGizmoText(
      holder,
      drag.current.x + size * 1.5,
      drag.current.y - size * 1.5,
      `Δ ${round1(dx)}, ${round1(dy)}`,
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
  const g = partGroups.get(part.id)!;
  for (const path of part.paths) {
    const cmds = parsePath(path.d);
    const holder = document.createElementNS(SVG_NS, 'g');
    // Same accumulated transform as the drawn path (root + part + path), so raw path
    // coordinates land exactly on the rendered artwork.
    const rootTransform = rootGroup?.getAttribute('transform') ?? '';
    const groupTransform = g.getAttribute('transform') ?? '';
    holder.setAttribute(
      'transform',
      [rootTransform, groupTransform, path.transform].filter(Boolean).join(' '),
    );
    const size = handleSize();

    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      if (c.cmd === 'C') {
        addHandle(holder, path.id, i, 'x1', c.x1, c.y1, size * 0.6, 'ctrl');
        addHandle(holder, path.id, i, 'x2', c.x2, c.y2, size * 0.6, 'ctrl');
      }
      addHandle(holder, path.id, i, 'x', (c as { x: number }).x, (c as { y: number }).y, size * 0.8, 'node');
    });
    overlay!.appendChild(holder);
  }
}

function addHandle(
  holder: SVGGElement, pathId: string, cmdIndex: number,
  field: 'x' | 'x1' | 'x2', x: number, y: number, r: number, kind: 'node' | 'ctrl',
): void {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', String(x));
  c.setAttribute('cy', String(y));
  c.setAttribute('r', String(r));
  c.setAttribute('class', kind === 'node' ? 'node-handle' : 'ctrl-handle');
  c.dataset.role = 'node';
  c.dataset.pathId = pathId;
  c.dataset.cmdIndex = String(cmdIndex);
  c.dataset.field = field;
  holder.appendChild(c);
}

/** Handle radius in user units, compensating for on-screen scale. */
function handleSize(): number {
  if (!svg) return 4;
  const ctm = svg.getScreenCTM();
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
  return 6 / scale;
}

// ---- Interactions ----

type DragState =
  | {
      kind: 'rotate'; part: RigPart; startAngle: number; startValue: number;
      current: { x: number; y: number } | null; currentValue: number; snapped: boolean;
    }
  | {
      kind: 'translate'; part: RigPart; startX: number; startY: number;
      startTx: number; startTy: number; current: { x: number; y: number } | null;
    }
  | { kind: 'pivot'; part: RigPart }
  | { kind: 'node'; part: RigPart; pathId: string; cmdIndex: number; field: 'x' | 'x1' | 'x2'; holder: SVGGElement };

let drag: DragState | null = null;
// Deferred so a plain click (select) doesn't push a no-op undo entry; the checkpoint
// lands on the first real movement of a drag.
let checkpointPending = false;

function wireInteractions(): void {
  if (!svg) return;

  svg.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element;
    const doc = state.doc;
    if (!doc) return;

    if (target instanceof SVGElement && target.dataset.role === 'node') {
      const part = selectedPart();
      if (!part) return;
      const nodeDrag: DragState = {
        kind: 'node',
        part,
        pathId: target.dataset.pathId!,
        cmdIndex: Number(target.dataset.cmdIndex),
        field: target.dataset.field as 'x' | 'x1' | 'x2',
        holder: target.parentElement as unknown as SVGGElement,
      };
      if (ev.altKey || ev.ctrlKey) {
        checkpoint();
        editNodeStructure(nodeDrag, ev.altKey ? 'insert' : 'delete');
        return;
      }
      drag = nodeDrag;
      checkpointPending = true;
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const pivotEl = (target as Element).closest('[data-role="pivot"]');
    if (pivotEl) {
      const part = selectedPart();
      if (!part) return;
      drag = { kind: 'pivot', part };
      checkpointPending = true;
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const partEl = (target as Element).closest('[data-part-id]') as SVGGElement | null;
    if (partEl) {
      const part = doc.parts.find((p) => p.id === partEl.dataset.partId) ?? null;
      state.selectedPartId = part?.id ?? null;
      if (part && state.mode === 'rig') {
        const p = pointerInRoot(ev);
        checkpointPending = true;
        if (ev.shiftKey) {
          drag = {
            kind: 'translate', part,
            startX: p.x, startY: p.y,
            startTx: sampleChannel(part.id, 'tx', state.currentTime),
            startTy: sampleChannel(part.id, 'ty', state.currentTime),
            current: { x: p.x, y: p.y },
          };
        } else {
          const startValue = sampleChannel(part.id, 'rotate', state.currentTime);
          drag = {
            kind: 'rotate', part,
            startAngle: Math.atan2(p.y - part.pivot.y, p.x - part.pivot.x),
            startValue,
            current: { x: p.x, y: p.y },
            currentValue: startValue,
            snapped: false,
          };
        }
        try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }

    state.selectedPartId = null;
    notify();
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (checkpointPending) {
      checkpoint();
      checkpointPending = false;
    }
    if (drag.kind === 'rotate') {
      const p = pointerInRoot(ev);
      const angle = Math.atan2(p.y - drag.part.pivot.y, p.x - drag.part.pivot.x);
      const deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
      let value = drag.startValue + deltaDeg;
      drag.snapped = ev.ctrlKey;
      if (ev.ctrlKey) value = Math.round(value / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
      drag.current = { x: p.x, y: p.y };
      drag.currentValue = round1(value);
      setKeyframe(drag.part.id, 'rotate', drag.currentValue);
      renderPose();
      notifyTimelineOnly();
    } else if (drag.kind === 'translate') {
      const p = pointerInRoot(ev);
      drag.current = { x: p.x, y: p.y };
      setKeyframe(drag.part.id, 'tx', round1(drag.startTx + p.x - drag.startX));
      setKeyframe(drag.part.id, 'ty', round1(drag.startTy + p.y - drag.startY));
      renderPose();
      notifyTimelineOnly();
    } else if (drag.kind === 'pivot') {
      const p = pointerInRoot(ev);
      drag.part.pivot = { x: round1(p.x), y: round1(p.y) };
      renderPose();
    } else if (drag.kind === 'node') {
      moveNode(drag, ev);
    }
  });

  const end = () => {
    checkpointPending = false;
    if (drag) {
      drag = null;
      notify();
      renderPose(); // clears gizmos
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function moveNode(d: Extract<DragState, { kind: 'node' }>, ev: PointerEvent): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const local = pointerInElement(ev, d.holder);
  const cmds = parsePath(path.d);
  const c = cmds[d.cmdIndex] as PathCmd & Record<string, number>;
  if (!c || c.cmd === 'Z') return;

  if (d.field === 'x') {
    // Move control points rigidly with their endpoint so curve shape is preserved.
    if (c.cmd === 'C') {
      c.x2 += local.x - c.x; c.y2 += local.y - c.y;
    }
    const next = cmds[d.cmdIndex + 1];
    if (next && next.cmd === 'C') {
      next.x1 += local.x - c.x; next.y1 += local.y - c.y;
    }
    c.x = local.x; c.y = local.y;
  } else if (d.field === 'x1' && c.cmd === 'C') {
    c.x1 = local.x; c.y1 = local.y;
  } else if (d.field === 'x2' && c.cmd === 'C') {
    c.x2 = local.x; c.y2 = local.y;
  }
  path.d = serializePath(cmds);
  const el = svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}

function editNodeStructure(d: Extract<DragState, { kind: 'node' }>, op: 'insert' | 'delete'): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const cmds = parsePath(path.d);
  if (op === 'insert') {
    if (!insertNodeAfter(cmds, d.cmdIndex)) return;
  } else {
    if (cmds.length <= 3 || cmds[d.cmdIndex].cmd === 'M') return;
    cmds.splice(d.cmdIndex, 1);
  }
  path.d = serializePath(cmds);
  const el = svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}

// ---- Coordinate helpers ----

function svgPoint(x: number, y: number): DOMPoint {
  const pt = svg!.createSVGPoint();
  pt.x = x; pt.y = y;
  return pt;
}

/** Pointer position in root (document) coordinates — where pivots and parts live. */
function pointerInRoot(ev: PointerEvent): DOMPoint {
  const m = rootGroup!.getScreenCTM();
  return svgPoint(ev.clientX, ev.clientY).matrixTransform(m!.inverse());
}

/** Pointer position in an overlay holder's local space (raw path coordinates). */
function pointerInElement(ev: PointerEvent, el: SVGGElement): DOMPoint {
  const m = el.getScreenCTM();
  return svgPoint(ev.clientX, ev.clientY).matrixTransform(m!.inverse());
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}
