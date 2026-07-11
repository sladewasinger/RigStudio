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
  RigPart, RigPath, Channel, state, notify, setKeyframe, selectedPart, selectedParts,
  selectPart, ancestorChain, activeClip, channelValue, addNullPart,
  freshId,
} from './model';
import {
  parsePath, serializePath, insertNodeAfter, pathToCubics, PathCmd,
  deleteSegment, closePath, joinPaths, isSingleSubpath, isClosedPath, nodeCount,
} from './paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from './transforms';
import { solveAim, solveTwoBone } from './ik';
import { snapPoint, snapDelta, boxFeaturePoints, SnapCandidate, SnapAxis } from './snap';
import { checkpoint } from './history';
import {
  ctx, DragState, SVG_NS, ROTATE_SNAP_DEGREES, DRAG_THRESHOLD_PX, MIN_SCALE, MAX_SCALE,
  round1, round2, round3, linearOnly, nodeKey, parseNodeKey, snappingActive,
} from './view/context';
import {
  svgPoint, pointerInRoot, screenScaleOf, snapThreshold, rootToUser,
  pathHolderMat, pointerInPathSpace, handleSize,
} from './view/coords';
import {
  poseTime, rootPoseTransform, innerLocalTransform, fullPoseTransform, groupTransformOf,
  chainMatOf, ownTranslateOf, effectivePivot, effectiveTip, partRootBoxes,
} from './view/pose';
import {
  clearGroupEntry, enterGroupsFor, focusContext, artworkUnderPointer,
} from './view/focus';
import { renderSkinnedPart, invalidateSkinCache } from './view/skinRender';
import { renderOverlay } from './view/overlay';

export { partRootBoxes };
export { clearGroupEntry, enterGroupsFor };

/** Index of a command among the drawing commands (Z excluded) — nodeTypes position. */
function nodeIndexOf(cmds: PathCmd[], cmdIndex: number): number {
  let n = 0;
  for (let i = 0; i < cmdIndex; i++) {
    if (cmds[i].cmd !== 'Z') n++;
  }
  return n;
}

/** The nodeTypes string padded/created to match the path's drawing-command count. */
function ensureNodeTypes(path: RigPath): string {
  const count = parsePath(path.d).filter((c) => c.cmd !== 'Z').length;
  let types = path.nodeTypes ?? '';
  if (types.length > count) types = types.slice(0, count);
  while (types.length < count) types += 'c';
  path.nodeTypes = types;
  return types;
}

export function resetView(): void {
  ctx.viewRect = null;
  if (ctx.svg && state.doc) {
    ctx.viewRect = { ...state.doc.viewBox };
    applyViewRect();
  }
}

function applyViewRect(): void {
  if (!ctx.svg || !ctx.viewRect) return;
  ctx.svg.setAttribute('viewBox', `${ctx.viewRect.x} ${ctx.viewRect.y} ${ctx.viewRect.w} ${ctx.viewRect.h}`);
}

/**
 * Core viewBox zoom: scale around the SVG-user-space point (px,py) by `factor` (>1
 * zooms in), clamped to the same 1/60..12x document-size bounds as wheel zoom. Shared
 * by the wheel handler (cursor-anchored) and zoomBy (keyboard, canvas-center-anchored).
 */
function zoomAround(px: number, py: number, factor: number): void {
  if (!ctx.svg || !ctx.viewRect) return;
  const doc = state.doc;
  const minW = doc ? doc.viewBox.w / 60 : 1;
  const maxW = doc ? doc.viewBox.w * 12 : 10000;
  const newW = Math.min(maxW, Math.max(minW, ctx.viewRect.w / factor));
  const applied = ctx.viewRect.w / newW;
  ctx.viewRect.x = px - (px - ctx.viewRect.x) / applied;
  ctx.viewRect.y = py - (py - ctx.viewRect.y) / applied;
  ctx.viewRect.w = newW;
  ctx.viewRect.h = ctx.viewRect.h / applied;
  applyViewRect();
  renderPose(); // overlay handle sizes track the zoom level
}

/** Zoom in/out by `factor` (>1 = in), centered on the canvas viewport (keyboard +/-). */
export function zoomBy(factor: number): void {
  if (!ctx.svg || !ctx.viewRect) return;
  const rect = ctx.svg.getBoundingClientRect();
  const m = ctx.svg.getScreenCTM();
  if (!m) return;
  const p = svgPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    .matrixTransform(m.inverse());
  zoomAround(p.x, p.y, factor);
}

export function buildCanvas(container: HTMLElement): void {
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  ctx.svg = document.createElementNS(SVG_NS, 'svg');
  if (!ctx.viewRect) ctx.viewRect = { ...doc.viewBox };
  applyViewRect();
  ctx.svg.id = 'rig-svg';

  ctx.onionGroup = document.createElementNS(SVG_NS, 'g');
  ctx.onionGroup.id = 'onion';
  ctx.svg.appendChild(ctx.onionGroup);
  ctx.rootGroup = document.createElementNS(SVG_NS, 'g');
  ctx.svg.appendChild(ctx.rootGroup);
  ctx.overlay = document.createElementNS(SVG_NS, 'g');
  ctx.overlay.id = 'overlay';
  ctx.svg.appendChild(ctx.overlay);

  ctx.partGroups.clear();
  for (const part of doc.parts) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.partId = part.id;
    for (const p of part.paths) {
      const el = document.createElementNS(SVG_NS, 'path');
      applyPathAttrs(el, p);
      el.dataset.pathId = p.id;
      g.appendChild(el);
    }
    ctx.rootGroup.appendChild(g);
    ctx.partGroups.set(part.id, g);
  }
  container.appendChild(ctx.svg);

  // Apply the rest pose first so each group carries its baked transform, THEN measure:
  // bbox centers must be mapped through the part transform into root coordinates.
  renderPose();
  for (const part of doc.parts) {
    const needsSeed = part.pivotHint || (part.pivot.x === 0 && part.pivot.y === 0);
    if (!needsSeed) continue;
    const g = ctx.partGroups.get(part.id)!;
    const box = g.getBBox();
    const local = svgPoint(box.x + box.width / 2, box.y + box.height / 2);
    const m = g.getCTM();
    const rootM = ctx.rootGroup.getCTM();
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
  const el = ctx.svg?.querySelector<SVGPathElement>(`[data-path-id="${p.id}"]`);
  if (el) applyPathAttrs(el, p);
  renderOverlay();
}

/**
 * Re-sync DOM paint order with doc.parts / part.paths after a z-order change.
 * appendChild moves the existing nodes, so this is cheap — no rebuild, no re-measure.
 */
export function reorderCanvas(): void {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return;
  for (const part of doc.parts) {
    const g = ctx.partGroups.get(part.id);
    if (!g) continue;
    ctx.rootGroup.appendChild(g);
    for (const p of part.paths) {
      const el = g.querySelector(`[data-path-id="${p.id}"]`);
      if (el) g.appendChild(el);
    }
  }
  renderPose();
}

/** Register a canvas group for a part created after buildCanvas (bones, groups). */
export function registerPart(part: RigPart): void {
  if (!ctx.rootGroup || ctx.partGroups.has(part.id)) return;
  const g = document.createElementNS(SVG_NS, 'g');
  g.dataset.partId = part.id;
  ctx.rootGroup.appendChild(g);
  ctx.partGroups.set(part.id, g);
}

/** Drop a removed part's canvas group (ungroup/dissolve). */
export function unregisterPart(id: string): void {
  ctx.partGroups.get(id)?.remove();
  ctx.partGroups.delete(id);
}

/**
 * Reconcile a part's <path> DOM with its current `part.paths` after a structural edit
 * (paths added by a split, removed by a merge). Creates missing elements, drops stale
 * ones, refreshes attributes, and re-appends everything in paint order. renderPose()
 * still owns transforms; undo/redo rebuilds via buildCanvas so this is forward-only.
 */
function syncPartPathDom(part: RigPart): void {
  const g = ctx.partGroups.get(part.id);
  if (!g) return;
  const wanted = new Set(part.paths.map((p) => p.id));
  for (const el of Array.from(g.querySelectorAll('[data-path-id]'))) {
    if (!wanted.has((el as SVGElement).dataset.pathId!)) el.remove();
  }
  for (const p of part.paths) {
    let el = g.querySelector<SVGPathElement>(`[data-path-id="${p.id}"]`);
    if (!el) {
      el = document.createElementNS(SVG_NS, 'path');
      el.dataset.pathId = p.id;
    }
    applyPathAttrs(el, p);
    g.appendChild(el); // re-append in order (moves existing, adds new at the right spot)
  }
}

// ---- Vector-editing operations (Setup mode) ----

/**
 * Flip the selected art parts in place — around each part's own rendered bbox center,
 * stored as negated rest scale (axes follow the artwork like all rest scaling), with
 * the bbox center pinned by rest-translation compensation. The joint doesn't move.
 */
export function flipSelected(axis: 'h' | 'v'): boolean {
  if (state.editorMode !== 'setup') return false;
  const parts = selectedParts().filter((p) => p.paths.length > 0 && ctx.partGroups.has(p.id));
  if (parts.length === 0) return false;
  const t = poseTime();
  for (const part of parts) {
    const g = ctx.partGroups.get(part.id)!;
    const box = g.getBBox();
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    if (axis === 'h') part.rest.sx = -part.rest.sx;
    else part.rest.sy = -part.rest.sy;
    const after = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    const local = applyMat(
      linearOnly(invertMat(chainMatOf(part, t))), before.x - after.x, before.y - after.y,
    );
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
  return true;
}

/**
 * Nudge the selected parts by a SCREEN-pixel delta (arrow keys), converted through
 * the current zoom and each part's parent chain — the keyboard twin of a translate
 * drag (Setup writes rest, Animate keys tx/ty at the playhead). Sub-0.1 steps at
 * high zoom survive thanks to finer rounding. Returns whether anything moved.
 */
export function nudgeSelectedParts(dxPx: number, dyPx: number): boolean {
  if (!ctx.svg) return false;
  const parts = selectedParts().filter((p) => !p.skin);
  if (parts.length === 0) return false;
  const ctm = ctx.svg.getScreenCTM();
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
  const dx = dxPx / scale;
  const dy = dyPx / scale;
  const t = poseTime();
  const setup = state.editorMode === 'setup';
  for (const part of parts) {
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), dx, dy);
    if (setup) {
      part.rest.tx = round3(part.rest.tx + local.x);
      part.rest.ty = round3(part.rest.ty + local.y);
    } else {
      setKeyframe(part.id, 'tx', round3(channelValue(part, 'tx', t) + local.x));
      setKeyframe(part.id, 'ty', round3(channelValue(part, 'ty', t) + local.y));
    }
  }
  renderPose();
  return true;
}

/** Apply root-space translation deltas (from align/distribute) via rest translation. */
export function applyRootDeltas(deltas: Map<string, { dx: number; dy: number }>): void {
  const doc = state.doc;
  if (!doc) return;
  const t = poseTime();
  for (const [id, d] of deltas) {
    if (d.dx === 0 && d.dy === 0) continue;
    const part = doc.parts.find((p) => p.id === id);
    if (!part) continue;
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), d.dx, d.dy);
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
}

/**
 * Bind the selected art parts to the selected bones (linear-blend skinning).
 * Bakes every static transform — parent chain, rest pose, baked SVG transform, rest
 * scale, per-path transforms — into the path data (the current Setup look becomes
 * the bind pose), zeroes the part's own pose so its motion comes purely from the
 * bones, and records each bone's rest world + segment for weights/deltas.
 * Returns an error message, or null on success. Caller checkpoints first.
 */
export function bindSelectedToBones(): string | null {
  if (state.editorMode !== 'setup') return 'Bind in Setup mode.';
  const arts = selectedParts().filter((p) => p.paths.length > 0);
  const bones = selectedParts().filter((p) => p.kind === 'bone');
  if (arts.length === 0 || bones.length === 0) {
    return 'Select at least one art part and one bone (Shift+click), then bind.';
  }

  const skinBones = bones.map((bone) => {
    const p = effectivePivot(bone, null);
    const q = effectiveTip(bone, null) ?? { x: p.x + 5, y: p.y };
    return {
      id: bone.id,
      restWorldInv: invertMat(matrixOfTransform(fullPoseTransform(bone, null))),
      bindSeg: { p, q },
    };
  });

  for (const part of arts) {
    const full = matrixOfTransform(groupTransformOf(part, null));
    for (const path of part.paths) {
      const m = multiply(full, matrixOfTransform(path.transform));
      const cmds = pathToCubics(parsePath(path.d)).map((c) => {
        if (c.cmd === 'C') {
          const p1 = applyMat(m, c.x1, c.y1);
          const p2 = applyMat(m, c.x2, c.y2);
          const p = applyMat(m, c.x, c.y);
          return { cmd: 'C' as const, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
        }
        if (c.cmd === 'Z') return c;
        const p = applyMat(m, (c as { x: number }).x, (c as { y: number }).y);
        return { ...c, x: p.x, y: p.y } as PathCmd;
      });
      path.d = serializePath(cmds);
      path.transform = '';
      path.strokeWidth = path.strokeWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      const el = ctx.svg?.querySelector<SVGPathElement>(`[data-path-id="${path.id}"]`);
      if (el) applyPathAttrs(el, path);
    }
    part.pivot = effectivePivot(part, null);
    part.transform = '';
    part.rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 };
    part.parentId = null;
    part.skin = { bones: skinBones.map((b) => ({ ...b, bindSeg: { p: { ...b.bindSeg.p }, q: { ...b.bindSeg.q } } })) };
    invalidateSkinCache(part.id);
  }
  renderPose();
  return null;
}

/** Remove the skin binding (geometry keeps its baked rest look, part turns rigid). */
export function unbindSelectedSkin(): boolean {
  const parts = selectedParts().filter((p) => p.skin);
  if (parts.length === 0) return false;
  for (const part of parts) {
    part.skin = null;
    invalidateSkinCache(part.id);
  }
  renderPose();
  return true;
}

// ---- Bone placement ----

/** Arm click-to-place: the next canvas click drops a bone (parented to the selection). */
export function startBonePlacement(): void {
  ctx.placingBone = true;
  if (ctx.svg) ctx.svg.style.cursor = 'crosshair';
}

/** Returns whether placement was active (Escape handling). */
export function cancelBonePlacement(): boolean {
  const was = ctx.placingBone;
  ctx.placingBone = false;
  if (ctx.svg) ctx.svg.style.cursor = '';
  return was;
}

// ---- Pose evaluation helpers ----

/** Route renderPose's channel sampling through fn (state-machine preview), or null to restore. */
export function setPoseSampler(fn: ((target: string, channel: Channel) => number) | null): void {
  ctx.poseSampler = fn;
  renderPose();
}

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return;
  const t = poseTime();

  ctx.rootGroup.setAttribute('transform', rootPoseTransform(t));
  const focus = focusContext();
  for (const part of doc.parts) {
    const g = ctx.partGroups.get(part.id);
    if (!g) continue;
    // Drill-down focus: parts outside the editing context fade and stop catching
    // pointer events (clicks fall through; node marquees sweep right over them).
    g.classList.toggle('dimmed', !!focus && !focus.has(part.id));
    if (part.skin) {
      // Skinned parts deform by their bones, not by a group transform.
      g.setAttribute('transform', '');
      renderSkinnedPart(part, g, t);
    } else {
      g.setAttribute('transform', groupTransformOf(part, t));
    }
  }
  renderOnion();
  renderOverlay();
}

// ---- Onion skinning ----

/** Ghost silhouettes of the previous/next keyed poses while animating. */
function renderOnion(): void {
  if (!ctx.onionGroup) return;
  ctx.onionGroup.innerHTML = '';
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
    ctx.onionGroup.appendChild(layer);
  }
}

// ---- Interactions ----

/** The start point of the segment ending at cmds[i] (previous node, Z-aware). */
function segmentStart(cmds: PathCmd[], i: number): { x: number; y: number } | null {
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
function pointOnSegment(
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
function segmentHit(
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
function subpathStart(cmds: PathCmd[], i: number): { x: number; y: number } | null {
  let start: { x: number; y: number } | null = null;
  for (let k = 0; k <= i; k++) {
    const c = cmds[k];
    if (c.cmd === 'M') start = { x: c.x, y: c.y };
  }
  return start;
}

/** First real movement of a drag: fire the deferred checkpoint exactly once. */
function activateDrag(
  d: Exclude<DragState, { kind: 'pan' } | { kind: 'placeBone' } | { kind: 'nodeMarquee' }>,
  ev: PointerEvent,
): boolean {
  if (d.active) return true;
  const dx = ev.clientX - d.startClient.x;
  const dy = ev.clientY - d.startClient.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;
  checkpoint();
  d.active = true;
  return true;
}

function wireInteractions(): void {
  if (!ctx.svg) return;

  // Middle-drag pan + wheel zoom (navigation, not editing — no checkpoints).
  ctx.svg.addEventListener('wheel', (ev) => {
    if (!ctx.viewRect || !ctx.svg) return;
    ev.preventDefault();
    const m = ctx.svg.getScreenCTM();
    if (!m) return;
    const p = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomAround(p.x, p.y, factor);
  }, { passive: false });

  // Double-click steps INTO things, SVG-editor style: group → part → path. Escape or
  // a blank click steps back out.
  ctx.svg.addEventListener('dblclick', (ev) => {
    // Resolve the ARTWORK under the cursor with elementsFromPoint, skipping overlay
    // widgets: the first click of a double-click selects a part and draws its pivot
    // grab circle — often right where the second click lands. The overlay must never
    // eat a drill-down.
    const hit = artworkUnderPointer(ev);
    if (!hit) {
      // In node-editing mode, a dblclick that lands off the shape (blank canvas, or a
      // dimmed/click-through part) exits the whole editing context: leave the entered
      // path, drop the node selection, close entered groups, and deselect everything.
      if (state.editorMode === 'setup' && state.mode === 'nodes') {
        state.selectedPathId = null;
        ctx.selectedNodes.clear();
        ctx.selectedNode = null;
        clearGroupEntry();
        selectPart(null);
        notify();
        renderPose();
      }
      return;
    }
    const { part, pathEl } = hit;
    // First: open the outermost still-closed group and select the next level.
    const closed = ancestorChain(part).find(
      (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
    );
    if (closed) {
      ctx.enteredGroups.add(closed.id);
      const next = ancestorChain(part).find(
        (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
      );
      selectPart(next?.id ?? part.id);
      notify();
      renderPose();
      return;
    }
    // Then: enter the part and select the path under the cursor (Setup only).
    if (state.editorMode !== 'setup') return;
    const pathId = pathEl?.dataset?.pathId;
    if (!pathId) return;
    selectPart(part.id);
    state.selectedPathId = pathId;
    notify();
    renderPose();
  });

  ctx.svg.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element;
    const doc = state.doc;
    if (!doc) return;

    // Bone placement: press to set the origin (the joint), drag to aim, release to
    // set the tip — like drawing a bone in Rive/Blender.
    if (ctx.placingBone && ev.button === 0) {
      const p = pointerInRoot(ev);
      ctx.drag = { kind: 'placeBone', originRoot: { x: p.x, y: p.y }, current: null };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Transform-gizmo handles (translate arrows / rotate ring).
    if (target instanceof SVGElement && target.dataset.gizmoAxis) {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const t = poseTime();
      const setup = state.editorMode === 'setup';
      const axisAttr = target.dataset.gizmoAxis;
      ctx.drag = {
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
        axis: axisAttr === 'x' || axisAttr === 'y' ? axisAttr : null,
        toggleOnClick: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (target instanceof SVGElement && target.dataset.role === 'gizmo-ring') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const setup = state.editorMode === 'setup';
      const pivot = effectivePivot(part, poseTime());
      ctx.drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({
          part: sp,
          start: setup ? sp.rest.rotate : channelValue(sp, 'rotate', state.currentTime),
        })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Bone tip: re-aim/re-length the bone (Setup).
    if (target instanceof SVGElement && target.dataset.role === 'bone-tip') {
      const part = selectedPart();
      if (!part) return;
      ctx.drag = { kind: 'boneTip', part, startClient: { x: ev.clientX, y: ev.clientY }, active: false };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    if (ev.button === 1) {
      ev.preventDefault(); // no middle-click autoscroll
      ctx.drag = { kind: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, startRect: { ...ctx.viewRect! } };
      ctx.svg!.style.cursor = 'grabbing';
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (ev.button !== 0) return;

    // Scale handle (Setup mode)
    if (target instanceof SVGElement && target.dataset.handle) {
      const part = selectedPart();
      const g = part ? ctx.partGroups.get(part.id) : null;
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
      ctx.drag = {
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
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Skew handle (Setup mode, rotate handle set): shear along the box edge with the
    // opposite edge pinned — Inkscape's rotate-mode side handles.
    if (target instanceof SVGElement && target.dataset.skewSide) {
      const part = selectedPart();
      const g = part ? ctx.partGroups.get(part.id) : null;
      if (!part || !g) return;
      const box = g.getBBox();
      const pad = handleSize() * 0.6;
      const x0 = box.x - pad, y0 = box.y - pad;
      const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const spots: Record<string, { g: { x: number; y: number }; a: { x: number; y: number } }> = {
        n: { g: { x: cx, y: y0 }, a: { x: cx, y: y1 } },
        s: { g: { x: cx, y: y1 }, a: { x: cx, y: y0 } },
        e: { g: { x: x1, y: cy }, a: { x: x0, y: cy } },
        w: { g: { x: x0, y: cy }, a: { x: x1, y: cy } },
      };
      const side = target.dataset.skewSide as 'n' | 'e' | 's' | 'w';
      const spot = spots[side];
      const t = poseTime();
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      ctx.drag = {
        kind: 'skew',
        part,
        side,
        startTanKx: Math.tan((part.rest.kx * Math.PI) / 180),
        startTanKy: Math.tan((part.rest.ky * Math.PI) / 180),
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainMatOf(part, t))),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Rotate handle (Setup mode): spin the rest pose around the pivot.
    if (target instanceof SVGElement && target.dataset.role === 'rotate-handle') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const pivot = effectivePivot(part, poseTime());
      ctx.drag = {
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
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    if (target instanceof SVGElement && target.dataset.role === 'node') {
      const part = selectedPart();
      if (!part) return;
      const pathId = target.dataset.pathId!;
      const cmdIndex = Number(target.dataset.cmdIndex);
      const field = target.dataset.field as 'x' | 'x1' | 'x2';
      if (field === 'x') {
        // Endpoint selection: Shift toggles membership; a node already in the
        // selection keeps the group (so dragging moves them all); plain click solos.
        const key = nodeKey(pathId, cmdIndex);
        if (ev.shiftKey) {
          if (ctx.selectedNodes.has(key)) ctx.selectedNodes.delete(key);
          else ctx.selectedNodes.add(key);
        } else if (!ctx.selectedNodes.has(key)) {
          ctx.selectedNodes.clear();
          ctx.selectedNodes.add(key);
        }
        ctx.selectedNode = ctx.selectedNodes.has(key) ? { pathId, cmdIndex } : null;
      }
      const path = part.paths.find((p) => p.id === pathId);
      const nodeDrag: DragState = {
        kind: 'node',
        part,
        pathId,
        cmdIndex,
        field,
        mirror:
          field === 'x' || !path
            ? null
            : mirrorInfoFor(parsePath(path.d), cmdIndex, field, path.nodeTypes ?? null),
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      if (ev.altKey || ev.ctrlKey) {
        checkpoint();
        editNodeStructure(nodeDrag, ev.altKey ? 'insert' : 'delete');
        return;
      }
      ctx.drag = nodeDrag;
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      renderOverlay(); // show the new node selection immediately
      return;
    }

    const pivotEl = (target as Element).closest('[data-role="pivot"]');
    if (pivotEl) {
      const part = selectedPart();
      if (!part) return;
      ctx.drag = {
        kind: 'pivot',
        part,
        startPivot: { ...part.pivot },
        startTranslate: ownTranslateOf(part, poseTime()),
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Node mode owns all remaining clicks: near the edited path's outline they BEND
    // that segment (lines grow handles automatically); everywhere else — blank space
    // OR artwork, faded parts are click-through anyway — they rubber-band nodes.
    // Canvas clicks never switch parts here; use Layers or Escape to leave.
    if (state.mode === 'nodes' && state.editorMode === 'setup' && selectedPart()) {
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
        const hit = segmentHit(parsePath(path.d), local, handleSize() * 1.8);
        if (hit && (!bestBend || hit.d < bestBend.d)) {
          bestBend = { path, cmdIndex: hit.cmdIndex, t: hit.t, d: hit.d };
        }
      }
      if (bestBend) {
        ctx.drag = {
          kind: 'bendSegment', part, pathId: bestBend.path.id,
          cmdIndex: bestBend.cmdIndex, t: bestBend.t,
          startClient: { x: ev.clientX, y: ev.clientY }, active: false,
        };
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
        return;
      }
      const rect = document.createElement('div');
      rect.className = 'node-marquee';
      ctx.svg!.parentElement?.appendChild(rect);
      ctx.drag = {
        kind: 'nodeMarquee',
        startClient: { x: ev.clientX, y: ev.clientY },
        rect,
        additive: ev.shiftKey,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const partEl = (target as Element).closest('[data-part-id]') as SVGGElement | null;
    if (partEl) {
      let part = doc.parts.find((p) => p.id === partEl.dataset.partId) ?? null;
      // Group-aware selection: clicking artwork inside a closed group selects the
      // group (double-click opens it). Context-aware exception: a part that is
      // ALREADY selected (e.g. picked in the Layers tree) is manipulated directly —
      // never hijacked back to its group.
      if (part && state.mode === 'rig' && !state.selectedPartIds.includes(part.id)) {
        const closed = ancestorChain(part).find(
          (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
        );
        if (closed) part = closed;
      }
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
      if (part && state.mode === 'rig' && !part.skin) {
        const p = pointerInRoot(ev);
        const t = poseTime();
        const setup = state.editorMode === 'setup';
        // Which manipulation does a body drag perform?
        //   select tool — Setup moves the part, Animate rotates (Shift moves);
        //   translate/rotate tools force that manipulation in both modes;
        //   ik tool solves the ancestor chain toward the pointer.
        const action: 'translate' | 'rotate' | 'ik' =
          state.tool === 'select'
            ? (setup || ev.shiftKey ? 'translate' : 'rotate')
            : state.tool;

        if (action === 'ik') {
          const ancestors = ancestorChain(part); // outermost first
          const p1 = ancestors[ancestors.length - 1] ?? null;
          const p2 = ancestors[ancestors.length - 2] ?? null;
          if (p1) {
            const grabLocal = applyMat(
              invertMat(matrixOfTransform(fullPoseTransform(part, t))), p.x, p.y,
            );
            ctx.drag = {
              kind: 'ik', p1, p2, grabbed: part,
              grabLocal: { x: grabLocal.x, y: grabLocal.y },
              startClient: { x: ev.clientX, y: ev.clientY },
              active: false,
            };
            try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
            notify();
            return;
          }
          // No ancestors: fall through to a plain rotate below.
        }

        if (action === 'translate') {
          ctx.drag = {
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
            axis: null,
            toggleOnClick:
              state.tool === 'select' && setup && wasPrimary && !ev.shiftKey,
          };
        } else {
          const pivot = effectivePivot(part, t);
          ctx.drag = {
            kind: 'rotate',
            targets: selectedParts().map((sp) => ({
              part: sp,
              start: setup
                ? sp.rest.rotate
                : channelValue(sp, 'rotate', state.currentTime),
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
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }


    // Blank canvas: clear the selection, close entered groups, leave any "entered"
    // path. No drag follows a blank click, so repaint the overlay here — notify()
    // only rebuilds the side panels, and the stale selection box would linger.
    state.selectedPathId = null;
    ctx.enteredGroups.clear();
    selectPart(null);
    notify();
    renderOverlay();
  });

  ctx.svg.addEventListener('pointermove', (ev) => {
    if (!ctx.drag) return;

    if (ctx.drag.kind === 'pan') {
      if (!ctx.svg || !ctx.viewRect) return;
      const ctm = ctx.svg.getScreenCTM();
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
      ctx.viewRect.x = ctx.drag.startRect.x - (ev.clientX - ctx.drag.startClient.x) / scale;
      ctx.viewRect.y = ctx.drag.startRect.y - (ev.clientY - ctx.drag.startClient.y) / scale;
      applyViewRect();
      return;
    }
    if (ctx.drag.kind === 'placeBone') {
      const p = pointerInRoot(ev);
      ctx.drag.current = { x: p.x, y: p.y };
      renderOverlay(); // live bone preview
      return;
    }
    if (ctx.drag.kind === 'nodeMarquee') {
      const host = ctx.svg!.parentElement!.getBoundingClientRect();
      const x0 = Math.min(ctx.drag.startClient.x, ev.clientX);
      const y0 = Math.min(ctx.drag.startClient.y, ev.clientY);
      ctx.drag.rect.style.left = `${x0 - host.left}px`;
      ctx.drag.rect.style.top = `${y0 - host.top}px`;
      ctx.drag.rect.style.width = `${Math.abs(ev.clientX - ctx.drag.startClient.x)}px`;
      ctx.drag.rect.style.height = `${Math.abs(ev.clientY - ctx.drag.startClient.y)}px`;
      return;
    }

    if (!activateDrag(ctx.drag, ev)) return;
    const setup = state.editorMode === 'setup';

    if (ctx.drag.kind === 'rotate') {
      const p = pointerInRoot(ev);
      const angle = Math.atan2(p.y - ctx.drag.pivotY, p.x - ctx.drag.pivotX);
      const deltaDeg = ((angle - ctx.drag.startAngle) * 180) / Math.PI;
      ctx.drag.snapped = ev.ctrlKey;
      ctx.drag.current = { x: p.x, y: p.y };
      for (const { part, start } of ctx.drag.targets) {
        let value = start + deltaDeg;
        if (ev.ctrlKey) value = Math.round(value / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
        value = round1(value);
        if (part.id === ctx.drag.targets[0]?.part.id) ctx.drag.currentDelta = round1(value - start);
        if (setup) part.rest.rotate = value;
        else setKeyframe(part.id, 'rotate', value);
      }
      renderPose();
      notifyTimelineOnly();
    } else if (ctx.drag.kind === 'translate') {
      const p = pointerInRoot(ev);
      let dx = p.x - ctx.drag.startX;
      let dy = p.y - ctx.drag.startY;
      // Axis lock (gizmo arrow or Ctrl) applies to the delta BEFORE snapping; the FREE
      // axis is the one still moving, so snapping can only correct along it — the lock
      // is never broken.
      let freeAxis: SnapAxis = null;
      if (ctx.drag.axis === 'x') { dy = 0; freeAxis = 'x'; }
      else if (ctx.drag.axis === 'y') { dx = 0; freeAxis = 'y'; }
      else if (ev.ctrlKey) {
        // Ctrl constrains a free move to the dominant axis (Inkscape-style).
        if (Math.abs(dx) >= Math.abs(dy)) { dy = 0; freeAxis = 'x'; }
        else { dx = 0; freeAxis = 'y'; }
      }
      ctx.snapMarker = null;
      const primary = selectedPart();
      if (snappingActive() && primary) {
        if (!ctx.drag.snapFeatures) ctx.drag.snapFeatures = translateSnapFeatures(primary, poseTime());
        const snapped = snapDelta(
          ctx.drag.snapFeatures.moving, ctx.drag.snapFeatures.targets,
          { dx, dy }, snapThreshold(), freeAxis,
        );
        dx = snapped.dx;
        dy = snapped.dy;
        if (snapped.target) ctx.snapMarker = rootToUser(snapped.target);
      }
      // The constrained point, so the dashed line + Δ readout show the applied move.
      ctx.drag.current = { x: ctx.drag.startX + dx, y: ctx.drag.startY + dy };
      for (const { part, startTx, startTy, invLinear } of ctx.drag.targets) {
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
    } else if (ctx.drag.kind === 'scale') {
      const d = ctx.drag;
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
    } else if (ctx.drag.kind === 'skew') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampTan = (v: number) => Math.min(11.4, Math.max(-11.4, v)); // ±≈85°
      if (d.side === 'n' || d.side === 's') {
        // Horizontal shear: displacement along x relative to the pinned edge's height.
        const h = d.grabLocal.y - d.anchorLocal.y;
        if (Math.abs(h) > 1e-6) {
          const tan = clampTan(d.startTanKx + (local.x - d.grabLocal.x) / h);
          d.part.rest.kx = round1((Math.atan(tan) * 180) / Math.PI);
        }
      } else {
        const w = d.grabLocal.x - d.anchorLocal.x;
        if (Math.abs(w) > 1e-6) {
          const tan = clampTan(d.startTanKy + (local.y - d.grabLocal.y) / w);
          d.part.rest.ky = round1((Math.atan(tan) * 180) / Math.PI);
        }
      }
      // Pin the opposite edge midpoint, same recipe as the scale drag.
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
    } else if (ctx.drag.kind === 'ik') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      const t = poseTime();
      // Current geometry (recomputed every move — the solve is incremental).
      const e = applyMat(matrixOfTransform(fullPoseTransform(d.grabbed, t)), d.grabLocal.x, d.grabLocal.y);
      const bPiv = effectivePivot(d.p1, t);
      const applyDelta = (part: RigPart, delta: number) => {
        if (Math.abs(delta) < 1e-4) return;
        if (setup) part.rest.rotate = round1(part.rest.rotate + delta);
        else {
          setKeyframe(part.id, 'rotate', round1(channelValue(part, 'rotate', state.currentTime) + delta));
        }
      };
      if (d.p2) {
        const aPiv = effectivePivot(d.p2, t);
        const { delta1, delta2 } = solveTwoBone(aPiv, bPiv, e, { x: p.x, y: p.y });
        applyDelta(d.p2, delta1);
        applyDelta(d.p1, delta2);
      } else {
        applyDelta(d.p1, solveAim(bPiv, e, { x: p.x, y: p.y }));
      }
      renderPose();
      notifyTimelineOnly();
    } else if (ctx.drag.kind === 'boneTip') {
      const p = pointerInRoot(ev);
      const part = ctx.drag.part;
      const local = applyMat(
        invertMat(matrixOfTransform(fullPoseTransform(part, poseTime()))), p.x, p.y,
      );
      part.boneTip = { x: round1(local.x), y: round1(local.y) };
      renderPose();
    } else if (ctx.drag.kind === 'pivot') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      const part = d.part;
      const t = poseTime();
      // Snap the target joint position (root space) onto the part's own nodes or other
      // joints. The pivot-compensation solve below then keeps the artwork fixed, so the
      // joint lands on the target WITHOUT moving the art.
      let sx = p.x, sy = p.y;
      ctx.snapMarker = null;
      if (snappingActive()) {
        const match = snapPoint({ x: sx, y: sy }, pivotSnapCandidates(part, t), snapThreshold());
        if (match) {
          sx = match.point.x;
          sy = match.point.y;
          ctx.snapMarker = rootToUser(match.point);
        }
      }
      // Un-apply the ancestors' motion so we work in the part's parent-chain frame
      // (pivot + own translate live there: effectivePivot = chain · (pivot + ot)).
      const local = applyMat(invertMat(chainMatOf(part, t)), sx, sy);
      // Moving the joint must never move the artwork. The pivot anchors the part's
      // own rotation AND the innermost rest scale/skew, so re-anchoring it shifts
      // the rendered art unless the rest translation absorbs the difference. Solve
      // both together: find pivot pv with pv + translate(pv) = pointer, where
      // translate(pv) is the own-translate that keeps the drag-start own matrix
      // intact. translate(pv) is affine in pv, so one Jacobian step (from finite
      // differences) solves it exactly.
      const rot = channelValue(part, 'rotate', t);
      const ownMat = (pv: { x: number; y: number }): Mat =>
        matrixOfTransform(
          [`rotate(${rot},${pv.x},${pv.y})`, part.transform, innerLocalTransform(part, pv)]
            .filter(Boolean)
            .join(' '),
        );
      const m0 = ownMat(d.startPivot);
      const translateFor = (pv: { x: number; y: number }) => {
        // m0 · ownMat(pv)⁻¹ is a pure translation (identical linear parts).
        const dm = multiply(m0, invertMat(ownMat(pv)));
        return { x: d.startTranslate.x + dm.e, y: d.startTranslate.y + dm.f };
      };
      const F = (pv: { x: number; y: number }) => {
        const tn = translateFor(pv);
        return { x: pv.x + tn.x, y: pv.y + tn.y };
      };
      const seed = { x: local.x - d.startTranslate.x, y: local.y - d.startTranslate.y };
      const f0 = F(seed);
      const fx = F({ x: seed.x + 1, y: seed.y });
      const fy = F({ x: seed.x, y: seed.y + 1 });
      const ja = fx.x - f0.x, jb = fx.y - f0.y, jc = fy.x - f0.x, jd = fy.y - f0.y;
      const det = ja * jd - jb * jc;
      let pv = seed;
      if (Math.abs(det) > 1e-9) {
        const rx = local.x - f0.x, ry = local.y - f0.y;
        pv = {
          x: seed.x + (jd * rx - jc * ry) / det,
          y: seed.y + (ja * ry - jb * rx) / det,
        };
      }
      part.pivot = { x: round1(pv.x), y: round1(pv.y) };
      // Recompute the compensation for the ROUNDED pivot so the artwork stays put
      // exactly (finer rounding here — 0.1 on the translation would visibly wiggle
      // the art while the pivot slides).
      const tn = translateFor(part.pivot);
      part.rest.tx = round3(tn.x);
      part.rest.ty = round3(tn.y);
      renderPose();
    } else if (ctx.drag.kind === 'bendSegment') {
      const d = ctx.drag;
      const path = d.part.paths.find((p) => p.id === d.pathId);
      if (!path) return;
      const cmds = parsePath(path.d);
      const p0 = segmentStart(cmds, d.cmdIndex);
      let c = cmds[d.cmdIndex];
      if (!p0 || !c || (c.cmd !== 'L' && c.cmd !== 'C' && c.cmd !== 'Z')) return;
      if (c.cmd === 'Z') {
        // The implicit closing line becomes a REAL segment: an explicit cubic back
        // to the subpath start, in front of the Z (which then closes a zero-length
        // gap). This is how a handle-less closing edge grows handles.
        const s0 = subpathStart(cmds, d.cmdIndex);
        if (!s0) return;
        const closing: PathCmd = {
          cmd: 'C',
          x1: p0.x + (s0.x - p0.x) / 3, y1: p0.y + (s0.y - p0.y) / 3,
          x2: p0.x + (2 * (s0.x - p0.x)) / 3, y2: p0.y + (2 * (s0.y - p0.y)) / 3,
          x: s0.x, y: s0.y,
        };
        cmds.splice(d.cmdIndex, 0, closing);
        if (path.nodeTypes) {
          // The new node duplicates the subpath start; give it a corner flag at the
          // exact position so every later node keeps its type.
          const types = ensureNodeTypes(path); // pre-splice length — recompute below
          const ni = nodeIndexOf(cmds, d.cmdIndex);
          path.nodeTypes = types.slice(0, ni) + 'c' + types.slice(ni);
        }
        ctx.selectedNodes.clear(); // command indexes shifted
        ctx.selectedNode = null;
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
      path.d = serializePath(cmds);
      ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
      renderOverlay();
    } else if (ctx.drag.kind === 'node') {
      moveNode(ctx.drag, ev);
    }
  });

  const end = () => {
    if (ctx.drag) {
      if (ctx.drag.kind === 'pan') ctx.svg!.style.cursor = '';
      if (ctx.drag.kind === 'placeBone') {
        // Release finishes the bone: origin = press point, tip = release point.
        const origin = ctx.drag.originRoot;
        const tipRoot = ctx.drag.current ?? origin;
        const parent = selectedPart();
        const t = poseTime();
        const inv = parent
          ? invertMat(matrixOfTransform(fullPoseTransform(parent, t)))
          : null;
        const toLocal = (pt: { x: number; y: number }) =>
          inv ? applyMat(inv, pt.x, pt.y) : pt;
        const pivotL = toLocal(origin);
        let tipL = toLocal(tipRoot);
        if (Math.hypot(tipL.x - pivotL.x, tipL.y - pivotL.y) < 2) {
          // A bare click still yields a usable bone: short and pointing right.
          tipL = { x: pivotL.x + (state.doc?.viewBox.w ?? 200) * 0.06, y: pivotL.y };
        }
        checkpoint();
        const bone = addNullPart(
          'bone', { x: round1(pivotL.x), y: round1(pivotL.y) }, parent?.id ?? null,
        );
        bone.boneTip = { x: round1(tipL.x), y: round1(tipL.y) };
        registerPart(bone);
        cancelBonePlacement();
        selectPart(bone.id);
      }
      if (ctx.drag.kind === 'nodeMarquee') {
        // Select every node handle whose center sits inside the rubber band.
        const r = ctx.drag.rect.getBoundingClientRect();
        ctx.drag.rect.remove();
        if (!ctx.drag.additive) ctx.selectedNodes.clear();
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
      }
      // A motionless click on the already-selected part cycles scale ↔ rotate handles.
      if (ctx.drag.kind === 'translate' && !ctx.drag.active && ctx.drag.toggleOnClick) {
        ctx.handleMode = ctx.handleMode === 'scale' ? 'rotate' : 'scale';
      }
      ctx.drag = null;
      ctx.snapMarker = null; // drop any snap marker before the final repaint
      notify();
      renderPose(); // clears gizmos + snap marker
    }
  };
  ctx.svg.addEventListener('pointerup', end);
  ctx.svg.addEventListener('pointercancel', end);
}

/**
 * The opposite control handle of the node a control point attaches to, when the two
 * handles are currently collinear-and-opposed (a smooth node) — dragging one then
 * mirrors the other's direction, preserving its length. Alt breaks the pairing.
 */
function mirrorInfoFor(
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

function moveNode(d: Extract<DragState, { kind: 'node' }>, ev: PointerEvent): void {
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
  if (d.mirror && !ev.altKey && d.field !== 'x') {
    const node = d.field === 'x1'
      ? (cmds[d.cmdIndex - 1] as { x: number; y: number })
      : { x: (c as { x: number }).x, y: (c as { y: number }).y };
    const dx = local.x - node.x;
    const dy = local.y - node.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      const partner = cmds[d.mirror.cmdIndex] as PathCmd & Record<string, number>;
      if (partner && partner.cmd === 'C') {
        const plen = d.mirror.matchLen ? len : d.mirror.len;
        const px = node.x - (dx / len) * plen;
        const py = node.y - (dy / len) * plen;
        if (d.mirror.field === 'x1') { partner.x1 = px; partner.y1 = py; }
        else { partner.x2 = px; partner.y2 = py; }
      }
    }
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

function editNodeStructure(d: Extract<DragState, { kind: 'node' }>, op: 'insert' | 'delete'): void {
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
  path.d = serializePath(cmds);
  const el = ctx.svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}

// ---- Snapping ----

/**
 * Candidate points (root space) a pivot drag snaps to: the part's own path nodes and
 * every OTHER part's live joint. Landing a joint exactly on an artwork node or another
 * joint is the whole point of snapping for rigging.
 */
function pivotSnapCandidates(part: RigPart, t: number | null): SnapCandidate[] {
  const doc = state.doc;
  if (!doc) return [];
  const cands: SnapCandidate[] = [];
  for (const other of doc.parts) {
    if (other.id === part.id) continue;
    const ep = effectivePivot(other, t);
    cands.push({ x: ep.x, y: ep.y, kind: 'pivot' });
  }
  const groupMat = matrixOfTransform(groupTransformOf(part, t));
  for (const path of part.paths) {
    const pm = multiply(groupMat, matrixOfTransform(path.transform));
    for (const c of parsePath(path.d)) {
      if (c.cmd === 'Z') continue;
      const r = applyMat(pm, (c as { x: number }).x, (c as { y: number }).y);
      cands.push({ x: r.x, y: r.y, kind: 'node' });
    }
  }
  return cands;
}

/** Moving + target feature points (root space) for a part-translate snap. */
function translateSnapFeatures(
  part: RigPart, t: number | null,
): { moving: SnapCandidate[]; targets: SnapCandidate[] } {
  const doc = state.doc!;
  const selected = new Set(state.selectedPartIds);
  const featuresOf = (p: RigPart): SnapCandidate[] => {
    const out: SnapCandidate[] = [];
    const ep = effectivePivot(p, t);
    out.push({ x: ep.x, y: ep.y, kind: 'pivot' });
    const box = p.paths.length > 0 ? partRootBoxes([p.id]).get(p.id) : undefined;
    if (box) out.push(...boxFeaturePoints(box));
    return out;
  };
  const moving = featuresOf(part);
  const targets: SnapCandidate[] = [];
  for (const other of doc.parts) {
    if (selected.has(other.id)) continue; // never snap the moving selection to itself
    targets.push(...featuresOf(other));
  }
  return { moving, targets };
}

/**
 * Node-snap candidates in the DRAGGED path's raw coordinate space (so a same-path
 * target snaps to an EXACT stored coordinate). Every endpoint of the part's editable
 * paths except the ones being dragged; other paths are mapped in through their holder.
 */
function nodeSnapCandidates(
  part: RigPart, draggedPath: RigPath, scoped: RigPath[], moving: Set<string>,
): { candidates: SnapCandidate[]; threshold: number } {
  const draggedHolder = pathHolderMat(part, draggedPath);
  const draggedInv = invertMat(draggedHolder);
  const candidates: SnapCandidate[] = [];
  for (const path of scoped) {
    const toDragged = path.id === draggedPath.id
      ? null
      : multiply(draggedInv, pathHolderMat(part, path));
    const cmds = parsePath(path.d);
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      if (moving.has(nodeKey(path.id, i))) return; // exclude the dragged selection
      const raw = { x: (c as { x: number }).x, y: (c as { y: number }).y };
      const pt = toDragged ? applyMat(toDragged, raw.x, raw.y) : raw;
      candidates.push({ x: pt.x, y: pt.y, kind: 'node' });
    });
  }
  // Threshold: ~8 screen px carried through the path's full path→screen scale.
  const pathUserScale = Math.hypot(draggedHolder.a, draggedHolder.b) || 1;
  const threshold = 8 / (screenScaleOf() * pathUserScale);
  return { candidates, threshold };
}

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}
