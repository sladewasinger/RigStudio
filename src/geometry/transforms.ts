/**
 * SVG transform-list parsing. Used both to seed pivots on import (a group authored as
 * rotate(a, cx, cy) has its joint at (cx, cy)) and to bake equivalent transforms into
 * exported geometry.
 */

export type SvgTransform =
  | { type: 'translate'; tx: number; ty: number }
  | { type: 'scale'; sx: number; sy: number }
  | { type: 'rotate'; angle: number; cx: number; cy: number }
  | { type: 'skewX'; angle: number }
  | { type: 'skewY'; angle: number }
  | { type: 'matrix'; a: number; b: number; c: number; d: number; e: number; f: number };

const FN_RE = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;

export function parseTransformList(value: string | null | undefined): SvgTransform[] {
  const out: SvgTransform[] = [];
  if (!value) return out;
  for (const match of value.matchAll(FN_RE)) {
    const fn = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    switch (fn) {
      case 'translate':
        out.push({ type: 'translate', tx: args[0] ?? 0, ty: args[1] ?? 0 });
        break;
      case 'scale':
        out.push({ type: 'scale', sx: args[0] ?? 1, sy: args[1] ?? args[0] ?? 1 });
        break;
      case 'rotate':
        out.push({ type: 'rotate', angle: args[0] ?? 0, cx: args[1] ?? 0, cy: args[2] ?? 0 });
        break;
      case 'skewX':
        out.push({ type: 'skewX', angle: args[0] ?? 0 });
        break;
      case 'skewY':
        out.push({ type: 'skewY', angle: args[0] ?? 0 });
        break;
      case 'matrix':
        out.push({
          type: 'matrix',
          a: args[0] ?? 1, b: args[1] ?? 0, c: args[2] ?? 0,
          d: args[3] ?? 1, e: args[4] ?? 0, f: args[5] ?? 0,
        });
        break;
    }
  }
  return out;
}

// ---- Affine matrix utilities ----
// SVG matrix layout: x' = a·x + c·y + e, y' = b·x + d·y + f.

export interface Mat {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** m1 ∘ m2 — apply m2 first, then m1 (matches SVG transform-list order left-to-right). */
export function multiply(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function applyMat(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function translationMat(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function rotationMat(deg: number, cx = 0, cy = 0): Mat {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  // rotate(a,cx,cy) = translate(cx,cy) rotate(a) translate(-cx,-cy)
  return {
    a: cos, b: sin, c: -sin, d: cos,
    e: cx - cos * cx + sin * cy,
    f: cy - sin * cx - cos * cy,
  };
}

export function invertMat(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  return {
    a: m.d / det, b: -m.b / det,
    c: -m.c / det, d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

function matOfOne(t: SvgTransform): Mat {
  switch (t.type) {
    case 'translate': return translationMat(t.tx, t.ty);
    case 'scale': return { a: t.sx, b: 0, c: 0, d: t.sy, e: 0, f: 0 };
    case 'rotate': return rotationMat(t.angle, t.cx, t.cy);
    case 'skewX': return { a: 1, b: 0, c: Math.tan((t.angle * Math.PI) / 180), d: 1, e: 0, f: 0 };
    case 'skewY': return { a: 1, b: Math.tan((t.angle * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    case 'matrix': return { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f };
  }
}

/** Compose a whole SVG transform list into a single matrix (left-to-right application). */
export function matrixOfTransform(value: string | null | undefined): Mat {
  let m = IDENTITY;
  for (const t of parseTransformList(value)) m = multiply(m, matOfOne(t));
  return m;
}

/**
 * The fixed point of a transform list, if its composed matrix is a pivoted rigid
 * rotation. Inkscape freely rewrites rotate(a,cx,cy) as matrix(...), so checking the
 * composed matrix — rather than the syntax — recovers pivots from either spelling.
 * Reflections (det < 0, e.g. a mirrored limb) and scales are rejected: their fixed
 * points are not joints.
 */
export function rotationPivotOf(value: string | null | undefined): { x: number; y: number } | null {
  const m = matrixOfTransform(value);
  const EPS = 1e-4;
  const isRigidRotation =
    Math.abs(m.a - m.d) < EPS &&
    Math.abs(m.b + m.c) < EPS &&
    Math.abs(m.a * m.a + m.b * m.b - 1) < EPS;
  if (!isRigidRotation) return null;
  // (A - I) p = -t has a unique solution iff the rotation angle is non-trivial.
  const det = (m.a - 1) * (m.d - 1) - m.b * m.c;
  if (Math.abs(det) < 1e-9) return null; // identity/translation-only: no pivot to recover
  const x = (-(m.d - 1) * m.e + m.c * m.f) / det;
  const y = (m.b * m.e - (m.a - 1) * m.f) / det;
  return { x, y };
}
