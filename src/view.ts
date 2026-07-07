/**
 * The editing canvas: renders the rig as live SVG and handles direct manipulation.
 *
 * Global editing modes (state.editorMode):
 *   Setup   — edit the character itself, Inkscape-style: dragging a part MOVES it
 *             (rest tx/ty); the selected part shows corner/side SCALE handles, and
 *             clicking it again swaps them for corner ROTATE handles (drag to spin the
 *             rest pose around the pivot). Pivots are draggable, node editing is
 *             available, double-clicking enters a part and selects the path under the
 *             cursor. Nothing here ever creates keyframes.
 *   Animate — dragging a part rotates it around its pivot (Shift+drag translates),
 *             recording keyframes at the playhead. Keyed values are ABSOLUTE; channels
 *             without keys fall back to the rest pose (see model.channelValue).
 *
 * Navigation: scroll wheel zooms around the cursor, middle-button drag pans, and
 * resetView() re-fits the document.
 *
 * Parts may be parented (part.parentId): a part's pose rides on its ancestors' poses,
 * so rotating an upper arm carries the forearm. Overlay pivots track the LIVE joint
 * positions. Rest scale (sx/sy) applies along the artwork's own local axes around the
 * joint — innermost, after the baked transform — so the selection box scales cleanly
 * and the pivot never moves; like baked transforms, it does not propagate to children.
 */

import {
  RigPart, RigPath, state, notify, setKeyframe, selectedPart, selectedParts,
  selectPart, ancestorChain, activeClip, channelValue, sampleChannel,
} from './model';
import { parsePath, serializePath, insertNodeAfter, PathCmd } from './paths';
import { Mat, applyMat, invertMat, matrixOfTransform } from './transforms';
import { checkpoint } from './history';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROTATE_SNAP_DEGREES = 15;
/** Client-pixel movement before a drag counts as a drag (keeps clicks mutation-free). */
const DRAG_THRESHOLD_PX = 3;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

let svg: SVGSVGElement | null = null;
let rootGroup: SVGGElement | null = null;
let onionGroup: SVGGElement | null = null;
let overlay: SVGGElement | null = null;
const partGroups = new Map<string, SVGGElement>();

// Which handle set the selected part shows in Setup mode; clicking the part again
// toggles it (Inkscape behavior). Resets when the primary selection changes.
let handleMode: 'scale' | 'rotate' = 'scale';
let handlePartId: string | null = null;

// Current viewBox rect — the zoom/pan state. Survives canvas rebuilds (undo/redo);
// reset explicitly on document import.
let viewRect: { x: number; y: number; w: number; h: number } | null = null;

export function resetView(): void {
  viewRect = null;
  if (svg && state.doc) {
    viewRect = { ...state.doc.viewBox };
    applyViewRect();
  }
}

function applyViewRect(): void {
  if (!svg || !viewRect) return;
  svg.setAttribute('viewBox', `${viewRect.x} ${viewRect.y} ${viewRect.w} ${viewRect.h}`);
}

export function buildCanvas(container: HTMLElement): void {
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  svg = document.createElementNS(SVG_NS, 'svg');
  if (!viewRect) viewRect = { ...doc.viewBox };
  applyViewRect();
  svg.id = 'rig-svg';

  onionGroup = document.createElementNS(SVG_NS, 'g');
  onionGroup.id = 'onion';
  svg.appendChild(onionGroup);
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
      applyPathAttrs(el, p);
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
    const needsSeed = part.pivotHint || (part.pivot.x === 0 && part.pivot.y === 0);
    if (!needsSeed) continue;
    const g = partGroups.get(part.id)!;
    const box = g.getBBox();
    const local = svgPoint(box.x + box.width / 2, box.y + box.height / 2);
    const m = g.getCTM();
    const rootM = rootGroup.getCTM();
    if (!m || !rootM) continue;
    const center = local.matrixTransform(m).matrixTransform(rootM.inverse());
    if (part.pivotHint) {
      // Authored rotation center (Inkscape crosshair), offset from the bbox center.
      part.pivot = { x: center.x + part.pivotHint.dx, y: center.y + part.pivotHint.dy };
      part.pivotHint = null;
    } else {
      part.pivot = { x: center.x, y: center.y };
    }
  }

  wireInteractions();
  renderPose();
}

function applyPathAttrs(el: SVGPathElement, p: RigPath): void {
  el.setAttribute('d', p.d);
  el.setAttribute('fill', p.fill ?? 'none');
  el.setAttribute('fill-opacity', String(p.fillOpacity));
  if (p.stroke) {
    el.setAttribute('stroke', p.stroke);
    el.setAttribute('stroke-width', String(p.strokeWidth));
    el.setAttribute('stroke-opacity', String(p.strokeOpacity));
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
  } else {
    el.removeAttribute('stroke');
    el.removeAttribute('stroke-width');
    el.removeAttribute('stroke-opacity');
  }
  if (p.transform) el.setAttribute('transform', p.transform);
}

/** Refresh a rendered path's style/geometry after inspector edits. */
export function updatePathAttrs(p: RigPath): void {
  const el = svg?.querySelector<SVGPathElement>(`[data-path-id="${p.id}"]`);
  if (el) applyPathAttrs(el, p);
  renderOverlay();
}

/**
 * Re-sync DOM paint order with doc.parts / part.paths after a z-order change.
 * appendChild moves the existing nodes, so this is cheap — no rebuild, no re-measure.
 */
export function reorderCanvas(): void {
  const doc = state.doc;
  if (!doc || !rootGroup) return;
  for (const part of doc.parts) {
    const g = partGroups.get(part.id);
    if (!g) continue;
    rootGroup.appendChild(g);
    for (const p of part.paths) {
      const el = g.querySelector(`[data-path-id="${p.id}"]`);
      if (el) g.appendChild(el);
    }
  }
  renderPose();
}

// ---- Pose evaluation helpers ----

/** The time to sample animation at, or null when Setup mode shows the bare rest pose. */
function poseTime(): number | null {
  return state.editorMode === 'animate' ? state.currentTime : null;
}

function rootPoseTransform(t: number | null): string {
  const doc = state.doc!;
  const rtx = t === null ? 0 : sampleChannel('root', 'tx', t);
  const rty = t === null ? 0 : sampleChannel('root', 'ty', t);
  const rsx = t === null ? 1 : sampleChannel('root', 'sx', t);
  const rsy = t === null ? 1 : sampleChannel('root', 'sy', t);
  const rp = doc.rootPivot;
  return (
    `translate(${rtx},${rty}) translate(${rp.x},${rp.y}) ` +
    `scale(${rsx},${rsy}) translate(${-rp.x},${-rp.y})`
  );
}

/** A part's own pose transform: keyed channels are absolute, rest fills the gaps. */
function ownPoseTransform(part: RigPart, t: number | null): string {
  const rot = channelValue(part, 'rotate', t);
  const tx = channelValue(part, 'tx', t);
  const ty = channelValue(part, 'ty', t);
  return `translate(${tx},${ty}) rotate(${rot},${part.pivot.x},${part.pivot.y})`;
}

/** The pivot mapped into the part's pre-baked local space (where rest scale applies). */
function localPivotOf(part: RigPart): { x: number; y: number } {
  return applyMat(invertMat(matrixOfTransform(part.transform)), part.pivot.x, part.pivot.y);
}

/**
 * Rest scale, applied innermost (after the baked transform) around the local pivot:
 * the artwork resizes along its own axes and the joint stays exactly in place.
 */
function innerScaleTransform(part: RigPart): string {
  const { sx, sy } = part.rest;
  if (sx === 1 && sy === 1) return '';
  const pl = localPivotOf(part);
  return `translate(${pl.x},${pl.y}) scale(${sx},${sy}) translate(${-pl.x},${-pl.y})`;
}

/** Ancestor poses composed with the part's own pose (bone hierarchy). */
function fullPoseTransform(part: RigPart, t: number | null): string {
  const pieces = ancestorChain(part).map((a) => ownPoseTransform(a, t));
  pieces.push(ownPoseTransform(part, t));
  return pieces.join(' ');
}

/** The complete transform string a part group renders with. */
function groupTransformOf(part: RigPart, t: number | null): string {
  return [fullPoseTransform(part, t), part.transform, innerScaleTransform(part)]
    .filter(Boolean)
    .join(' ');
}

/** Matrix of the ancestors' poses only (maps a part's rest space into root space). */
function chainMatOf(part: RigPart, t: number | null): Mat {
  return matrixOfTransform(ancestorChain(part).map((a) => ownPoseTransform(a, t)).join(' '));
}

function ownTranslateOf(part: RigPart, t: number | null): { x: number; y: number } {
  return { x: channelValue(part, 'tx', t), y: channelValue(part, 'ty', t) };
}

/** Where the part's joint actually sits right now, in root coordinates. */
function effectivePivot(part: RigPart, t: number | null): { x: number; y: number } {
  const m = chainMatOf(part, t);
  const ot = ownTranslateOf(part, t);
  return applyMat(m, part.pivot.x + ot.x, part.pivot.y + ot.y);
}

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !rootGroup) return;
  const t = poseTime();

  rootGroup.setAttribute('transform', rootPoseTransform(t));
  for (const part of doc.parts) {
    const g = partGroups.get(part.id);
    if (!g) continue;
    g.setAttribute('transform', groupTransformOf(part, t));
  }
  renderOnion();
  renderOverlay();
}

// ---- Onion skinning ----

/** Ghost silhouettes of the previous/next keyed poses while animating. */
function renderOnion(): void {
  if (!onionGroup) return;
  onionGroup.innerHTML = '';
  const doc = state.doc;
  if (!doc || !state.onionSkin || state.editorMode !== 'animate') return;
  const clip = activeClip();
  if (!clip) return;

  const times = [...new Set(clip.tracks.flatMap((tr) => tr.keyframes.map((k) => k.time)))]
    .sort((a, b) => a - b);
  const t = state.currentTime;
  const prev = times.filter((k) => k < t - 1).pop();
  const next = times.find((k) => k > t + 1);

  for (const [ghostTime, cls] of [
    [prev, 'onion-prev'],
    [next, 'onion-next'],
  ] as const) {
    if (ghostTime === undefined) continue;
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', `onion-ghost ${cls}`);
    layer.setAttribute('transform', rootPoseTransform(ghostTime));
    for (const part of doc.parts) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', groupTransformOf(part, ghostTime));
      for (const p of part.paths) {
        const el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', p.d);
        if (p.transform) el.setAttribute('transform', p.transform);
        g.appendChild(el);
      }
      layer.appendChild(g);
    }
    onionGroup.appendChild(layer);
  }
}

// ---- Overlay: selection box, handles, pivots, drag gizmos, node handles ----

function renderOverlay(): void {
  if (!overlay || !svg || !rootGroup) return;
  overlay.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  const setup = state.editorMode === 'setup';

  // Reset the handle cycle when the primary selection changes.
  if (state.selectedPartId !== handlePartId) {
    handlePartId = state.selectedPartId;
    handleMode = 'scale';
  }

  if (state.mode === 'nodes' && setup) {
    const part = selectedPart();
    if (part) renderNodeHandles(part);
    return;
  }

  const size = handleSize();
  const t = poseTime();
  const rootTransform = rootGroup.getAttribute('transform') ?? '';

  // Everything positioned in root coordinates rides in one passive holder.
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'overlay-passive');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  overlay.appendChild(holder);

  // Ghost markers: every part's live joint, so the whole skeleton is visible at a glance.
  for (const part of doc.parts) {
    if (part.id === state.selectedPartId) continue;
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
    const g = part ? partGroups.get(part.id) : null;
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
      overlay.appendChild(wrap);
    }
  }

  // Dashed transform boxes around every selected part, rotating live with the pose.
  for (const part of selectedParts()) {
    const g = partGroups.get(part.id);
    if (!g) continue;
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
    overlay.appendChild(boxHolder);

    if (!primary) continue;

    if (setup) {
      // Interactive Inkscape-style handles for the primary part.
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (handleMode === 'scale') {
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
      }
      overlay.appendChild(handles);
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
      overlay.appendChild(boxCorners);
    }
  }

  renderDragGizmo(holder, size);

  // The selected pivot: crosshair + ring, with a generous invisible grab circle.
  // Drawn last (and in its own interactive group) so it stays on top; draggable only in
  // Setup mode — moving a joint is a rig edit, not an animation edit.
  const part = selectedPart();
  if (!part) return;
  const ep = effectivePivot(part, t);
  const px = ep.x, py = ep.y;
  const cross = document.createElementNS(SVG_NS, 'g');
  cross.setAttribute('class', setup ? 'pivot-handle' : 'pivot-handle locked');
  if (setup) cross.dataset.role = 'pivot';
  if (rootTransform) cross.setAttribute('transform', rootTransform);
  cross.innerHTML =
    `<circle class="pivot-grab" cx="${px}" cy="${py}" r="${size * 2.2}" />` +
    `<circle class="pivot-ring" cx="${px}" cy="${py}" r="${size * 1.1}" />` +
    `<circle class="pivot-dot" cx="${px}" cy="${py}" r="${size * 0.3}" />` +
    `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
    `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
  overlay.appendChild(cross);
}

/** Rotation arc + angle readout, translation deltas, or scale % while a drag is live. */
function renderDragGizmo(holder: SVGGElement, size: number): void {
  if (!drag || drag.kind === 'pan' || !drag.active) return;

  if (drag.kind === 'rotate' && drag.current) {
    const p = { x: drag.pivotX, y: drag.pivotY };
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
      `${drag.currentDelta.toFixed(1)}°${drag.snapped ? ' (snap)' : ''}`,
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
  } else if (drag.kind === 'scale' && drag.current) {
    addGizmoText(
      holder,
      drag.current.x + size * 1.5,
      drag.current.y - size * 1.5,
      `${Math.round(drag.part.rest.sx * 100)}% × ${Math.round(drag.part.rest.sy * 100)}%`,
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
  // With a path "entered", node editing scopes to it; otherwise every path is editable.
  const paths = state.selectedPathId
    ? part.paths.filter((p) => p.id === state.selectedPathId)
    : part.paths;
  for (const path of paths) {
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
      kind: 'rotate';
      /** Every selected part with its starting (absolute) value; setup writes rest. */
      targets: { part: RigPart; start: number }[];
      pivotX: number; pivotY: number; // primary part's live pivot, root coords
      startAngle: number;
      current: { x: number; y: number } | null;
      currentDelta: number;
      snapped: boolean;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'translate';
      /** invLinear maps a root-space delta into each part's parent-chain space. */
      targets: { part: RigPart; startTx: number; startTy: number; invLinear: Mat }[];
      startX: number; startY: number;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
      /** Click (no movement) on the already-primary part cycles scale↔rotate handles. */
      toggleOnClick: boolean;
    }
  | {
      kind: 'scale';
      part: RigPart;
      handle: string; // nw|ne|se|sw|n|e|s|w
      startSx: number; startSy: number;
      startTx: number; startTy: number;
      grabLocal: { x: number; y: number };
      anchorLocal: { x: number; y: number };
      anchorRoot: { x: number; y: number };
      /** root → part-local at drag start (frozen frame for stable factors). */
      invStart: Mat;
      invChainLinear: Mat;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'pivot'; part: RigPart; startClient: { x: number; y: number }; active: boolean }
  | {
      kind: 'node'; part: RigPart; pathId: string; cmdIndex: number;
      field: 'x' | 'x1' | 'x2'; holder: SVGGElement;
      startClient: { x: number; y: number }; active: boolean;
    }
  | { kind: 'pan'; startClient: { x: number; y: number }; startRect: { x: number; y: number; w: number; h: number } };

let drag: DragState | null = null;

/** First real movement of a drag: fire the deferred checkpoint exactly once. */
function activateDrag(d: Exclude<DragState, { kind: 'pan' }>, ev: PointerEvent): boolean {
  if (d.active) return true;
  const dx = ev.clientX - d.startClient.x;
  const dy = ev.clientY - d.startClient.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;
  checkpoint();
  d.active = true;
  return true;
}

function wireInteractions(): void {
  if (!svg) return;

  // Middle-drag pan + wheel zoom (navigation, not editing — no checkpoints).
  svg.addEventListener('wheel', (ev) => {
    if (!viewRect || !svg) return;
    ev.preventDefault();
    const m = svg.getScreenCTM();
    if (!m) return;
    const p = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const factor = Math.pow(1.0015, -ev.deltaY);
    const doc = state.doc;
    const minW = doc ? doc.viewBox.w / 60 : 1;
    const maxW = doc ? doc.viewBox.w * 12 : 10000;
    const newW = Math.min(maxW, Math.max(minW, viewRect.w / factor));
    const applied = viewRect.w / newW;
    viewRect.x = p.x - (p.x - viewRect.x) / applied;
    viewRect.y = p.y - (p.y - viewRect.y) / applied;
    viewRect.w = newW;
    viewRect.h = viewRect.h / applied;
    applyViewRect();
    renderPose(); // overlay handle sizes track the zoom level
  }, { passive: false });

  // Double-click "enters" a part and selects the path under the cursor (like entering
  // a group in an SVG editor). Escape or a blank click leaves it.
  svg.addEventListener('dblclick', (ev) => {
    if (state.editorMode !== 'setup') return;
    const target = ev.target as SVGElement;
    const pathId = target.dataset?.pathId;
    const partEl = target.closest('[data-part-id]') as SVGGElement | null;
    if (!pathId || !partEl?.dataset.partId) return;
    selectPart(partEl.dataset.partId);
    state.selectedPathId = pathId;
    notify();
    renderPose();
  });

  svg.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element;
    const doc = state.doc;
    if (!doc) return;

    if (ev.button === 1) {
      ev.preventDefault(); // no middle-click autoscroll
      drag = { kind: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, startRect: { ...viewRect! } };
      svg!.style.cursor = 'grabbing';
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (ev.button !== 0) return;

    // Scale handle (Setup mode)
    if (target instanceof SVGElement && target.dataset.handle) {
      const part = selectedPart();
      const g = part ? partGroups.get(part.id) : null;
      if (!part || !g) return;
      const box = g.getBBox();
      const pad = handleSize() * 0.6;
      const x0 = box.x - pad, y0 = box.y - pad;
      const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const spots: Record<string, { g: { x: number; y: number }; a: { x: number; y: number } }> = {
        nw: { g: { x: x0, y: y0 }, a: { x: x1, y: y1 } },
        ne: { g: { x: x1, y: y0 }, a: { x: x0, y: y1 } },
        se: { g: { x: x1, y: y1 }, a: { x: x0, y: y0 } },
        sw: { g: { x: x0, y: y1 }, a: { x: x1, y: y0 } },
        n: { g: { x: cx, y: y0 }, a: { x: cx, y: y1 } },
        s: { g: { x: cx, y: y1 }, a: { x: cx, y: y0 } },
        e: { g: { x: x1, y: cy }, a: { x: x0, y: cy } },
        w: { g: { x: x0, y: cy }, a: { x: x1, y: cy } },
      };
      const spot = spots[target.dataset.handle];
      if (!spot) return;
      const t = poseTime();
      // groupTransformOf is the part's full rootGroup-relative transform; frozen at
      // drag start so scale factors are measured in a stable local frame.
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      const chainM = chainMatOf(part, t);
      drag = {
        kind: 'scale',
        part,
        handle: target.dataset.handle,
        startSx: part.rest.sx, startSy: part.rest.sy,
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainM)),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Rotate handle (Setup mode): spin the rest pose around the pivot.
    if (target instanceof SVGElement && target.dataset.role === 'rotate-handle') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const pivot = effectivePivot(part, poseTime());
      drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({ part: sp, start: sp.rest.rotate })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

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
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      if (ev.altKey || ev.ctrlKey) {
        checkpoint();
        editNodeStructure(nodeDrag, ev.altKey ? 'insert' : 'delete');
        return;
      }
      drag = nodeDrag;
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const pivotEl = (target as Element).closest('[data-role="pivot"]');
    if (pivotEl) {
      const part = selectedPart();
      if (!part) return;
      drag = { kind: 'pivot', part, startClient: { x: ev.clientX, y: ev.clientY }, active: false };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const partEl = (target as Element).closest('[data-part-id]') as SVGGElement | null;
    if (partEl) {
      const part = doc.parts.find((p) => p.id === partEl.dataset.partId) ?? null;
      const wasPrimary = part !== null && state.selectedPartId === part.id;
      if (part) {
        // Shift adds to the selection; clicking an already-selected part keeps the
        // group selected so multi-part drags work.
        if (ev.shiftKey || state.selectedPartIds.includes(part.id)) {
          selectPart(part.id, true);
        } else {
          selectPart(part.id);
        }
      } else {
        selectPart(null);
      }
      if (part && state.mode === 'rig') {
        const p = pointerInRoot(ev);
        const t = poseTime();
        const setup = state.editorMode === 'setup';
        // Setup: dragging moves the part (Inkscape-style; rotation via handles).
        // Animate: dragging rotates around the pivot; Shift+drag moves.
        if (setup || ev.shiftKey) {
          drag = {
            kind: 'translate',
            targets: selectedParts().map((sp) => ({
              part: sp,
              startTx: setup ? sp.rest.tx : channelValue(sp, 'tx', state.currentTime),
              startTy: setup ? sp.rest.ty : channelValue(sp, 'ty', state.currentTime),
              invLinear: linearOnly(invertMat(chainMatOf(sp, t))),
            })),
            startX: p.x, startY: p.y,
            current: { x: p.x, y: p.y },
            startClient: { x: ev.clientX, y: ev.clientY },
            active: false,
            toggleOnClick: setup && wasPrimary && !ev.shiftKey,
          };
        } else {
          const pivot = effectivePivot(part, t);
          drag = {
            kind: 'rotate',
            targets: selectedParts().map((sp) => ({
              part: sp,
              start: channelValue(sp, 'rotate', state.currentTime),
            })),
            pivotX: pivot.x, pivotY: pivot.y,
            startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
            current: { x: p.x, y: p.y },
            currentDelta: 0,
            snapped: false,
            startClient: { x: ev.clientX, y: ev.clientY },
            active: false,
          };
        }
        try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }

    // Blank canvas: clear the selection (and leave any "entered" path). No drag
    // follows a blank click, so repaint the overlay here — notify() only rebuilds
    // the side panels, and the stale selection box would linger otherwise.
    state.selectedPathId = null;
    selectPart(null);
    notify();
    renderOverlay();
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;

    if (drag.kind === 'pan') {
      if (!svg || !viewRect) return;
      const ctm = svg.getScreenCTM();
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
      viewRect.x = drag.startRect.x - (ev.clientX - drag.startClient.x) / scale;
      viewRect.y = drag.startRect.y - (ev.clientY - drag.startClient.y) / scale;
      applyViewRect();
      return;
    }

    if (!activateDrag(drag, ev)) return;
    const setup = state.editorMode === 'setup';

    if (drag.kind === 'rotate') {
      const p = pointerInRoot(ev);
      const angle = Math.atan2(p.y - drag.pivotY, p.x - drag.pivotX);
      const deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
      drag.snapped = ev.ctrlKey;
      drag.current = { x: p.x, y: p.y };
      for (const { part, start } of drag.targets) {
        let value = start + deltaDeg;
        if (ev.ctrlKey) value = Math.round(value / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
        value = round1(value);
        if (part.id === drag.targets[0]?.part.id) drag.currentDelta = round1(value - start);
        if (setup) part.rest.rotate = value;
        else setKeyframe(part.id, 'rotate', value);
      }
      renderPose();
      notifyTimelineOnly();
    } else if (drag.kind === 'translate') {
      const p = pointerInRoot(ev);
      drag.current = { x: p.x, y: p.y };
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      for (const { part, startTx, startTy, invLinear } of drag.targets) {
        const local = applyMat(invLinear, dx, dy);
        const tx = round1(startTx + local.x);
        const ty = round1(startTy + local.y);
        if (setup) {
          part.rest.tx = tx;
          part.rest.ty = ty;
        } else {
          setKeyframe(part.id, 'tx', tx);
          setKeyframe(part.id, 'ty', ty);
        }
      }
      renderPose();
      notifyTimelineOnly();
    } else if (drag.kind === 'scale') {
      const d = drag;
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampF = (f: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, f));
      let fx = 1, fy = 1;
      const denX = d.grabLocal.x - d.anchorLocal.x;
      const denY = d.grabLocal.y - d.anchorLocal.y;
      if (Math.abs(denX) > 1e-6) fx = clampF((local.x - d.anchorLocal.x) / denX);
      if (Math.abs(denY) > 1e-6) fy = clampF((local.y - d.anchorLocal.y) / denY);
      if (['n', 's'].includes(d.handle)) fx = 1;
      if (['e', 'w'].includes(d.handle)) fy = 1;
      if (ev.ctrlKey && !['n', 's', 'e', 'w'].includes(d.handle)) {
        // Uniform: follow whichever axis moved more.
        const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
        fx = f; fy = f;
      }
      d.part.rest.sx = round2(d.startSx * fx);
      d.part.rest.sy = round2(d.startSy * fy);
      // Keep the anchor (opposite corner/side) pinned: measure where it lands with the
      // new scale and push the difference back into the rest translation.
      d.part.rest.tx = d.startTx;
      d.part.rest.ty = d.startTy;
      const mNew = matrixOfTransform(groupTransformOf(d.part, poseTime()));
      const after = applyMat(mNew, d.anchorLocal.x, d.anchorLocal.y);
      const deltaLocal = applyMat(
        d.invChainLinear, d.anchorRoot.x - after.x, d.anchorRoot.y - after.y,
      );
      d.part.rest.tx = round1(d.startTx + deltaLocal.x);
      d.part.rest.ty = round1(d.startTy + deltaLocal.y);
      renderPose();
    } else if (drag.kind === 'pivot') {
      const p = pointerInRoot(ev);
      const part = drag.part;
      const t = poseTime();
      // Un-apply the ancestors' motion and the part's own translation so the stored
      // pivot stays in rest/document coordinates.
      const local = applyMat(invertMat(chainMatOf(part, t)), p.x, p.y);
      const ot = ownTranslateOf(part, t);
      part.pivot = { x: round1(local.x - ot.x), y: round1(local.y - ot.y) };
      renderPose();
    } else if (drag.kind === 'node') {
      moveNode(drag, ev);
    }
  });

  const end = () => {
    if (drag) {
      if (drag.kind === 'pan') svg!.style.cursor = '';
      // A motionless click on the already-selected part cycles scale ↔ rotate handles.
      if (drag.kind === 'translate' && !drag.active && drag.toggleOnClick) {
        handleMode = handleMode === 'scale' ? 'rotate' : 'scale';
      }
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

/** Strip translation from a matrix (for converting deltas rather than points). */
function linearOnly(m: Mat): Mat {
  return { ...m, e: 0, f: 0 };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}
