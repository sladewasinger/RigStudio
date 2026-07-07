/**
 * Linear-blend skinning helpers (pure math — the canvas does the per-frame DOM work).
 *
 * Weights are automatic: for every geometry point, each bound bone contributes by
 * inverse-square distance to its BIND-TIME segment (origin → tip), normalized across
 * the bones. Points sitting on a bone get (almost) all of its weight; points between
 * two bones blend smoothly — the classic cheap auto-weighting.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Seg {
  p: Pt;
  q: Pt;
}

/** Distance from a point to a segment (degenerate segments behave as points). */
export function distToSegment(pt: Pt, seg: Seg): number {
  const dx = seg.q.x - seg.p.x;
  const dy = seg.q.y - seg.p.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(pt.x - seg.p.x, pt.y - seg.p.y);
  let t = ((pt.x - seg.p.x) * dx + (pt.y - seg.p.y) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(pt.x - (seg.p.x + t * dx), pt.y - (seg.p.y + t * dy));
}

/**
 * Normalized inverse-square-distance weights: one row per point, one column per
 * bone segment. Rows always sum to 1 (a point exactly on a bone gets ~1 for it).
 */
export function skinWeights(points: Pt[], segs: Seg[]): number[][] {
  const EPS = 0.25; // softens the singularity on the bone itself
  return points.map((pt) => {
    const raw = segs.map((s) => 1 / Math.pow(distToSegment(pt, s) + EPS, 2));
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map((w) => w / sum);
  });
}
