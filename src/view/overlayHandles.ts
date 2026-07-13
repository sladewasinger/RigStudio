/**
 * Selection-box + Inkscape-style handle chrome: the dashed transform box drawn under
 * every selected part (art's own rendered bbox, or a group's root-space union AABB),
 * the primary selection's scale/rotate/skew handle sets (or Animate's translate/rotate
 * pair), and the skinned-part "posed by its bones" label. Split out of overlay.ts's
 * render loop (CLAUDE.md "Small, focused files") — pure chrome-building, no top-level
 * orchestration.
 */

import { ctx, SVG_NS } from './context';
import { state, selectedParts, isEffectivelyHidden } from '../core/model';
import { groupUnionBox } from './pose';

/** The 4 corner rotate-handle circles of the Inkscape-style rotate/skew handle set —
 *  shared between Edit's rotate+skew set and Animate's rotate-only set (bug fix: the
 *  second gizmo click must be visible in Animate too, not just internally flip a mode
 *  flag with the box looking unchanged). */
function appendRotateCorners(
  handles: SVGGElement, x0: number, y0: number, x1: number, y1: number, size: number,
): void {
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
}

/**
 * Dashed transform boxes + Inkscape-style handles for every selected part. ART parts
 * use their own rendered bbox (part-local boxTransform); GROUPS are partless (no
 * artwork of their own — CLAUDE.md), so they use the root-space union AABB of their
 * descendants' rendered boxes instead (groupUnionBox — the same box the dashed group
 * outline always drew) and, for the PRIMARY selection, the identical scale/rotate
 * handle sets an art part gets (minus skew — groups have no shear field): first click
 * = 8 scale handles (a DISTRIBUTED rest edit across every descendant, rigOps.ts's
 * applyGroupScale, the flipSelected family generalized to scale), second click = 4
 * rotate corners (the group's OWN rest.rotate, which genuinely propagates through the
 * pose chain). Per the visible-counterpart GOTCHA, the handle-set toggle must render
 * something different for every selectable KIND — groups used to draw only the
 * passive dashed box with no way to tell scale mode from rotate mode.
 */
export function renderSelectionHandles(rootTransform: string, size: number, setup: boolean): void {
  if (!ctx.overlay) return;
  for (const part of selectedParts()) {
    // Layers eye: a hidden part stays selectable via Layers (the inspector still shows
    // its fields) but draws NOTHING on canvas — no box, no handles.
    if (isEffectivelyHidden(part)) continue;
    const isGroup = part.kind === 'group';
    const g = ctx.partGroups.get(part.id);
    let box: { x: number; y: number; width: number; height: number };
    let boxTransform: string;
    if (isGroup) {
      const ub = groupUnionBox(part);
      if (!ub) continue; // nothing inside yet — nothing to box or handle
      box = { x: ub.x0, y: ub.y0, width: ub.x1 - ub.x0, height: ub.y1 - ub.y0 };
      boxTransform = rootTransform; // union bbox is already root-space
    } else {
      if (!g || part.paths.length === 0) continue;
      const partTransform = g.getAttribute('transform') ?? '';
      boxTransform = [rootTransform, partTransform].filter(Boolean).join(' ');
      box = g.getBBox();
    }
    const primary = part.id === state.selectedPartId;
    const pad = size * (isGroup ? 0.8 : 0.6);
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
    ctx.overlay.appendChild(boxHolder);

    if (!primary) continue;

    if (part.skin) {
      // Skinned parts get a box but NO scale/rotate handles — those would be lies, since
      // the geometry follows its bones, not a group transform. A small label says so, so
      // the click never dead-ends silently ("why can't I grab a handle?"). A skinned part
      // renders with an empty group transform, so boxTransform is axis-aligned root space.
      // (Groups are never skinned — bindPartsToBones only ever targets art parts.)
      const hint = document.createElementNS(SVG_NS, 'text');
      hint.setAttribute('x', String(x0));
      hint.setAttribute('y', String(y0 - size * 0.6));
      hint.setAttribute('class', 'skin-hint');
      hint.setAttribute('font-size', String(size * 1.5));
      hint.textContent = 'posed by its bones';
      const wrap = document.createElementNS(SVG_NS, 'g');
      wrap.setAttribute('class', 'overlay-passive');
      wrap.setAttribute('transform', boxTransform);
      wrap.appendChild(hint);
      ctx.overlay.appendChild(wrap);
    }

    if (setup && !part.skin) {
      // Interactive Inkscape-style handles for the primary part.
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (ctx.handleMode === 'scale') {
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
        // Inkscape's second handle set: corners rotate, sides SKEW — groups skip the
        // skew sides entirely (no shear field), so their set is rotate-corners-only;
        // still visibly distinct from the 8-square scale set (the GOTCHA's bar).
        appendRotateCorners(handles, x0, y0, x1, y1, size);
        if (!isGroup) {
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
      }
      ctx.overlay.appendChild(handles);
    } else if (!setup && !part.skin && ctx.handleMode === 'rotate') {
      // Animate's second click (bug fix): the mode flip from translate to rotate was
      // invisible — the dashed box looked identical, so the user couldn't tell a body
      // drag now rotates instead of moves. Render the same 4 rotate-handle corners as
      // Edit's rotate set (interactions.ts routes their drag through the same
      // setup-aware rotate pipeline, keying instead of writing rest) but WITHOUT the
      // skew sides — skew has no keyable channel in Animate (groups match art parts
      // here exactly: same corners, keying the group's OWN rotate channel).
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      appendRotateCorners(handles, x0, y0, x1, y1, size);
      ctx.overlay.appendChild(handles);
    } else {
      // Animate's first click (translate/scale set) — scale isn't keyable, so this
      // stays the plain dashed box with passive corner markers (drag the body to
      // translate/key); also the fallback for skinned parts in either mode.
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
      ctx.overlay.appendChild(boxCorners);
    }
  }
}
