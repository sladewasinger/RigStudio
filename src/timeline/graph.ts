/**
 * Graph (curve) editor: plots one track's value-vs-time curve beneath the timeline
 * lanes, with draggable keyframe dots and per-segment cubic-bezier handles.
 *
 * Handles visualize the CSS-style bezier stored on the ARRIVING keyframe
 * (`Keyframe.bezier`, which overrides `easing` when set) mapped into the segment's
 * time/value rectangle. A segment without a custom bezier shows dimmed handles at the
 * positions implied by its preset easing; grabbing one converts the segment to a
 * custom bezier starting from those values. Every mutation notifies the callback
 * registered via onGraphChange (live pose preview); pointerup re-sorts the track and
 * dispatches 'rig-keys-changed' so the timeline rebuilds.
 *
 * Pan/zoom: the plot's pixel viewBox (0 0 width HEIGHT) never changes — instead a
 * per-track "view rect" (visible time/value window) is panned/zoomed and remapped
 * into the fixed PAD-inset drawing rectangle. The recenter/clamp/pan algebra and the
 * per-track session cache reuse `geometry/viewRect.ts` (shared with smPanel's graph
 * pan/zoom — see that module's header for what's shared and why); this editor's own
 * DOM wiring stays here because its value axis is y-flipped (increasing value means
 * decreasing pixel y) and its zoom clamps each axis independently, unlike the SM graph.
 */

import { Easing, Keyframe, Track, sampleKeyList } from '../core/model';
import { checkpoint } from '../core/history';
import {
  ViewRect, clampZoomSpan, recenterAxis, panAxis, getFittedViewRect, refitViewRect,
} from '../geometry/viewRect';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 220;
const PAD = { left: 46, right: 12, top: 12, bottom: 24 };
const CURVE_SAMPLES = 120;

/** Handle positions implied by each preset easing (CSS cubic-bezier x1,y1,x2,y2). */
export const PRESET_BEZIER: Record<Easing, [number, number, number, number]> = {
  linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

let changeCallback: (() => void) | null = null;

/** Register the after-any-mutation callback (the timeline passes a pose re-render). */
export function onGraphChange(fn: () => void): void {
  changeCallback = fn;
}

/** Value range of a track's keys with ~10% padding (±1 around flat/empty tracks).
 *  Pure key-value range only — see plotValueRange for the draw-time range, which
 *  also expands to cover bezier-handle overshoot plus extra headroom. */
export function valueRange(keys: Keyframe[]): { min: number; max: number } {
  if (keys.length === 0) return { min: -1, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const k of keys) {
    if (k.value < min) min = k.value;
    if (k.value > max) max = k.value;
  }
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
}

/**
 * Draw-time value range: starts from valueRange's key-value span, EXPANDS to cover
 * every segment's current bezier-handle value (handles can overshoot 0..1 on the y
 * axis — that's intentional, CSS cubic-bezier allows it), then adds 15% headroom on
 * top so handles sitting right at the current extreme stay comfortably grabbable
 * instead of clipping against the plot edge (the item this fixes: dragging a handle
 * to the top/bottom of the chart used to make it nearly impossible to grab again).
 */
function plotValueRange(track: Track): { min: number; max: number } {
  let { min, max } = valueRange(track.keyframes);
  for (let i = 0; i < track.keyframes.length - 1; i++) {
    const k0 = track.keyframes[i];
    const k1 = track.keyframes[i + 1];
    const b = k1.bezier ?? PRESET_BEZIER[k1.easing];
    const dv = k1.value - k0.value;
    for (const h of [0, 1] as const) {
      const v = k0.value + b[h * 2 + 1] * dv;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.15;
  return { min: min - pad, max: max + pad };
}

/** Smallest 1/2/5-series step ≥ span/maxTicks, for readable grid labels. */
export function niceStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5]) {
    if (pow * m >= raw) return pow * m;
  }
  return pow * 10;
}

// ---- Pan/zoom view state (session-only, keyed per track) ----

const graphViewRects = new Map<string, ViewRect>();

function trackKey(track: Track): string {
  return `${track.target}::${track.channel}`;
}

function fitViewRect(track: Track, duration: number): ViewRect {
  const { min, max } = plotValueRange(track);
  return { x: 0, y: min, w: Math.max(1, duration), h: Math.max(1e-6, max - min) };
}

/** This track's current view rect, fitting it once the first time it's shown. */
function getViewRect(track: Track, duration: number): ViewRect {
  return getFittedViewRect(graphViewRects, trackKey(track), () => fitViewRect(track, duration));
}

function fitView(track: Track, duration: number): void {
  refitViewRect(graphViewRects, trackKey(track), () => fitViewRect(track, duration));
}

/** Time/value ↔ pixel mapping for the CURRENT view rect, within the fixed PAD-inset
 *  drawing rectangle (the svg's own viewBox never changes — only this mapping does). */
interface Plot {
  width: number;
  plotW: number;
  plotH: number;
  t0: number; t1: number; v0: number; v1: number;
  xOf(t: number): number;
  yOf(v: number): number;
  tOf(x: number): number;
  vOf(y: number): number;
}

function makePlot(width: number, vr: ViewRect): Plot {
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = vr.x, t1 = vr.x + vr.w;
  const v0 = vr.y, v1 = vr.y + vr.h;
  return {
    width, plotW, plotH, t0, t1, v0, v1,
    xOf: (t) => PAD.left + ((t - t0) / (t1 - t0)) * plotW,
    yOf: (v) => PAD.top + ((v1 - v) / (v1 - v0)) * plotH,
    tOf: (x) => t0 + ((x - PAD.left) / plotW) * (t1 - t0),
    vOf: (y) => v1 - ((y - PAD.top) / plotH) * (v1 - v0),
  };
}

/**
 * Core view-rect zoom: scale around the graph-space point (px,py) — in the FIXED
 * pixel viewBox, same space svgPoint() returns — by `factor` (>1 zooms in), clamped
 * to 0.2x-5x of the fit span on each axis independently (t and v are different units,
 * so — unlike the SM graph's aspect-preserving zoom — one axis can hit its clamp
 * without affecting the other). The value axis recenters on its HIGH edge (v1, i.e.
 * the smallest pixel y) rather than its low edge, since increasing value means
 * decreasing pixel y; the low edge (vr.y) is derived back out afterward.
 */
function zoomViewRect(vr: ViewRect, fit: ViewRect, plot: Plot, px: number, py: number, factor: number): void {
  const dataT = plot.tOf(px);
  const dataV = plot.vOf(py);
  const newW = clampZoomSpan(vr.w / factor, fit.w);
  const newH = clampZoomSpan(vr.h / factor, fit.h);
  const v1Old = vr.y + vr.h;
  const v1New = recenterAxis(dataV, v1Old, vr.h, newH);
  vr.x = recenterAxis(dataT, vr.x, vr.w, newW);
  vr.y = v1New - newH;
  vr.w = newW;
  vr.h = newH;
}

/** Middle-button drag pan (navigation, not editing — no checkpoints). The value axis
 *  pans with a FLIPPED sign (dragging down should reveal lower values, i.e. increase
 *  v0) since it is y-flipped relative to pixel space — see zoomViewRect. */
function startPan(svg: SVGSVGElement, track: Track, duration: number, ev: PointerEvent, paint: () => void): void {
  const vr = getViewRect(track, duration);
  const width = Math.max(320, svg.clientWidth || 800);
  const plot = makePlot(width, vr);
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / width || 1;
  const startClient = { x: ev.clientX, y: ev.clientY };
  const startRect = { ...vr };
  svg.style.cursor = 'grabbing';
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
  const move = (e: PointerEvent) => {
    const dxPx = (e.clientX - startClient.x) / scale;
    const dyPx = (e.clientY - startClient.y) / scale;
    vr.x = panAxis(startRect.x, (dxPx / plot.plotW) * startRect.w);
    vr.y = panAxis(startRect.y, (dyPx / plot.plotH) * startRect.h, 1);
    paint();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.style.cursor = '';
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/** Wired exactly once per svg element (buildGraphPanel creates a fresh one on every
 *  panel rebuild) — `paint` just redraws content, it never re-wires listeners. */
function wireGraphInteractions(svg: SVGSVGElement, track: Track, duration: number, paint: () => void): void {
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault(); // never scroll the timeline body the graph sits in
    const width = Math.max(320, svg.clientWidth || 800);
    const vr = getViewRect(track, duration);
    const plot = makePlot(width, vr);
    // NOT svgPoint(svg, ev): that reads the svg's CURRENT viewBox attribute, which is
    // only refreshed by the next drawGraph() call — it can be stale relative to the
    // `width` just measured above (clientWidth can settle a frame before the viewBox
    // attribute catches up), corrupting the anchor. Convert through `width` directly so
    // the cursor point is always in the SAME coordinate space as `plot`.
    const rect = svg.getBoundingClientRect();
    const p = {
      x: ((ev.clientX - rect.left) / rect.width) * width,
      y: ((ev.clientY - rect.top) / rect.height) * HEIGHT,
    };
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomViewRect(vr, fitViewRect(track, duration), plot, p.x, p.y, factor);
    paint();
  }, { passive: false });

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault(); // no middle-click autoscroll
    startPan(svg, track, duration, ev, paint);
  });
}

/** Render the curve editor for one track (or a hint when there is nothing to edit). */
export function buildGraphPanel(
  container: HTMLElement, track: Track | null, duration: number,
): void {
  container.innerHTML = '';
  if (!track || track.keyframes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'graph-empty';
    empty.textContent = 'Select a keyframe to edit its curve.';
    container.appendChild(empty);
    return;
  }
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'graph-svg');
  const paint = () => drawGraph(svg, track, duration);

  container.appendChild(buildHeader(track, () => { fitView(track, duration); paint(); }));
  container.appendChild(svg);

  wireGraphInteractions(svg, track, duration, paint);
  // Draw immediately (fallback width — the container may not be laid out yet), then
  // redraw at the real width on the next frame. Never rely on rAF alone: headless
  // environments may not produce frames at all.
  paint();
  requestAnimationFrame(paint);
}

function buildHeader(track: Track, onFit: () => void): HTMLElement {
  const header = document.createElement('div');
  header.className = 'graph-header';
  const name = document.createElement('span');
  name.className = 'graph-track-name';
  name.textContent = track.channel;
  header.appendChild(name);

  const fitBtn = document.createElement('button');
  fitBtn.textContent = '⌂ fit';
  fitBtn.title = 'Reset pan/zoom to fit this track';
  fitBtn.onclick = onFit;
  header.appendChild(fitBtn);

  const reset = document.createElement('button');
  reset.textContent = 'reset to preset';
  reset.title = 'Clear custom bezier curves on this track — segments fall back to their preset easing';
  reset.onclick = () => {
    if (!track.keyframes.some((k) => k.bezier)) return;
    checkpoint();
    for (const k of track.keyframes) k.bezier = null;
    changeCallback?.();
    document.dispatchEvent(new CustomEvent('rig-keys-changed'));
  };
  header.appendChild(reset);

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent =
    'drag dots to retime/re-value (snaps back to the pre-drag value near it — Alt overrides) · ' +
    'drag handles to shape the curve (dim = preset easing) · wheel zoom · middle-drag pan';
  header.appendChild(hint);
  return header;
}

function drawGraph(svg: SVGSVGElement, track: Track, duration: number): void {
  const width = Math.max(320, svg.clientWidth || 800);
  svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  const vr = getViewRect(track, duration);
  const plot = makePlot(width, vr);
  const redraw = () => drawGraph(svg, track, duration);
  svg.replaceChildren();
  drawGrid(svg, plot);
  drawCurve(svg, track, plot);
  for (let i = 0; i < track.keyframes.length - 1; i++) {
    drawSegmentHandles(svg, track.keyframes[i], track.keyframes[i + 1], plot, redraw);
  }
  drawKeys(svg, track, plot, duration, redraw);
}

function drawGrid(svg: SVGSVGElement, plot: Plot): void {
  const vStep = niceStep(plot.v1 - plot.v0, 5);
  const v0i = Math.ceil(plot.v0 / vStep - 1e-6);
  const v1i = Math.floor(plot.v1 / vStep + 1e-6);
  for (let i = v0i; i <= v1i; i++) {
    const v = i * vStep;
    const y = plot.yOf(v);
    svg.appendChild(line(PAD.left, y, plot.width - PAD.right, y, 'graph-grid-line'));
    svg.appendChild(text(PAD.left - 6, y + 3, fmt(v), 'end'));
  }
  const tStep = niceStep(plot.t1 - plot.t0, 8);
  const t0i = Math.ceil(plot.t0 / tStep - 1e-6);
  const t1i = Math.floor(plot.t1 / tStep + 1e-6);
  for (let i = t0i; i <= t1i; i++) {
    const t = i * tStep;
    const x = plot.xOf(t);
    svg.appendChild(line(x, PAD.top, x, HEIGHT - PAD.bottom, 'graph-grid-line'));
    svg.appendChild(text(x, HEIGHT - PAD.bottom + 14, `${fmt(t)}ms`, 'middle'));
  }
}

function drawCurve(svg: SVGSVGElement, track: Track, plot: Plot): void {
  // Sample a sorted copy — mid-drag the live list may be momentarily out of order.
  const keys = [...track.keyframes].sort((a, b) => a.time - b.time);
  const fallback = keys[0]?.value ?? 0;
  const pts: string[] = [];
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = plot.t0 + (i / CURVE_SAMPLES) * (plot.t1 - plot.t0);
    const v = sampleKeyList(keys, t, fallback);
    pts.push(`${plot.xOf(t).toFixed(1)},${plot.yOf(v).toFixed(1)}`);
  }
  const poly = el('polyline', 'graph-curve');
  poly.setAttribute('points', pts.join(' '));
  svg.appendChild(poly);
}

/**
 * Bezier handles for the segment k0 → k1, mapped into its time/value rectangle:
 * x = k0.time + bx·span, y = k0.value + by·Δv. Custom beziers draw solid; preset
 * easings draw dimmed and become custom the moment a handle is grabbed.
 */
function drawSegmentHandles(
  svg: SVGSVGElement, k0: Keyframe, k1: Keyframe, plot: Plot, redraw: () => void,
): void {
  const b = k1.bezier ?? PRESET_BEZIER[k1.easing];
  const dim = k1.bezier ? '' : ' preset';
  const span = k1.time - k0.time;
  const dv = k1.value - k0.value;
  const ends = [
    { x: plot.xOf(k0.time), y: plot.yOf(k0.value) },
    { x: plot.xOf(k1.time), y: plot.yOf(k1.value) },
  ];
  for (const h of [0, 1] as const) {
    const px = plot.xOf(k0.time + b[h * 2] * span);
    const py = plot.yOf(k0.value + b[h * 2 + 1] * dv);
    svg.appendChild(line(ends[h].x, ends[h].y, px, py, `graph-handle-line${dim}`));
    const dot = el('circle', `graph-handle${dim}`);
    dot.setAttribute('cx', String(px));
    dot.setAttribute('cy', String(py));
    dot.setAttribute('r', '4');
    dot.addEventListener('pointerdown', (ev) => startHandleDrag(ev, svg, k0, k1, h, plot, redraw));
    svg.appendChild(dot);
  }
}

function drawKeys(svg: SVGSVGElement, track: Track, plot: Plot, duration: number, redraw: () => void): void {
  for (const key of track.keyframes) {
    const dot = el('circle', 'graph-key');
    dot.setAttribute('cx', String(plot.xOf(key.time)));
    dot.setAttribute('cy', String(plot.yOf(key.value)));
    dot.setAttribute('r', '5');
    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = `${key.time} ms = ${fmt(key.value)} · drag to retime/re-value`;
    dot.appendChild(tip);
    dot.addEventListener('pointerdown', (ev) => startKeyDrag(ev, svg, track, key, plot, duration, redraw));
    svg.appendChild(dot);
  }
}

/**
 * Drag a keyframe dot: horizontal retimes (10 ms snap, clamped to the clip's actual
 * duration — NOT the current pan/zoom window). Vertical re-values, but SNAPS BACK to
 * the value the key had before this drag whenever the pointer is within a small
 * threshold of that value's height — so nudging a dot mostly sideways (a very common
 * gesture: retiming without meaning to touch the value) doesn't silently drop the
 * authored value. Hold Alt to disable the snap and re-value freely near that point.
 */
function startKeyDrag(
  ev: PointerEvent, svg: SVGSVGElement, track: Track, key: Keyframe,
  plot: Plot, duration: number, redraw: () => void,
): void {
  ev.preventDefault();
  ev.stopPropagation();
  const startValue = key.value;
  const startY = plot.yOf(startValue);
  const SNAP_PX = 6;
  let pendingCheckpoint = true; // defer until real movement, not a plain click
  // Capture on the svg, which survives redraw() replacing the dragged circle.
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
  const move = (e: PointerEvent) => {
    if (pendingCheckpoint) {
      checkpoint();
      pendingCheckpoint = false;
    }
    const p = svgPoint(svg, e);
    key.time = Math.min(duration, Math.max(0, Math.round(plot.tOf(p.x) / 10) * 10));
    key.value = (!e.altKey && Math.abs(p.y - startY) <= SNAP_PX)
      ? startValue
      : round3(plot.vOf(p.y));
    redraw();
    changeCallback?.();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    track.keyframes.sort((a, b) => a.time - b.time);
    changeCallback?.();
    document.dispatchEvent(new CustomEvent('rig-keys-changed'));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/** Drag a bezier handle: writes k1.bezier (x clamped 0..1, y free for overshoot). */
function startHandleDrag(
  ev: PointerEvent, svg: SVGSVGElement, k0: Keyframe, k1: Keyframe,
  handle: 0 | 1, plot: Plot, redraw: () => void,
): void {
  ev.preventDefault();
  ev.stopPropagation();
  let pendingCheckpoint = true;
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
  const span = k1.time - k0.time;
  const dv = k1.value - k0.value;
  const move = (e: PointerEvent) => {
    if (pendingCheckpoint) {
      checkpoint();
      // Grabbing a preset handle converts the segment to a custom bezier.
      if (!k1.bezier) {
        const p = PRESET_BEZIER[k1.easing];
        k1.bezier = [p[0], p[1], p[2], p[3]];
      }
      pendingCheckpoint = false;
    }
    const p = svgPoint(svg, e);
    // Flat/zero-length segments: leave the degenerate axis alone (no divide-by-zero;
    // the eased value is constant across the segment anyway).
    const bx = span === 0 ? k1.bezier![handle * 2] : (plot.tOf(p.x) - k0.time) / span;
    const by = dv === 0 ? k1.bezier![handle * 2 + 1] : (plot.vOf(p.y) - k0.value) / dv;
    k1.bezier![handle * 2] = round3(Math.min(1, Math.max(0, bx)));
    k1.bezier![handle * 2 + 1] = round3(by);
    redraw();
    changeCallback?.();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    changeCallback?.();
    document.dispatchEvent(new CustomEvent('rig-keys-changed'));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

// ---- SVG helpers ----

/** Pointer/wheel event → viewBox coordinates (normalizes any post-draw CSS resize). */
function svgPoint(svg: SVGSVGElement, ev: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: ((ev.clientX - rect.left) / rect.width) * vb.width,
    y: ((ev.clientY - rect.top) / rect.height) * vb.height,
  };
}

function el(tag: string, className = ''): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function line(x1: number, y1: number, x2: number, y2: number, className: string): SVGElement {
  const ln = el('line', className);
  ln.setAttribute('x1', String(x1));
  ln.setAttribute('y1', String(y1));
  ln.setAttribute('x2', String(x2));
  ln.setAttribute('y2', String(y2));
  return ln;
}

function text(x: number, y: number, content: string, anchor: 'end' | 'middle'): SVGElement {
  const t = el('text', 'graph-axis-label');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.textContent = content;
  return t;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const fmt = (n: number): string => String(Number(n.toFixed(2)));
