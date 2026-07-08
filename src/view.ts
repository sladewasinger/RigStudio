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
  selectPart, ancestorChain, activeClip, channelValue, sampleChannel, addNullPart,
  partById,
} from './model';
import { parsePath, serializePath, insertNodeAfter, pathToCubics, PathCmd } from './paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from './transforms';
import { solveAim, solveTwoBone } from './ik';
import { skinWeights, Seg } from './skin';
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

// Groups the user has double-clicked into (clicks inside them select parts directly).
const enteredGroups = new Set<string>();

/** Escape/blank-click hook: close all entered groups. */
export function clearGroupEntry(): void {
  enteredGroups.clear();
}

/**
 * The artwork part/path under the pointer, looking THROUGH overlay widgets (pivot
 * grab circles, handles, gizmos). document.elementsFromPoint returns the full stack
 * top-to-bottom; the first hit inside rootGroup is the real artwork.
 */
function artworkUnderPointer(
  ev: MouseEvent,
): { part: RigPart; pathEl: SVGElement | null } | null {
  const doc = state.doc;
  if (!doc || !rootGroup) return null;
  for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
    if (!rootGroup.contains(el)) continue;
    const partEl = (el as Element).closest('[data-part-id]') as SVGGElement | null;
    const part = doc.parts.find((p) => p.id === partEl?.dataset.partId);
    if (part) {
      const pathEl = (el as SVGElement).dataset?.pathId ? (el as SVGElement) : null;
      return { part, pathEl };
    }
  }
  return null;
}

/**
 * Which parts are "in focus" while drilling: node editing focuses the edited part;
 * entered groups focus their subtrees. Everything else dims and stops catching
 * clicks (renderPose applies the class), so drags over faded artwork rubber-band
 * nodes instead of selecting parts, and a click on faded artwork falls through to
 * blank canvas — which exits the focus, Inkscape-style. Null = nothing dimmed.
 */
function focusContext(): Set<string> | null {
  const part = selectedPart();
  if (state.mode === 'nodes' && state.editorMode === 'setup' && part) {
    return new Set([part.id]);
  }
  if (enteredGroups.size > 0) {
    const doc = state.doc!;
    const focus = new Set<string>();
    for (const p of doc.parts) {
      if (enteredGroups.has(p.id) || ancestorChain(p).some((a) => enteredGroups.has(a.id))) {
        focus.add(p.id);
      }
    }
    return focus;
  }
  return null;
}

/**
 * Open every group above a part (Layers-panel selection does this so a part picked
 * in the tree is immediately draggable on canvas instead of re-selecting its group).
 */
export function enterGroupsFor(partId: string): void {
  const part = partById(partId);
  if (!part) return;
  for (const a of ancestorChain(part)) {
    if (a.kind === 'group') enteredGroups.add(a.id);
  }
}

// Node-editing selection: every selected endpoint (multi-select), plus the primary
// (last-clicked) node the inspector reports on. Keys are `${pathId}|${cmdIndex}`.
const selectedNodes = new Set<string>();
let selectedNode: { pathId: string; cmdIndex: number } | null = null;

function nodeKey(pathId: string, cmdIndex: number): string {
  return `${pathId}|${cmdIndex}`;
}

function parseNodeKey(key: string): { pathId: string; cmdIndex: number } {
  const i = key.lastIndexOf('|');
  return { pathId: key.slice(0, i), cmdIndex: Number(key.slice(i + 1)) };
}

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

/** Register a canvas group for a part created after buildCanvas (bones, groups). */
export function registerPart(part: RigPart): void {
  if (!rootGroup || partGroups.has(part.id)) return;
  const g = document.createElementNS(SVG_NS, 'g');
  g.dataset.partId = part.id;
  rootGroup.appendChild(g);
  partGroups.set(part.id, g);
}

/** Drop a removed part's canvas group (ungroup/dissolve). */
export function unregisterPart(id: string): void {
  partGroups.get(id)?.remove();
  partGroups.delete(id);
}

// ---- Vector-editing operations (Setup mode) ----

/**
 * Flip the selected art parts in place — around each part's own rendered bbox center,
 * stored as negated rest scale (axes follow the artwork like all rest scaling), with
 * the bbox center pinned by rest-translation compensation. The joint doesn't move.
 */
export function flipSelected(axis: 'h' | 'v'): boolean {
  if (state.editorMode !== 'setup') return false;
  const parts = selectedParts().filter((p) => p.paths.length > 0 && partGroups.has(p.id));
  if (parts.length === 0) return false;
  const t = poseTime();
  for (const part of parts) {
    const g = partGroups.get(part.id)!;
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

/** Rendered root-space AABBs of the given parts (for align/distribute). */
export function partRootBoxes(ids: string[]): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  const doc = state.doc;
  if (!doc) return out;
  const t = poseTime();
  for (const id of ids) {
    const part = doc.parts.find((p) => p.id === id);
    const g = part ? partGroups.get(id) : null;
    if (!part || !g || part.paths.length === 0) continue;
    const box = g.getBBox();
    const m = matrixOfTransform(groupTransformOf(part, t));
    const corners = [
      applyMat(m, box.x, box.y),
      applyMat(m, box.x + box.width, box.y),
      applyMat(m, box.x + box.width, box.y + box.height),
      applyMat(m, box.x, box.y + box.height),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    out.set(id, { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 });
  }
  return out;
}

/**
 * Nudge the selected parts by a SCREEN-pixel delta (arrow keys), converted through
 * the current zoom and each part's parent chain — the keyboard twin of a translate
 * drag (Setup writes rest, Animate keys tx/ty at the playhead). Sub-0.1 steps at
 * high zoom survive thanks to finer rounding. Returns whether anything moved.
 */
export function nudgeSelectedParts(dxPx: number, dyPx: number): boolean {
  if (!svg) return false;
  const parts = selectedParts().filter((p) => !p.skin);
  if (parts.length === 0) return false;
  const ctm = svg.getScreenCTM();
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
      const el = svg?.querySelector<SVGPathElement>(`[data-path-id="${path.id}"]`);
      if (el) applyPathAttrs(el, path);
    }
    part.pivot = effectivePivot(part, null);
    part.transform = '';
    part.rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 };
    part.parentId = null;
    part.skin = { bones: skinBones.map((b) => ({ ...b, bindSeg: { p: { ...b.bindSeg.p }, q: { ...b.bindSeg.q } } })) };
    skinCache.delete(part.id);
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
    skinCache.delete(part.id);
  }
  renderPose();
  return true;
}

// ---- Bone placement ----

let placingBone = false;

/** Arm click-to-place: the next canvas click drops a bone (parented to the selection). */
export function startBonePlacement(): void {
  placingBone = true;
  if (svg) svg.style.cursor = 'crosshair';
}

/** Returns whether placement was active (Escape handling). */
export function cancelBonePlacement(): boolean {
  const was = placingBone;
  placingBone = false;
  if (svg) svg.style.cursor = '';
  return was;
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
function localPivotOf(part: RigPart, pivot = part.pivot): { x: number; y: number } {
  return applyMat(invertMat(matrixOfTransform(part.transform)), pivot.x, pivot.y);
}

/**
 * Rest scale AND skew, applied innermost (after the baked transform) around the local
 * pivot: the artwork reshapes along its own axes and the joint stays exactly in place.
 * `pivot` overrides the stored pivot (pivot drags evaluate candidate positions).
 */
function innerLocalTransform(part: RigPart, pivot = part.pivot): string {
  const { sx, sy, kx, ky } = part.rest;
  if (sx === 1 && sy === 1 && kx === 0 && ky === 0) return '';
  const pl = localPivotOf(part, pivot);
  const ops = [`translate(${pl.x},${pl.y})`];
  if (sx !== 1 || sy !== 1) ops.push(`scale(${sx},${sy})`);
  if (kx !== 0) ops.push(`skewX(${kx})`);
  if (ky !== 0) ops.push(`skewY(${ky})`);
  ops.push(`translate(${-pl.x},${-pl.y})`);
  return ops.join(' ');
}

/** Ancestor poses composed with the part's own pose (bone hierarchy). */
function fullPoseTransform(part: RigPart, t: number | null): string {
  const pieces = ancestorChain(part).map((a) => ownPoseTransform(a, t));
  pieces.push(ownPoseTransform(part, t));
  return pieces.join(' ');
}

/** The complete transform string a part group renders with. */
function groupTransformOf(part: RigPart, t: number | null): string {
  return [fullPoseTransform(part, t), part.transform, innerLocalTransform(part)]
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

/** A bone's tip in root coordinates (follows the bone's own rotation), or null. */
function effectiveTip(part: RigPart, t: number | null): { x: number; y: number } | null {
  if (!part.boneTip) return null;
  return applyMat(
    matrixOfTransform(fullPoseTransform(part, t)), part.boneTip.x, part.boneTip.y,
  );
}

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !rootGroup) return;
  const t = poseTime();

  rootGroup.setAttribute('transform', rootPoseTransform(t));
  const focus = focusContext();
  for (const part of doc.parts) {
    const g = partGroups.get(part.id);
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

// ---- Linear-blend skinning ----

// Runtime cache: parsed rest geometry + per-point weights, invalidated when the
// rest path data changes (node edits) or the binding changes.
const skinCache = new Map<string, {
  sig: string;
  paths: { id: string; cmds: PathCmd[]; pts: { x: number; y: number }[][]; weights: number[][] }[];
}>();

function skinDataFor(part: RigPart): NonNullable<ReturnType<typeof skinCache.get>> {
  const sig =
    part.paths.map((p) => `${p.id}:${p.d.length}`).join('|') +
    '#' + (part.skin?.bones.map((b) => b.id).join(',') ?? '');
  const hit = skinCache.get(part.id);
  if (hit && hit.sig === sig) return hit;

  const segs: Seg[] = (part.skin?.bones ?? []).map((b) => b.bindSeg);
  const paths = part.paths.map((p) => {
    const cmds = pathToCubics(parsePath(p.d));
    // Every coordinate pair in order — endpoints and control points alike.
    const pts: { x: number; y: number }[][] = cmds.map((c) => {
      if (c.cmd === 'C') {
        return [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x, y: c.y }];
      }
      if (c.cmd === 'Z') return [];
      return [{ x: (c as { x: number }).x, y: (c as { y: number }).y }];
    });
    const flat = pts.flat();
    const weights = skinWeights(flat, segs);
    return { id: p.id, cmds, pts, weights };
  });
  const entry = { sig, paths };
  skinCache.set(part.id, entry);
  return entry;
}

/** Per-frame linear-blend deformation: rewrite each path's d attribute. */
function renderSkinnedPart(part: RigPart, g: SVGGElement, t: number | null): void {
  const skin = part.skin;
  if (!skin) return;
  const data = skinDataFor(part);

  // Each bone's delta from its bind pose (identity at rest → rest geometry).
  const deltas: Mat[] = skin.bones.map((b) => {
    const bone = state.doc?.parts.find((p) => p.id === b.id);
    if (!bone) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return multiply(matrixOfTransform(fullPoseTransform(bone, t)), b.restWorldInv);
  });

  for (const pd of data.paths) {
    let k = 0;
    const out: PathCmd[] = pd.cmds.map((c, i) => {
      const mapped = pd.pts[i].map((pt) => {
        const w = pd.weights[k++];
        let x = 0, y = 0;
        for (let bi = 0; bi < deltas.length; bi++) {
          const m = deltas[bi];
          x += w[bi] * (m.a * pt.x + m.c * pt.y + m.e);
          y += w[bi] * (m.b * pt.x + m.d * pt.y + m.f);
        }
        return { x, y };
      });
      if (c.cmd === 'C') {
        return {
          cmd: 'C' as const,
          x1: mapped[0].x, y1: mapped[0].y,
          x2: mapped[1].x, y2: mapped[1].y,
          x: mapped[2].x, y: mapped[2].y,
        };
      }
      if (c.cmd === 'Z') return c;
      return { ...c, x: mapped[0].x, y: mapped[0].y } as PathCmd;
    });
    const el = g.querySelector(`[data-path-id="${pd.id}"]`);
    el?.setAttribute('d', serializePath(out));
  }
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
    overlay.appendChild(glyph);

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
      overlay.appendChild(wrap);
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
    const g = partGroups.get(part.id);
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
    overlay.appendChild(boxHolder);

    if (!primary) continue;

    if (setup && !part.skin) {
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
  renderToolGizmo(size, t, rootTransform);

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
    `<circle class="pivot-grab" cx="${px}" cy="${py}" r="${size * 1.6}" />` +
    `<circle class="pivot-ring" cx="${px}" cy="${py}" r="${size * 1.1}" />` +
    `<circle class="pivot-dot" cx="${px}" cy="${py}" r="${size * 0.3}" />` +
    `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
    `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
  overlay.appendChild(cross);
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
  if (!overlay || state.mode !== 'rig') return;
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
  overlay.appendChild(g);
}

/** Rotation arc + angle readout, translation deltas, or scale % while a drag is live. */
function renderDragGizmo(holder: SVGGElement, size: number): void {
  if (!drag || drag.kind === 'pan' || drag.kind === 'placeBone' || drag.kind === 'nodeMarquee') {
    // Bone placement previews the segment being drawn.
    if (drag?.kind === 'placeBone' && drag.current) {
      const ghost = document.createElementNS(SVG_NS, 'g');
      ghost.setAttribute('class', 'null-glyph bone placing');
      ghost.innerHTML = boneKitePath(drag.originRoot, drag.current, size);
      holder.appendChild(ghost);
    }
    return;
  }
  if (!drag.active) return;

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
  // Prune stale node selections (path gone, or the path shrank under them).
  for (const key of [...selectedNodes]) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    if (!paths.some((p) => p.id === pathId && cmdIndex < parsePath(p.d).length)) {
      selectedNodes.delete(key);
    }
  }
  if (selectedNode && !selectedNodes.has(nodeKey(selectedNode.pathId, selectedNode.cmdIndex))) {
    selectedNode = null;
  }
  for (const path of paths) {
    const cmds = parsePath(path.d);
    const types = path.nodeTypes ?? '';
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
      const isSelected = selectedNodes.has(nodeKey(path.id, i));
      addHandle(
        holder, path.id, i, 'x',
        (c as { x: number }).x, (c as { y: number }).y,
        size * (isSelected ? 1.05 : 0.8), 'node', isSelected,
        types[nodeIdx], // persistent type tints the node
      );
    });
    overlay!.appendChild(holder);
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
      /** Gizmo axis constraint: deltas lock to root-space x or y. */
      axis: 'x' | 'y' | null;
      /** Click (no movement) on the already-primary part cycles scale↔rotate handles. */
      toggleOnClick: boolean;
    }
  | {
      kind: 'ik';
      /** Nearest ancestor (link 2, e.g. forearm) — rotated by delta2. */
      p1: RigPart;
      /** Second ancestor (link 1, e.g. upper arm) — rotated by delta1; null = aim. */
      p2: RigPart | null;
      /** Grab point in the clicked part's full-pose frame (rides the chain). */
      grabLocal: { x: number; y: number };
      grabbed: RigPart;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'boneTip'; part: RigPart; startClient: { x: number; y: number }; active: boolean }
  | {
      kind: 'placeBone';
      originRoot: { x: number; y: number };
      current: { x: number; y: number } | null;
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
  | {
      kind: 'skew';
      part: RigPart;
      side: 'n' | 'e' | 's' | 'w';
      startTanKx: number; startTanKy: number;
      startTx: number; startTy: number;
      grabLocal: { x: number; y: number };
      anchorLocal: { x: number; y: number };
      anchorRoot: { x: number; y: number };
      invStart: Mat;
      invChainLinear: Mat;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'pivot';
      part: RigPart;
      /** Pivot + own translate at drag start: compensation is solved absolutely from
       * these so per-move rounding never accumulates into artwork drift. */
      startPivot: { x: number; y: number };
      startTranslate: { x: number; y: number };
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'node'; part: RigPart; pathId: string; cmdIndex: number;
      field: 'x' | 'x1' | 'x2';
      /** Opposite handle to mirror while dragging a control point (smooth nodes). */
      mirror: { cmdIndex: number; field: 'x1' | 'x2'; len: number; matchLen: boolean } | null;
      startClient: { x: number; y: number }; active: boolean;
    }
  | {
      kind: 'nodeMarquee';
      startClient: { x: number; y: number };
      rect: HTMLDivElement;
      additive: boolean;
    }
  | {
      kind: 'bendSegment';
      part: RigPart;
      pathId: string;
      /** The L/C command forming the grabbed segment (bends between its two nodes). */
      cmdIndex: number;
      /** Curve parameter of the grab point, clamped away from the endpoints. */
      t: number;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'pan'; startClient: { x: number; y: number }; startRect: { x: number; y: number; w: number; h: number } };

let drag: DragState | null = null;

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

  // Double-click steps INTO things, SVG-editor style: group → part → path. Escape or
  // a blank click steps back out.
  svg.addEventListener('dblclick', (ev) => {
    // Resolve the ARTWORK under the cursor with elementsFromPoint, skipping overlay
    // widgets: the first click of a double-click selects a part and draws its pivot
    // grab circle — often right where the second click lands. The overlay must never
    // eat a drill-down.
    const hit = artworkUnderPointer(ev);
    if (!hit) return;
    const { part, pathEl } = hit;
    // First: open the outermost still-closed group and select the next level.
    const closed = ancestorChain(part).find(
      (a) => a.kind === 'group' && !enteredGroups.has(a.id),
    );
    if (closed) {
      enteredGroups.add(closed.id);
      const next = ancestorChain(part).find(
        (a) => a.kind === 'group' && !enteredGroups.has(a.id),
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

  svg.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element;
    const doc = state.doc;
    if (!doc) return;

    // Bone placement: press to set the origin (the joint), drag to aim, release to
    // set the tip — like drawing a bone in Rive/Blender.
    if (placingBone && ev.button === 0) {
      const p = pointerInRoot(ev);
      drag = { kind: 'placeBone', originRoot: { x: p.x, y: p.y }, current: null };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
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
        axis: axisAttr === 'x' || axisAttr === 'y' ? axisAttr : null,
        toggleOnClick: false,
      };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (target instanceof SVGElement && target.dataset.role === 'gizmo-ring') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const setup = state.editorMode === 'setup';
      const pivot = effectivePivot(part, poseTime());
      drag = {
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
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Bone tip: re-aim/re-length the bone (Setup).
    if (target instanceof SVGElement && target.dataset.role === 'bone-tip') {
      const part = selectedPart();
      if (!part) return;
      drag = { kind: 'boneTip', part, startClient: { x: ev.clientX, y: ev.clientY }, active: false };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

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

    // Skew handle (Setup mode, rotate handle set): shear along the box edge with the
    // opposite edge pinned — Inkscape's rotate-mode side handles.
    if (target instanceof SVGElement && target.dataset.skewSide) {
      const part = selectedPart();
      const g = part ? partGroups.get(part.id) : null;
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
      drag = {
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
      const pathId = target.dataset.pathId!;
      const cmdIndex = Number(target.dataset.cmdIndex);
      const field = target.dataset.field as 'x' | 'x1' | 'x2';
      if (field === 'x') {
        // Endpoint selection: Shift toggles membership; a node already in the
        // selection keeps the group (so dragging moves them all); plain click solos.
        const key = nodeKey(pathId, cmdIndex);
        if (ev.shiftKey) {
          if (selectedNodes.has(key)) selectedNodes.delete(key);
          else selectedNodes.add(key);
        } else if (!selectedNodes.has(key)) {
          selectedNodes.clear();
          selectedNodes.add(key);
        }
        selectedNode = selectedNodes.has(key) ? { pathId, cmdIndex } : null;
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
      drag = nodeDrag;
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      renderOverlay(); // show the new node selection immediately
      return;
    }

    const pivotEl = (target as Element).closest('[data-role="pivot"]');
    if (pivotEl) {
      const part = selectedPart();
      if (!part) return;
      drag = {
        kind: 'pivot',
        part,
        startPivot: { ...part.pivot },
        startTranslate: ownTranslateOf(part, poseTime()),
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
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
        drag = {
          kind: 'bendSegment', part, pathId: bestBend.path.id,
          cmdIndex: bestBend.cmdIndex, t: bestBend.t,
          startClient: { x: ev.clientX, y: ev.clientY }, active: false,
        };
        try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
        return;
      }
      const rect = document.createElement('div');
      rect.className = 'node-marquee';
      svg!.parentElement?.appendChild(rect);
      drag = {
        kind: 'nodeMarquee',
        startClient: { x: ev.clientX, y: ev.clientY },
        rect,
        additive: ev.shiftKey,
      };
      try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
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
          (a) => a.kind === 'group' && !enteredGroups.has(a.id),
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
            drag = {
              kind: 'ik', p1, p2, grabbed: part,
              grabLocal: { x: grabLocal.x, y: grabLocal.y },
              startClient: { x: ev.clientX, y: ev.clientY },
              active: false,
            };
            try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
            notify();
            return;
          }
          // No ancestors: fall through to a plain rotate below.
        }

        if (action === 'translate') {
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
            axis: null,
            toggleOnClick:
              state.tool === 'select' && setup && wasPrimary && !ev.shiftKey,
          };
        } else {
          const pivot = effectivePivot(part, t);
          drag = {
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
        try { svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }


    // Blank canvas: clear the selection, close entered groups, leave any "entered"
    // path. No drag follows a blank click, so repaint the overlay here — notify()
    // only rebuilds the side panels, and the stale selection box would linger.
    state.selectedPathId = null;
    enteredGroups.clear();
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
    if (drag.kind === 'placeBone') {
      const p = pointerInRoot(ev);
      drag.current = { x: p.x, y: p.y };
      renderOverlay(); // live bone preview
      return;
    }
    if (drag.kind === 'nodeMarquee') {
      const host = svg!.parentElement!.getBoundingClientRect();
      const x0 = Math.min(drag.startClient.x, ev.clientX);
      const y0 = Math.min(drag.startClient.y, ev.clientY);
      drag.rect.style.left = `${x0 - host.left}px`;
      drag.rect.style.top = `${y0 - host.top}px`;
      drag.rect.style.width = `${Math.abs(ev.clientX - drag.startClient.x)}px`;
      drag.rect.style.height = `${Math.abs(ev.clientY - drag.startClient.y)}px`;
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
      let dx = p.x - drag.startX;
      let dy = p.y - drag.startY;
      if (drag.axis === 'x') dy = 0;
      else if (drag.axis === 'y') dx = 0;
      else if (ev.ctrlKey) {
        // Ctrl constrains a free move to the dominant axis (Inkscape-style).
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      // The constrained point, so the dashed line + Δ readout show the applied move.
      drag.current = { x: drag.startX + dx, y: drag.startY + dy };
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
    } else if (drag.kind === 'skew') {
      const d = drag;
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
    } else if (drag.kind === 'ik') {
      const d = drag;
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
    } else if (drag.kind === 'boneTip') {
      const p = pointerInRoot(ev);
      const part = drag.part;
      const local = applyMat(
        invertMat(matrixOfTransform(fullPoseTransform(part, poseTime()))), p.x, p.y,
      );
      part.boneTip = { x: round1(local.x), y: round1(local.y) };
      renderPose();
    } else if (drag.kind === 'pivot') {
      const d = drag;
      const p = pointerInRoot(ev);
      const part = d.part;
      const t = poseTime();
      // Un-apply the ancestors' motion so we work in the part's parent-chain frame
      // (pivot + own translate live there: effectivePivot = chain · (pivot + ot)).
      const local = applyMat(invertMat(chainMatOf(part, t)), p.x, p.y);
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
    } else if (drag.kind === 'bendSegment') {
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
        selectedNodes.clear(); // command indexes shifted
        selectedNode = null;
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
      svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
      renderOverlay();
    } else if (drag.kind === 'node') {
      moveNode(drag, ev);
    }
  });

  const end = () => {
    if (drag) {
      if (drag.kind === 'pan') svg!.style.cursor = '';
      if (drag.kind === 'placeBone') {
        // Release finishes the bone: origin = press point, tip = release point.
        const origin = drag.originRoot;
        const tipRoot = drag.current ?? origin;
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
      if (drag.kind === 'nodeMarquee') {
        // Select every node handle whose center sits inside the rubber band.
        const r = drag.rect.getBoundingClientRect();
        drag.rect.remove();
        if (!drag.additive) selectedNodes.clear();
        const isClick = r.width < 3 && r.height < 3;
        if (!isClick && svg) {
          for (const h of svg.querySelectorAll<SVGCircleElement>('.node-handle')) {
            const hb = h.getBoundingClientRect();
            const cx = hb.left + hb.width / 2;
            const cy = hb.top + hb.height / 2;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              selectedNodes.add(nodeKey(h.dataset.pathId!, Number(h.dataset.cmdIndex)));
            }
          }
        }
        const last = [...selectedNodes].pop();
        selectedNode = last ? parseNodeKey(last) : null;
      }
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

/** The holder matrix a path's raw coordinates render through (root+group+path). */
function pathHolderMat(part: RigPart, path: RigPath): Mat {
  const g = partGroups.get(part.id);
  return matrixOfTransform([
    rootGroup?.getAttribute('transform') ?? '',
    g?.getAttribute('transform') ?? '',
    path.transform,
  ].filter(Boolean).join(' '));
}

/**
 * Pointer position in a path's raw-coordinate space, computed from the TRANSFORM
 * STRINGS (root pose + part chain + path transform) rather than a captured overlay
 * element — overlay rebuilds mid-drag would leave such an element detached, and a
 * detached element's screen matrix is garbage (nodes teleporting off-screen).
 * Going through the svg's own screen CTM keeps zoom/pan exact.
 */
function pointerInPathSpace(
  ev: PointerEvent, part: RigPart, path: RigPath,
): { x: number; y: number } {
  const m = svg!.getScreenCTM()!;
  const user = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
  return applyMat(invertMat(pathHolderMat(part, path)), user.x, user.y);
}

function moveNode(d: Extract<DragState, { kind: 'node' }>, ev: PointerEvent): void {
  const path = d.part.paths.find((p) => p.id === d.pathId);
  if (!path) return;
  const local = pointerInPathSpace(ev, d.part, path);
  const cmds = parsePath(path.d);
  const c = cmds[d.cmdIndex] as PathCmd & Record<string, number>;
  if (!c || c.cmd === 'Z') return;

  if (d.field === 'x') {
    const dx = local.x - c.x;
    const dy = local.y - c.y;
    const key = nodeKey(d.pathId, d.cmdIndex);
    if (selectedNodes.has(key) && selectedNodes.size > 1) {
      // Multi-node drag: the same ROOT-space delta moves every selected endpoint,
      // converted into each path's own local frame.
      const draggedLin = linearOnly(pathHolderMat(d.part, path));
      const rootD = applyMat(draggedLin, dx, dy);
      const byPath = new Map<string, number[]>();
      for (const k of selectedNodes) {
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
        svg!.querySelector(`[data-path-id="${p.id}"]`)?.setAttribute('d', p.d);
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
  const el = svg!.querySelector(`[data-path-id="${path.id}"]`);
  el?.setAttribute('d', path.d);
  renderOverlay();
}

// ---- One-shot node operations (driven by the inspector in node mode) ----

export type NodeOp = 'smooth' | 'symmetric' | 'retract' | 'toCurve' | 'toLine';

export function hasSelectedNode(): boolean {
  return selectedNodes.size > 0;
}

export function selectedNodeCount(): number {
  return selectedNodes.size;
}

/** The primary node's persistent type char ('c'/'s'/'z'), or null when untyped. */
export function primaryNodeType(): string | null {
  const part = selectedPart();
  if (!part || !selectedNode) return null;
  const path = part.paths.find((p) => p.id === selectedNode!.pathId);
  if (!path?.nodeTypes) return null;
  return path.nodeTypes[nodeIndexOf(parsePath(path.d), selectedNode.cmdIndex)] ?? null;
}

/** Ops set the PERSISTENT node type too: smooth→'s', symmetric→'z', retract→'c'. */
const OP_FLAG: Partial<Record<NodeOp, string>> = { smooth: 's', symmetric: 'z', retract: 'c' };

/** Apply a node op to every selected node. Returns whether anything changed. */
export function applyNodeOp(op: NodeOp): boolean {
  const part = selectedPart();
  if (!part || selectedNodes.size === 0) return false;
  let changed = false;
  const touched = new Set<RigPath>();

  for (const key of selectedNodes) {
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
    svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
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
  if (!part || selectedNodes.size === 0) return false;
  let changed = false;
  const byPath = new Map<string, number[]>();
  for (const key of selectedNodes) {
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
      svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
    }
  }
  selectedNodes.clear();
  selectedNode = null;
  if (changed) renderOverlay();
  return changed;
}

/** Nudge every selected node by a document-space delta (arrow keys in node mode). */
export function nudgeSelectedNodes(dx: number, dy: number): boolean {
  const part = selectedPart();
  if (!part || selectedNodes.size === 0) return false;
  const byPath = new Map<string, number[]>();
  for (const key of selectedNodes) {
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
    svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
  }
  renderOverlay();
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
  selectedNodes.clear();
  selectedNode = null;
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

/** For values that must stay finer than the 0.1 rest grid (zoomed-in nudges, pivot
 * compensation) — still coarse enough to keep serialized floats clean. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}
