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
 * Normalized inverse-distance-power weights: one row per point, one column per bone
 * segment. Rows always sum to 1 (a point exactly on a bone gets ~1 for it).
 *
 * `power` is the falloff exponent. The default 2 (inverse-square) is the classic cheap
 * auto-weight, but a long thin limb with several bones bends mushily under it — the
 * joints don't localize, so an "elbow" between two bones drifts. A sharper exponent
 * (view/skinRender.ts passes SKIN_WEIGHT_POWER) concentrates each point on its nearest
 * bone, giving crisper joint folds; the render path passes a sharper value while the
 * unit-tested default stays 2.
 */
export function skinWeights(points: Pt[], segs: Seg[], power = 2): number[][] {
  const EPS = 0.25; // softens the singularity on the bone itself
  return points.map((pt) => {
    const raw = segs.map((s) => 1 / Math.pow(distToSegment(pt, s) + EPS, power));
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map((w) => (sum > 0 ? w / sum : 1 / raw.length));
  });
}

/**
 * Whether a bone segment overlaps an axis-aligned box (Liang–Barsky clip). Used by
 * auto-bind to decide which art a freshly-placed chain deforms: a part is bound when
 * any chain segment crosses its rendered bounding box (endpoint-inside is the subset
 * where t0/t1 stay [0,1]). Pure — unit-testable.
 */
export function segIntersectsBox(
  seg: Seg, box: { x: number; y: number; w: number; h: number },
): boolean {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
  const inside = (px: number, py: number) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
  if (inside(seg.p.x, seg.p.y) || inside(seg.q.x, seg.q.y)) return true;
  const dx = seg.q.x - seg.p.x;
  const dy = seg.q.y - seg.p.y;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel to this edge — inside iff q >= 0
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, seg.p.x - x0) && clip(dx, x1 - seg.p.x) &&
    clip(-dy, seg.p.y - y0) && clip(dy, y1 - seg.p.y) &&
    t0 <= t1
  );
}

/**
 * The weight row for a manual per-node override: bone `a` at (1−t), bone `b` at t
 * (both indexed into `boneIds`). `b === null`, a missing `b`, or a dangling id collapses
 * to 100% `a`. Returns null when `a` itself is unresolvable (caller falls back to auto
 * weights). Pure — unit-testable.
 */
export function overrideWeightRow(
  boneIds: string[], ov: { a: string; b: string | null; t: number },
): number[] | null {
  const ia = boneIds.indexOf(ov.a);
  if (ia < 0) return null;
  const row = new Array(boneIds.length).fill(0);
  const t = Math.min(1, Math.max(0, ov.t));
  const ib = ov.b == null ? -1 : boneIds.indexOf(ov.b);
  if (ib < 0 || ib === ia) {
    row[ia] = 1;
  } else {
    row[ia] = 1 - t;
    row[ib] = t;
  }
  return row;
}
