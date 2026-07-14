/**
 * Per-part DOM management: apply style/geometry attributes, (re)build a part's own
 * run-group structure (U2 — `RigPart.childOrder`) after a structural edit, keep DOM paint
 * order in sync with the model, and register/unregister a part's canvas groups when
 * created or removed after buildCanvas.
 *
 * A part renders as MORE THAN ONE `<g data-part-id>` flat sibling when its own paths
 * interleave with children in its childOrder (see `core/paintOrder.ts`) — `ctx.partGroups`
 * holds every one of a part's run groups, in run order (one, holding all its paths, for
 * every doc that predates U2 or was never hand-edited into an interleaved shape — the
 * exact pre-U2 DOM). Consumers that only need the part's TRANSFORM/CTM may read any one
 * (`primaryPartGroup` — every run of a part shares the SAME composed transform, flat
 * siblings, no DOM nesting, no pose-math change); consumers that need the part's own
 * rendered GEOMETRY (bbox, `<path>` elements) must look across every run
 * (`partOwnBBox`/`partOwnPathElements`) — all three READ helpers actually live in
 * context.ts (the layering DAG's lowest tier, reachable from the overlay cluster, which
 * sits BELOW this module) and are re-exported here for discoverability, since this is
 * where a reader looks for "the run registry API".
 *
 * renderPose() still owns transforms — the functions actually defined here only touch the
 * geometry/attribute side of the DOM (plus, here, which `<g>` elements exist for a part at
 * all). undo/redo rebuilds via buildCanvas, so path/run reconciliation here is forward-only.
 */

import { RigPart, RigPath, state, partOwnRuns, flattenPaintOrder } from '../core/model';
import { ctx, SVG_NS, primaryPartGroup, partOwnBBox, partOwnPathElements } from './context';
import { renderPose } from './render';
import { renderOverlay } from './overlay';

export { primaryPartGroup, partOwnBBox, partOwnPathElements };

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
 * Re-sync DOM paint order with the current childOrder-derived STRUCTURAL (REST) paint
 * sequence after a change to doc.parts sibling order or a part's own run structure
 * (Layers drag-reorder, PageUp/PageDown, group/bone creation) — appendChild MOVES the
 * existing groups, so this is cheap: no rebuild, no re-measure. This is REST order only
 * (a constant zOf), matching Edit mode — the Animate-mode keyed-z resort runs every frame
 * inside renderPose instead (render.ts's applyDrawOrder), never here.
 */
export function reorderCanvas(): void {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return;
  for (const run of flattenPaintOrder(doc, () => 0)) {
    const g = ctx.partGroups.get(run.partId)?.[run.runIndex];
    if (g) ctx.rootGroup.appendChild(g);
  }
  renderPose();
}

/** Reconcile ONE run group's own `<path>` DOM against `pathIds` (exactly the pre-U2
 *  `syncPartPathDom` body, applied per run instead of to a part's single group) —
 *  creates missing elements, drops stale ones, refreshes attributes, re-appends
 *  everything in order. Never touches the group's OWN attributes (transform, dimmed/
 *  hidden classes, data-run) — a REUSED group keeps whatever renderPose last set, which
 *  is the whole point: callers of syncPartPathDom that don't call renderPose() right
 *  after (deleteNode, insertNodeOnSegment) must still see a correctly-positioned group
 *  for the very next coordinate read (pathHolderMat etc). */
function reconcileRunGroupPaths(g: SVGGElement, part: RigPart, pathIds: string[]): void {
  const wanted = new Set(pathIds);
  for (const el of Array.from(g.querySelectorAll<SVGPathElement>('[data-path-id]'))) {
    if (!wanted.has(el.dataset.pathId!)) el.remove();
  }
  for (const pid of pathIds) {
    const path = part.paths.find((p) => p.id === pid);
    if (!path) continue;
    let el = g.querySelector<SVGPathElement>(`[data-path-id="${pid}"]`);
    if (!el) {
      el = document.createElementNS(SVG_NS, 'path');
      el.dataset.pathId = pid;
    }
    applyPathAttrs(el, path);
    g.appendChild(el); // re-append in order (moves existing, adds new at the right spot)
  }
}

/**
 * Build (or rebuild) `part`'s own run-group `<g>` elements from its CURRENT childOrder/
 * paths (`core/model`'s `partOwnRuns`). The caller is responsible for keeping
 * `part.childOrder` itself in sync FIRST (`reconcileChildOrder`/`slotAddPath`/
 * `slotRemovePath`) when one is present — this only ever reads it, never repairs it.
 * Used by `registerPart` (a brand-new part) and `syncPartPathDom` (a part whose OWN
 * path set just changed).
 *
 * The run COUNT staying the same (every part today, and any part U2 doesn't newly
 * interleave) is the FAST, IDENTITY-PRESERVING path: the existing group(s) are reused
 * in place, only their `<path>` children reconciled (`reconcileRunGroupPaths`) — the
 * group's own transform/dimmed/hidden state (set by the last renderPose()) survives
 * untouched, which several `applyStructuralEdit` callers depend on (they update the DOM
 * then read coordinates back through it BEFORE their own next renderPose() call — see
 * node-editing/structural.ts's insertNodeOnSegment/deleteNode). Only a genuine run-COUNT
 * change (childOrder interleaving newly appearing or disappearing on this part — no
 * current UI path produces this, but a hand-edited doc can) falls back to a full
 * remove+recreate, carrying the prior transform forward so no caller observes a
 * momentarily-untransformed group, and repainting immediately so paint order self-heals
 * in the SAME tick rather than waiting for whatever renderPose() happens to run next.
 */
function rebuildPartRunGroups(part: RigPart): void {
  const doc = state.doc;
  const existing = ctx.partGroups.get(part.id) ?? [];
  const runs = doc ? partOwnRuns(part, doc.parts) : [part.paths.map((p) => p.id)];

  if (existing.length === runs.length) {
    runs.forEach((pathIds, i) => reconcileRunGroupPaths(existing[i], part, pathIds));
    return;
  }

  const priorTransform = existing[0]?.getAttribute('transform') ?? '';
  const salvaged = new Map<string, SVGPathElement>();
  for (const g of existing) {
    for (const el of Array.from(g.querySelectorAll<SVGPathElement>('[data-path-id]'))) {
      salvaged.set(el.dataset.pathId!, el);
    }
  }
  for (const g of existing) g.remove();

  const groups = runs.map((pathIds, i) => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.partId = part.id;
    if (runs.length > 1) g.dataset.run = String(i);
    if (priorTransform) g.setAttribute('transform', priorTransform);
    for (const pid of pathIds) {
      const path = part.paths.find((p) => p.id === pid);
      if (!path) continue;
      let el = salvaged.get(pid);
      if (!el) {
        el = document.createElementNS(SVG_NS, 'path');
        el.dataset.pathId = pid;
      }
      applyPathAttrs(el, path);
      g.appendChild(el);
    }
    return g;
  });
  ctx.partGroups.set(part.id, groups);
  if (ctx.rootGroup) for (const g of groups) ctx.rootGroup.appendChild(g);
  renderPose(); // reapply the real transform/opacity/paint-order immediately — see above
}

/** Register a part created after buildCanvas (bones, groups, a Ctrl+D clone, an extracted
 *  path's new part). Guarded no-op if already registered. */
export function registerPart(part: RigPart): void {
  if (!ctx.rootGroup || ctx.partGroups.has(part.id)) return;
  rebuildPartRunGroups(part);
}

/** Drop a removed part's canvas groups (ungroup/dissolve/delete) — every run, not just one. */
export function unregisterPart(id: string): void {
  for (const g of ctx.partGroups.get(id) ?? []) g.remove();
  ctx.partGroups.delete(id);
}

/**
 * Reconcile a part's OWN run-group DOM with its current `part.paths`/childOrder after a
 * structural edit (paths added by a split, removed by a merge, moved across parts) — see
 * `rebuildPartRunGroups`. A no-op if the part isn't registered yet.
 */
export function syncPartPathDom(part: RigPart): void {
  if (!ctx.partGroups.has(part.id)) return;
  rebuildPartRunGroups(part);
}
