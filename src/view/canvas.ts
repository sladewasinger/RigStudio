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

import { state } from '../core/model';
import { ctx, SVG_NS } from './context';
import { svgPoint } from './coords';
import { renderPose } from './render';
import { applyPathAttrs } from './partDom';
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
