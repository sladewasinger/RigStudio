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
 */

import { Easing, Keyframe, Track, sampleKeyList } from '../core/model';
import { checkpoint } from '../core/history';

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

/** Value range of a track's keys with ~10% padding (±1 around flat/empty tracks). */
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

/** Time/value ↔ pixel mapping plus the plot extents, shared by every draw helper. */
interface Plot {
  width: number;
  duration: number;
  min: number;
  max: number;
  xOf(t: number): number;
  yOf(v: number): number;
  tOf(x: number): number;
  vOf(y: number): number;
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
  container.appendChild(buildHeader(track));
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'graph-svg');
  container.appendChild(svg);
  // Draw immediately (fallback width — the container may not be laid out yet), then
  // redraw at the real width on the next frame. Never rely on rAF alone: headless
  // environments may not produce frames at all.
  drawGraph(svg, track, duration);
  requestAnimationFrame(() => drawGraph(svg, track, duration));
}

function buildHeader(track: Track): HTMLElement {
  const header = document.createElement('div');
  header.className = 'graph-header';
  const name = document.createElement('span');
  name.className = 'graph-track-name';
  name.textContent = track.channel;
  header.appendChild(name);

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
    'drag dots to retime/re-value · drag handles to shape the curve (dim = preset easing)';
  header.appendChild(hint);
  return header;
}

function drawGraph(svg: SVGSVGElement, track: Track, duration: number): void {
  const width = Math.max(320, svg.clientWidth || 800);
  svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  const { min, max } = valueRange(track.keyframes);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const plot: Plot = {
    width, duration, min, max,
    xOf: (t) => PAD.left + (t / duration) * plotW,
    yOf: (v) => PAD.top + ((max - v) / (max - min)) * plotH,
    tOf: (x) => ((x - PAD.left) / plotW) * duration,
    vOf: (y) => max - ((y - PAD.top) / plotH) * (max - min),
  };
  const redraw = () => {
    svg.replaceChildren();
    drawGrid(svg, plot);
    drawCurve(svg, track, plot);
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      drawSegmentHandles(svg, track.keyframes[i], track.keyframes[i + 1], plot, redraw);
    }
    drawKeys(svg, track, plot, redraw);
  };
  redraw();
}

function drawGrid(svg: SVGSVGElement, plot: Plot): void {
  const vStep = niceStep(plot.max - plot.min, 5);
  const v0 = Math.ceil(plot.min / vStep - 1e-6);
  const v1 = Math.floor(plot.max / vStep + 1e-6);
  for (let i = v0; i <= v1; i++) {
    const v = i * vStep;
    const y = plot.yOf(v);
    svg.appendChild(line(PAD.left, y, plot.width - PAD.right, y, 'graph-grid-line'));
    svg.appendChild(text(PAD.left - 6, y + 3, fmt(v), 'end'));
  }
  const tStep = niceStep(plot.duration, 8);
  const n = Math.floor(plot.duration / tStep + 1e-6);
  for (let i = 0; i <= n; i++) {
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
    const t = (i / CURVE_SAMPLES) * plot.duration;
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

function drawKeys(svg: SVGSVGElement, track: Track, plot: Plot, redraw: () => void): void {
  for (const key of track.keyframes) {
    const dot = el('circle', 'graph-key');
    dot.setAttribute('cx', String(plot.xOf(key.time)));
    dot.setAttribute('cy', String(plot.yOf(key.value)));
    dot.setAttribute('r', '5');
    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = `${key.time} ms = ${fmt(key.value)} · drag to retime/re-value`;
    dot.appendChild(tip);
    dot.addEventListener('pointerdown', (ev) => startKeyDrag(ev, svg, track, key, plot, redraw));
    svg.appendChild(dot);
  }
}

/** Drag a keyframe dot: horizontal retimes (10 ms snap, clamped), vertical re-values. */
function startKeyDrag(
  ev: PointerEvent, svg: SVGSVGElement, track: Track, key: Keyframe,
  plot: Plot, redraw: () => void,
): void {
  ev.preventDefault();
  ev.stopPropagation();
  let pendingCheckpoint = true; // defer until real movement, not a plain click
  // Capture on the svg, which survives redraw() replacing the dragged circle.
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
  const move = (e: PointerEvent) => {
    if (pendingCheckpoint) {
      checkpoint();
      pendingCheckpoint = false;
    }
    const p = svgPoint(svg, e);
    key.time = Math.min(plot.duration, Math.max(0, Math.round(plot.tOf(p.x) / 10) * 10));
    key.value = round3(plot.vOf(p.y));
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

/** Pointer event → viewBox coordinates (normalizes any post-draw CSS resize). */
function svgPoint(svg: SVGSVGElement, ev: PointerEvent): { x: number; y: number } {
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
