/**
 * Per-part <path> DOM management: apply style/geometry attributes, reconcile a part's
 * path elements after structural edits, keep DOM paint order in sync with the model,
 * and register/unregister the canvas group for parts created or removed after build.
 *
 * renderPose() still owns transforms — these helpers only touch the geometry/attribute
 * side of the DOM. undo/redo rebuilds via buildCanvas, so path reconciliation here is
 * forward-only.
 */

import { RigPart, RigPath, state } from '../core/model';
import { ctx, SVG_NS } from './context';
import { renderPose } from './render';
import { renderOverlay } from './overlay';

export function applyPathAttrs(el: SVGPathElement, p: RigPath): void {
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
  // Clear a stale transform when the model no longer carries one — otherwise binding
  // (which bakes path.transform INTO the geometry and sets path.transform='') would
  // leave the old DOM transform attribute in place, double-applying it and visibly
  // shifting the art. This was the "bind moved the art" bug (parts whose paths carried
  // a transform, e.g. an Inkscape rotate/matrix, drifted; transform-less parts didn't).
  if (p.transform) el.setAttribute('transform', p.transform);
  else el.removeAttribute('transform');
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
export function syncPartPathDom(part: RigPart): void {
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
