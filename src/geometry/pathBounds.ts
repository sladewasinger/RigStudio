/**
 * Pure path-geometry bounding-box math — the repo's first DOM-free bbox walk. Neither
 * exporter ever needed bounds (they flatten geometry point-by-point), and the editor
 * measures live `getBBox()` boxes, which has no headless equivalent. The motivating
 * consumer is `core/partHierarchy.ts`'s group-pivot default: a group minted around
 * members by a HEADLESS caller (scripts/agents on the headless facade, MCP tool bodies)
 * needs the members' geometry bbox center with no canvas to measure — a junk default
 * pivot makes every later rotation orbit a point far off the artwork (the 2026-07-14
 * "Girl orbits a point below the figure" defect).
 *
 * EXACT, matching `getBBox`'s geometry-only semantics: arcs convert through
 * `pathToCubics` (the same conversion both exporters trust) and cubic interior extrema
 * are solved analytically per axis, so a control point outside its curve never inflates
 * the box; strokes don't count, exactly like `getBBox`. Affine transforms commute with
 * Bezier combination — the transformed curve IS the Bezier of the transformed control
 * points — so mapping control points through `matrix` BEFORE taking extrema stays exact.
 *
 * LAYERING: this module must stay free of `core/` imports — `core/partHierarchy.ts`
 * calls it, so anything here reaching back into core (even the model facade, which
 * re-exports partHierarchy) would cycle. It speaks raw `d` strings and `Mat`s only.
 */

import { parsePath, pathToCubics } from './paths';
import { Mat, applyMat } from './transforms';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Union of two bounds; null acts as the empty box (identity of the union). */
export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function boundsCenter(bounds: Bounds): { x: number; y: number } {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/**
 * Interior parameters (0 < t < 1) where one axis of a cubic Bezier reaches an extremum:
 * roots of the derivative B'(t)/3 = at² + bt + c. Endpoints are the caller's job (it
 * grows the box with every command endpoint anyway).
 */
function cubicAxisExtremaParameters(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    // Degenerate quadratic term: the derivative is linear (b t + c).
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtDiscriminant = Math.sqrt(discriminant);
      roots.push((-b + sqrtDiscriminant) / (2 * a), (-b - sqrtDiscriminant) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function cubicAxisValue(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Exact bounds of a path's drawn geometry mapped through an affine matrix, or null when
 * the data yields no coordinates at all (empty/unparseable `d`). Every command endpoint
 * grows the box (including a bare M — a degenerate point still has a location, matching
 * getBBox); cubics additionally contribute their interior axis extrema; Z only returns
 * to the subpath start (both endpoints already counted). Arcs never reach the loop —
 * `pathToCubics` rewrites them first.
 */
export function pathBoundsThroughMatrix(d: string, matrix: Mat): Bounds | null {
  let bounds: Bounds | null = null;
  const growPoint = (x: number, y: number): void => {
    bounds = unionBounds(bounds, { minX: x, minY: y, maxX: x, maxY: y });
  };
  const growAxis = (axis: 'x' | 'y', v: number): void => {
    if (!bounds) return; // unreachable in practice: the segment's endpoints grew it first
    if (axis === 'x') {
      bounds.minX = Math.min(bounds.minX, v);
      bounds.maxX = Math.max(bounds.maxX, v);
    } else {
      bounds.minY = Math.min(bounds.minY, v);
      bounds.maxY = Math.max(bounds.maxY, v);
    }
  };

  // Current point and subpath start, already TRANSFORMED (extrema must be taken on the
  // transformed control polygon — see the module doc comment for why that is exact).
  let current = applyMat(matrix, 0, 0);
  let subpathStart = current;

  for (const cmd of pathToCubics(parsePath(d))) {
    if (cmd.cmd === 'Z') {
      current = subpathStart;
      continue;
    }
    if (cmd.cmd === 'M' || cmd.cmd === 'L') {
      const p = applyMat(matrix, cmd.x, cmd.y);
      growPoint(p.x, p.y);
      current = p;
      if (cmd.cmd === 'M') subpathStart = p;
      continue;
    }
    if (cmd.cmd === 'C') {
      const p1 = applyMat(matrix, cmd.x1, cmd.y1);
      const p2 = applyMat(matrix, cmd.x2, cmd.y2);
      const p3 = applyMat(matrix, cmd.x, cmd.y);
      growPoint(p3.x, p3.y);
      for (const t of cubicAxisExtremaParameters(current.x, p1.x, p2.x, p3.x)) {
        growAxis('x', cubicAxisValue(t, current.x, p1.x, p2.x, p3.x));
      }
      for (const t of cubicAxisExtremaParameters(current.y, p1.y, p2.y, p3.y)) {
        growAxis('y', cubicAxisValue(t, current.y, p1.y, p2.y, p3.y));
      }
      current = p3;
    }
    // 'A' is unreachable after pathToCubics.
  }
  return bounds;
}
