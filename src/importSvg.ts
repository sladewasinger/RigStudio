/**
 * Imports an SVG file into a RigDoc.
 *
 * Rules:
 * - Inkscape layers are unwrapped; each remaining top-level element becomes a RigPart.
 * - Part labels come from inkscape:label, falling back to the element id.
 * - Groups keep their transform verbatim; nested paths accumulate the transforms of any
 *   groups between the part group and the path.
 * - <ellipse>/<circle>/<rect> are converted to <path> data so everything downstream
 *   deals with one shape kind.
 * - Pivots are seeded from the artwork wherever possible, in order of preference:
 *   1. a group transform that composes to a pure rotation (rotate(a,cx,cy) or the
 *      matrix(...) Inkscape rewrites it into) — its fixed point is the joint;
 *   2. inkscape:transform-center-x/y — where the artist parked Inkscape's rotation
 *      crosshair, stored as an offset from the bbox center with +y UP. The bbox isn't
 *      measurable until layout, so this becomes a pivotHint the canvas resolves.
 *   3. otherwise the canvas falls back to the rendered bbox center.
 */

import { PivotHint, RigDoc, RigPart, RigPath, freshId } from './model';
import { rotationPivotOf } from './transforms';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';

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
  for (const el of roots) {
    const part = elementToPart(el);
    if (part.paths.length > 0) parts.push(part);
  }
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

function labelOf(el: Element): string {
  return (
    el.getAttributeNS(INKSCAPE_NS, 'label') ??
    el.getAttribute('inkscape:label') ??
    el.getAttribute('id') ??
    freshId('part')
  );
}

function elementToPart(el: Element): RigPart {
  const label = labelOf(el);
  const transform = el.tagName === 'g' ? (el.getAttribute('transform') ?? '') : '';
  const paths: RigPath[] = [];

  if (el.tagName === 'g') {
    collectPaths(el, '', paths);
  } else {
    const p = shapeToPath(el, el.getAttribute('transform') ?? '');
    if (p) paths.push(p);
  }

  // Pivot: a transform that is a pure pivoted rotation names the joint exactly; else an
  // Inkscape rotation-center offset becomes a hint resolved against the rendered bbox;
  // else pivot stays at origin and the canvas falls back to the bbox center.
  const rotationPivot = rotationPivotOf(transform);
  const pivot = rotationPivot ?? { x: 0, y: 0 };
  const pivotHint = rotationPivot ? null : transformCenterHint(el);

  return {
    id: freshId('part'), label, transform, pivot, pivotHint, paths,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1 },
    parentId: null,
  };
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

/** Depth-first collect of drawable leaves, accumulating intermediate group transforms. */
function collectPaths(group: Element, inherited: string, out: RigPath[]): void {
  for (const child of Array.from(group.children)) {
    if (child.tagName === 'g') {
      const t = child.getAttribute('transform') ?? '';
      collectPaths(child, joinTransforms(inherited, t), out);
    } else if (isDrawable(child)) {
      const own = child.getAttribute('transform') ?? '';
      const p = shapeToPath(child, joinTransforms(inherited, own));
      if (p) out.push(p);
    }
  }
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
    d,
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
