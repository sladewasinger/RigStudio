/**
 * Camera: the viewBox zoom/pan state (`ctx.viewRect`) and the operations that move it.
 * resetView re-fits the document, applyViewRect flushes viewRect to the SVG attribute
 * (also used by the pan drag), and zoomAround/zoomBy scale around a point.
 */

import { state } from '../core/model';
import { ctx } from './context';
import { svgPoint } from './coords';
import { renderPose } from './render';

export function resetView(): void {
  ctx.viewRect = null;
  if (ctx.svg && state.doc) {
    ctx.viewRect = { ...state.doc.viewBox };
    applyViewRect();
  }
}

export function applyViewRect(): void {
  if (!ctx.svg || !ctx.viewRect) return;
  ctx.svg.setAttribute('viewBox', `${ctx.viewRect.x} ${ctx.viewRect.y} ${ctx.viewRect.w} ${ctx.viewRect.h}`);
}

/**
 * Core viewBox zoom: scale around the SVG-user-space point (px,py) by `factor` (>1
 * zooms in), clamped to the same 1/60..12x document-size bounds as wheel zoom. Shared
 * by the wheel handler (cursor-anchored) and zoomBy (keyboard, canvas-center-anchored).
 */
export function zoomAround(px: number, py: number, factor: number): void {
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
