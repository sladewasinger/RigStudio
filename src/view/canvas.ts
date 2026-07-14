/**
 * Canvas construction: build the live SVG for the current document, seed any missing
 * pivots from measured geometry, and install the interaction listeners.
 *
 * buildCanvas is the view's single entry point — main.ts calls it on load and after
 * undo/redo. The render-then-measure order is load-bearing: the rest pose must be
 * applied so each group carries its baked transform BEFORE bbox centers are mapped
 * through it into root coordinates (the boot assertion pins right_arm's pivot to the
 * SVG's authored rotation center).
 */

import { state, flattenPaintOrder } from '../core/model';
import { ctx, SVG_NS } from './context';
import { svgPoint } from './coords';
import { renderPose } from './render';
import { applyPathAttrs, partOwnBBox } from './partDom';
import { applyViewRect } from './camera';
import { wireInteractions } from './interactions';

export function buildCanvas(container: HTMLElement): void {
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  ctx.svg = document.createElementNS(SVG_NS, 'svg');
  if (!ctx.viewRect) ctx.viewRect = { ...doc.viewBox };
  applyViewRect();
  ctx.svg.id = 'rig-svg';

  // Artboard (page) rect: a passive backdrop, first child so it paints behind onion
  // ghosts and every part. Non-interactive so it never steals hit-testing or selection;
  // a direct child of the svg (not rootGroup/partGroups) so it never shows up in
  // getBBox-based logic (align, "from artwork", pivot seeding). Geometry/visibility are
  // kept correct by renderPose (updateArtboardRect); this just creates the element with
  // its static styling.
  const artboardRect = document.createElementNS(SVG_NS, 'rect');
  artboardRect.id = 'rig-artboard-rect';
  artboardRect.setAttribute('pointer-events', 'none');
  artboardRect.setAttribute('vector-effect', 'non-scaling-stroke');
  artboardRect.style.fill = 'var(--accent-2)';
  artboardRect.style.fillOpacity = '0.05';
  artboardRect.style.stroke = 'var(--accent-2)';
  artboardRect.style.strokeOpacity = '0.4';
  artboardRect.style.strokeWidth = '1';
  ctx.svg.appendChild(artboardRect);

  ctx.onionGroup = document.createElementNS(SVG_NS, 'g');
  ctx.onionGroup.id = 'onion';
  ctx.svg.appendChild(ctx.onionGroup);
  ctx.rootGroup = document.createElementNS(SVG_NS, 'g');
  ctx.svg.appendChild(ctx.rootGroup);
  ctx.overlay = document.createElementNS(SVG_NS, 'g');
  ctx.overlay.id = 'overlay';
  ctx.svg.appendChild(ctx.overlay);

  // U2: paint order is `part.childOrder`'s slot flatten, NOT a flat one-group-per-part
  // loop over doc.parts — a part whose own paths interleave with children (never the
  // case for a doc that predates U2 or was never hand-edited into that shape, so this
  // degenerates to EXACTLY the old loop's DOM for every doc built before this wave) gets
  // one `<g data-part-id data-run>` per contiguous PATH run, built and appended in the
  // already-correct flattened order — no separate reorder pass needed here. A constant
  // zOf (rest/structural order) matches Edit mode; `applyDrawOrder` (render.ts) re-derives
  // the Animate-mode keyed-z order every frame from the same algorithm.
  ctx.partGroups.clear();
  const byPart = new Map<string, SVGGElement[]>();
  const partsById = new Map(doc.parts.map((p) => [p.id, p]));
  for (const run of flattenPaintOrder(doc, () => 0)) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.partId = run.partId;
    if (run.totalRuns > 1) g.dataset.run = String(run.runIndex);
    const part = partsById.get(run.partId)!;
    for (const pid of run.pathIds) {
      const path = part.paths.find((p) => p.id === pid);
      if (!path) continue;
      const el = document.createElementNS(SVG_NS, 'path');
      applyPathAttrs(el, path);
      el.dataset.pathId = pid;
      g.appendChild(el);
    }
    ctx.rootGroup.appendChild(g);
    const arr = byPart.get(run.partId) ?? [];
    arr.push(g);
    byPart.set(run.partId, arr);
  }
  for (const [id, groups] of byPart) ctx.partGroups.set(id, groups);
  container.appendChild(ctx.svg);

  // Freeze-mode indicator: an always-present banner shown via CSS only while #canvas
  // carries the .freeze-mode class (toggled by renderPose). pointer-events:none so it
  // never steals hit-testing. Re-created here because buildCanvas clears the container.
  const banner = document.createElement('div');
  banner.className = 'freeze-banner';
  banner.setAttribute('aria-hidden', 'true');
  banner.textContent = 'FREEZE — origin editing';
  container.appendChild(banner);

  // Apply the rest pose first so each group carries its baked transform, THEN measure:
  // bbox centers must be mapped through the part transform into root coordinates.
  renderPose();
  for (const part of doc.parts) {
    const needsSeed = part.pivotHint || (part.pivot.x === 0 && part.pivot.y === 0);
    if (!needsSeed) continue;
    const g = ctx.partGroups.get(part.id)?.[0];
    if (!g) continue;
    // Union bbox across every run (identical to `g.getBBox()` when the part has only
    // one, the pre-U2 shape) — falls back to the same {0,0,0,0} an empty single group
    // would have returned for a partless part, so a bone/group still seeds its pivot at
    // its own local origin mapped into root space exactly as before.
    const box = partOwnBBox(part.id) ?? { x: 0, y: 0, width: 0, height: 0 };
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
