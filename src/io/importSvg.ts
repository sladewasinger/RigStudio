/**
 * Imports an SVG file into a RigDoc.
 *
 * Rules:
 * - Inkscape layers are unwrapped; each remaining top-level element becomes a RigPart.
 * - EVERY <g>, at ANY depth, becomes its own RigPart, parented to its immediate
 *   enclosing group's part (or root-level if it has none). Nothing dissolves — an
 *   Illustrator/Inkscape wrapper group with no inkscape:label still becomes a real part
 *   (label falls back to its id, or a freshly minted one), exactly like today's
 *   top-level behavior, just recursive. Users rename/reorganize the resulting parts in
 *   the editor afterward; this importer's job is to preserve the authored structure
 *   losslessly, not to guess at which groups the artist "meant" as rig parts.
 * - DOC-SPACE INVARIANT: a part's baked `transform` is the FULL composed chain from the
 *   SVG root — every ancestor group's own transform, in document order, plus its own —
 *   not just its own local transform. This has to hold because parenting only composes
 *   POSE at render time (view/pose.ts's `groupTransformOf`: ancestors' pose transforms,
 *   then the part's OWN pose, then the part's OWN baked `transform` — an ancestor's
 *   baked transform never cascades). A part's pivot is recovered from this same full
 *   composed matrix (`rotationPivotOf`), so a nested joint resolves correctly regardless
 *   of depth. For a top-level part this collapses to exactly the old behavior (no
 *   ancestors → full chain == its own transform).
 * - A part's own PATHS are its DIRECT drawable children only (a further-nested <g> is
 *   never folded into a path's transform — it is always its own part instead, per the
 *   rule above). A path's `transform` is therefore just its own `transform` attribute.
 * - A group ALWAYS becomes a part, even with zero direct drawable content (kind
 *   'group', partless — mirrors how the app's own Ctrl+G groups are represented) — it
 *   is never silently dropped. A group with at least one direct path is kind 'art'
 *   (paths and child parts can coexist: a part can have both, matching bone/group parts
 *   elsewhere in the model).
 * - Sibling paint order: `doc.parts` is populated depth-first in document order (a part
 *   is registered the moment its group is discovered, before its own children are
 *   walked), matching the existing "doc.parts order = paint order, last = topmost"
 *   convention as closely as a flat part list can. LIMITATION: a part's own paths and
 *   its child parts cannot be perfectly interleaved in paint order this way (SVG allows
 *   a group's content and a nested group to interleave freely; the part model paints a
 *   part's paths together as one unit at the part's position) — this is a known,
 *   accepted approximation, not something to try to solve here.
 * - <ellipse>/<circle>/<rect> are converted to <path> data so everything downstream
 *   deals with one shape kind.
 * - Pivots are seeded from the artwork wherever possible, in order of preference:
 *   1. a FULL composed transform chain that resolves to a pure rotation (rotate(a,cx,cy)
 *      or the matrix(...) Inkscape rewrites it into) — its fixed point is the joint;
 *   2. inkscape:transform-center-x/y — where the artist parked Inkscape's rotation
 *      crosshair, stored as an offset from the bbox center with +y UP. The bbox isn't
 *      measurable until layout, so this becomes a pivotHint the canvas resolves.
 *   3. otherwise the canvas falls back to the rendered bbox center.
 * - Gradient fills (`fill: url(#...)`) are passed through verbatim as an opaque fill
 *   string, same as before nesting support — gradients are not otherwise interpreted
 *   (tracked separately as a v3 item).
 */

import { PivotHint, RigDoc, RigPart, RigPath, freshId } from '../core/model';
import { rotationPivotOf } from '../geometry/transforms';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const SODIPODI_NS = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';

export function importSvg(svgText: string, name: string): RigDoc {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.nodeName !== 'svg') throw new Error('Not an SVG document');

  const viewBox = parseViewBox(svg);

  // Unwrap Inkscape layers: their children are the real top-level elements.
  let roots: Element[] = Array.from(svg.children).filter(isDrawable);
  const unwrapped: Element[] = [];
  for (const el of roots) {
    if (el.tagName === 'g' && el.getAttributeNS(INKSCAPE_NS, 'groupmode') === 'layer') {
      unwrapped.push(...Array.from(el.children).filter(isDrawable));
    } else {
      unwrapped.push(el);
    }
  }
  roots = unwrapped;

  const parts: RigPart[] = [];
  for (const el of roots) walkTopLevel(el, parts);
  if (parts.length === 0) throw new Error('No drawable groups or shapes found');

  return {
    name: name.replace(/\.svg$/i, ''),
    viewBox,
    parts,
    rootPivot: { x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h * 0.8 },
    clips: [{ name: 'idle', duration: 2000, tracks: [] }],
  };
}

function isDrawable(el: Element): boolean {
  return ['g', 'path', 'ellipse', 'circle', 'rect'].includes(el.tagName);
}

/** Display label: inkscape:label if present, else the element's id, else a fresh one —
 *  the same fallback chain at every depth (users rename in the editor afterward). */
function labelOf(el: Element): string {
  return (
    el.getAttributeNS(INKSCAPE_NS, 'label') ??
    el.getAttribute('inkscape:label') ??
    el.getAttribute('id') ??
    freshId('part')
  );
}

/** A fresh RigPart shell, registered into `parts` immediately so draw order matches
 *  document discovery order (depth-first pre-order = paint order). */
function registerPart(
  el: Element, transform: string, parentId: string | null, parts: RigPart[],
): RigPart {
  // Pivot is recovered from the FULL composed chain (`transform` here is already that
  // chain, not just the element's own local transform — see the doc-space invariant).
  const rotationPivot = rotationPivotOf(transform);
  const pivot = rotationPivot ?? { x: 0, y: 0 };
  const pivotHint = rotationPivot ? null : transformCenterHint(el);

  const part: RigPart = {
    id: freshId('part'), label: labelOf(el), kind: 'art', transform, pivot, pivotHint,
    paths: [],
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
    parentId,
  };
  parts.push(part);
  return part;
}

/** Top-level element (post layer-unwrap): always becomes a part. */
function walkTopLevel(el: Element, parts: RigPart[]): void {
  if (el.tagName === 'g') {
    walkGroup(el, '', null, parts);
  } else {
    const p = shapeToPath(el, el.getAttribute('transform') ?? '');
    if (!p) return;
    const part = registerPart(el, '', null, parts);
    part.paths.push(p);
  }
}

/**
 * Turn a <g> into a RigPart and recurse: every nested <g> becomes its own child part
 * (parented to this one), every other drawable child becomes one of THIS part's direct
 * paths. `docAccum` is the full transform chain from the SVG root down to (but not
 * including) `el`'s own transform — composed with `el`'s own transform, it seeds the
 * new part's full doc-space `transform` (see the doc-space invariant in the file
 * header) and is threaded down unchanged as the next level's `docAccum`.
 */
function walkGroup(el: Element, docAccum: string, parentId: string | null, parts: RigPart[]): void {
  const own = el.getAttribute('transform') ?? '';
  const fullTransform = joinTransforms(docAccum, own);
  const part = registerPart(el, fullTransform, parentId, parts);
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'g') {
      walkGroup(child, fullTransform, part.id, parts);
    } else if (isDrawable(child)) {
      const p = shapeToPath(child, child.getAttribute('transform') ?? '');
      if (p) part.paths.push(p);
    }
  }
  part.kind = part.paths.length > 0 ? 'art' : 'group';
}

/**
 * Inkscape stores the rotation crosshair as inkscape:transform-center-x/y: an offset
 * from the object's bbox center in user units with +y pointing UP (legacy axis), so the
 * y offset flips sign to land in SVG's +y-down document space.
 */
function transformCenterHint(el: Element): PivotHint | null {
  const cx =
    el.getAttributeNS(INKSCAPE_NS, 'transform-center-x') ??
    el.getAttribute('inkscape:transform-center-x');
  const cy =
    el.getAttributeNS(INKSCAPE_NS, 'transform-center-y') ??
    el.getAttribute('inkscape:transform-center-y');
  if (cx === null && cy === null) return null;
  return { kind: 'centerOffset', dx: parseFloat(cx ?? '0'), dy: -parseFloat(cy ?? '0') };
}

function joinTransforms(a: string, b: string): string {
  return [a, b].filter((s) => s.trim().length > 0).join(' ');
}

function shapeToPath(el: Element, transform: string): RigPath | null {
  let d: string | null = null;
  switch (el.tagName) {
    case 'path':
      d = el.getAttribute('d');
      break;
    case 'ellipse':
    case 'circle': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.tagName === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = el.tagName === 'circle' ? num(el, 'r') : num(el, 'ry');
      d = `M ${cx - rx},${cy} a ${rx},${ry} 0 1 0 ${2 * rx},0 a ${rx},${ry} 0 1 0 ${-2 * rx},0 Z`;
      break;
    }
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y');
      const w = num(el, 'width'), h = num(el, 'height');
      d = `M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z`;
      break;
    }
  }
  if (!d) return null;

  const style = styleMap(el);
  const attr = (name: string) => el.getAttribute(name) ?? style.get(name) ?? null;

  const fillRaw = attr('fill');
  const strokeRaw = attr('stroke');
  return {
    id: freshId('path'),
    label:
      el.getAttributeNS(INKSCAPE_NS, 'label') ??
      el.getAttribute('inkscape:label') ??
      el.getAttribute('id') ??
      'shape',
    // Inkscape's per-node type flags survive the trip (normalization keeps the node
    // count: H/V/S/T/Q expand 1:1, arcs stay arcs). Shapes have no authored nodes.
    nodeTypes:
      el.tagName === 'path'
        ? (el.getAttributeNS(SODIPODI_NS, 'nodetypes') ??
           el.getAttribute('sodipodi:nodetypes'))
        : null,
    d,
    // Gradient fills (url(#...)) pass through verbatim, same as any other fill string —
    // this importer does not resolve gradient stops (tracked separately, v3).
    fill: fillRaw === 'none' ? null : (fillRaw ?? '#000000'),
    fillOpacity: parseFloat(attr('fill-opacity') ?? '1'),
    stroke: strokeRaw && strokeRaw !== 'none' ? strokeRaw : null,
    strokeWidth: parseFloat(attr('stroke-width') ?? '1'),
    strokeOpacity: parseFloat(attr('stroke-opacity') ?? '1'),
    transform,
  };
}

function styleMap(el: Element): Map<string, string> {
  const map = new Map<string, string>();
  const style = el.getAttribute('style');
  if (!style) return map;
  for (const rule of style.split(';')) {
    const [k, v] = rule.split(':');
    if (k && v) map.set(k.trim(), v.trim());
  }
  return map;
}

function num(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? '0');
}

function parseViewBox(svg: Element): { x: number; y: number; w: number; h: number } {
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const [x, y, w, h] = vb.split(/[\s,]+/).map(Number);
    return { x, y, w, h };
  }
  const w = parseFloat(svg.getAttribute('width') ?? '100');
  const h = parseFloat(svg.getAttribute('height') ?? '100');
  return { x: 0, y: 0, w, h };
}
