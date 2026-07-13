/**
 * Graph geometry + camera: state-box sizing, SVG element helpers, screen↔graph-space
 * coordinate conversion, and per-machine pan/zoom session view state (NOT persisted, NOT
 * reset by rebuilds), keyed per machine id in a module-level map since the panel rebuilds
 * on every notify() and each machine should remember its own scroll position across
 * machine switches and logic-view toggles. The recenter/clamp/pan algebra and the per-
 * entity cache pattern live in `geometry/viewRect.ts` (shared with the timeline curve
 * editor's near-identical pan/zoom — see that module's header for why it's shared only
 * that far and not further, and why `view/camera.ts`'s main-canvas pan/zoom is excluded).
 * Sits below `./graph` (state/transition drawing + interaction); nothing here depends on it.
 */

import { StateMachine, SMState } from '../../core/model';
import {
  ViewRect, clampZoomSpan, recenterAxis, panAxis, getFittedViewRect, refitViewRect,
} from '../../geometry/viewRect';

export const SVG_NS = 'http://www.w3.org/2000/svg';

const ANIM_W = 128;
const ANIM_H = 52;
const NODE_W = 76;
const NODE_H = 44;

export function stateBox(st: SMState): { x: number; y: number; w: number; h: number } {
  const w = st.kind === 'animation' ? ANIM_W : NODE_W;
  const h = st.kind === 'animation' ? ANIM_H : NODE_H;
  return { x: st.x ?? 0, y: st.y ?? 0, w, h };
}

const graphViewRects = new Map<string, ViewRect>();
const GRAPH_FIT_PAD = 48;

/** Bounding box of every state's box, in graph space. */
function graphContentBounds(sm: StateMachine): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!sm.states.length) return { minX: 0, minY: 0, maxX: 480, maxY: 260 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of sm.states) {
    const b = stateBox(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

/** The viewBox rect that frames every state box with padding — what the ⌂ button
 * restores and what a machine gets the first time it's ever shown. */
function fitGraphRect(sm: StateMachine): ViewRect {
  const b = graphContentBounds(sm);
  return {
    x: b.minX - GRAPH_FIT_PAD,
    y: b.minY - GRAPH_FIT_PAD,
    w: Math.max(1, b.maxX - b.minX) + GRAPH_FIT_PAD * 2,
    h: Math.max(1, b.maxY - b.minY) + GRAPH_FIT_PAD * 2,
  };
}

/** Drops a deleted machine's dangling view-state entry (called from globals.ts's delete
 * machine button — graphViewRects itself stays private to this module). */
export function forgetGraphView(machineId: string): void {
  graphViewRects.delete(machineId);
}

/** This machine's current view rect, fitting it once the first time it's shown. */
export function getGraphViewRect(sm: StateMachine): ViewRect {
  return getFittedViewRect(graphViewRects, sm.id, () => fitGraphRect(sm));
}

export function applyGraphViewRect(svg: SVGSVGElement, vr: ViewRect): void {
  svg.setAttribute('viewBox', `${vr.x} ${vr.y} ${vr.w} ${vr.h}`);
}

/** ⌂ button + first-show: recenter/refit on every current state box. */
export function fitGraph(svg: SVGSVGElement, sm: StateMachine): void {
  applyGraphViewRect(svg, refitViewRect(graphViewRects, sm.id, () => fitGraphRect(sm)));
}

/**
 * Core viewBox zoom: scale around the graph-space point (px,py) by `factor` (>1 zooms
 * in), clamped to 0.2x-5x of the content-fit width — the same shape as view.ts's
 * zoomAround, but relative to this graph's own content bbox instead of doc.viewBox.
 * Width is the clamped axis; height is derived from the SAME applied ratio so zoom
 * stays aspect-preserving (unlike the curve editor's independent per-axis clamp).
 */
function zoomGraphAround(svg: SVGSVGElement, sm: StateMachine, px: number, py: number, factor: number): void {
  const vr = getGraphViewRect(sm);
  const fitW = fitGraphRect(sm).w;
  const newW = clampZoomSpan(vr.w / factor, fitW);
  const applied = vr.w / newW;
  const newH = vr.h / applied;
  vr.x = recenterAxis(px, vr.x, vr.w, newW);
  vr.y = recenterAxis(py, vr.y, vr.h, newH);
  vr.w = newW;
  vr.h = newH;
  applyGraphViewRect(svg, vr);
}

/** Middle-button drag pan (navigation, not editing — no checkpoints). */
function startGraphPan(svg: SVGSVGElement, sm: StateMachine, ev: PointerEvent): void {
  const vr = getGraphViewRect(sm);
  const startClient = { x: ev.clientX, y: ev.clientY };
  const startRect = { ...vr };
  svg.style.cursor = 'grabbing';
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }

  const move = (e: PointerEvent) => {
    const ctm = svg.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    vr.x = panAxis(startRect.x, (e.clientX - startClient.x) / scale);
    vr.y = panAxis(startRect.y, (e.clientY - startClient.y) / scale);
    applyGraphViewRect(svg, vr);
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.style.cursor = '';
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/** Wheel-zoom + middle-drag-pan, wired once per svg element (buildGraph creates a fresh
 * one on every rebuild). Pure camera mechanics — selection/arming stay in graph.ts. */
export function wireGraphCamera(svg: SVGSVGElement, sm: StateMachine): void {
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault(); // never scroll the timeline panel the graph sits in
    const p = svgPoint(svg, ev);
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomGraphAround(svg, sm, p.x, p.y, factor);
  }, { passive: false });

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault(); // no middle-click autoscroll
    startGraphPan(svg, sm, ev);
  });
}

export function elNS(tag: string, className = ''): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

export function svgText(x: number, y: number, content: string, className: string): SVGElement {
  const t = elNS('text', className);
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', 'middle');
  t.textContent = content;
  return t;
}

/** Accepts any event carrying client coordinates (pointer, wheel) — not just PointerEvent. */
export function svgPoint(svg: SVGSVGElement, ev: { clientX: number; clientY: number }): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: r.width ? ((ev.clientX - r.left) / r.width) * vb.width : 0,
      y: r.height ? ((ev.clientY - r.top) / r.height) * vb.height : 0,
    };
  }
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}
