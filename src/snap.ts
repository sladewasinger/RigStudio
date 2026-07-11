/**
 * Pure snapping math (no DOM, no app state) so it can be unit-tested in isolation.
 *
 * The editor snaps a single MOVING point onto the nearest CANDIDATE point within a
 * threshold: node↔node, pivot↔pivot, and a part's pivot / bbox features onto other
 * parts' pivot / bbox features. All coordinates are in one shared space (the caller
 * converts everything into it first) and the threshold is expressed in that space.
 *
 * Axis interplay: when a drag is Ctrl/gizmo axis-locked, the caller passes the FREE
 * axis so snapping only ever corrects along it — the lock is never broken. With no
 * lock (`axis = null`) the match is a full 2D coincidence.
 */

export interface SnapCandidate {
  x: number;
  y: number;
  /** Informational tag (e.g. 'pivot', 'bbox-center') — handy for debugging/markers. */
  kind?: string;
}

export interface SnapMatch {
  /** The winning candidate. */
  candidate: SnapCandidate;
  /** Where the moving point lands after snapping. */
  point: { x: number; y: number };
  /** Correction added to the moving point to reach `point` (point − p). */
  dx: number;
  dy: number;
  /** Distance the snap closed (Euclidean, or |Δaxis| when axis-locked). */
  dist: number;
}

/** Which axis is still free to move; null = both (full 2D snap). */
export type SnapAxis = 'x' | 'y' | null;

/**
 * The candidate nearest to `p` within `threshold`, or null. With `axis` set, distance
 * and the correction are measured on that axis alone (the other coordinate is left at
 * `p`'s value), so an axis-locked drag stays locked. Ties keep the first-seen nearest.
 */
export function snapPoint(
  p: { x: number; y: number },
  candidates: readonly SnapCandidate[],
  threshold: number,
  axis: SnapAxis = null,
): SnapMatch | null {
  if (!(threshold > 0)) return null;
  let best: SnapMatch | null = null;
  for (const c of candidates) {
    let point: { x: number; y: number };
    let dist: number;
    if (axis === 'x') {
      dist = Math.abs(c.x - p.x);
      point = { x: c.x, y: p.y };
    } else if (axis === 'y') {
      dist = Math.abs(c.y - p.y);
      point = { x: p.x, y: c.y };
    } else {
      dist = Math.hypot(c.x - p.x, c.y - p.y);
      point = { x: c.x, y: c.y };
    }
    if (dist > threshold) continue;
    if (!best || dist < best.dist) {
      best = { candidate: c, point, dx: point.x - p.x, dy: point.y - p.y, dist };
    }
  }
  return best;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The nine snap-able features of an axis-aligned box: its center, four corners, and
 * four edge midpoints. Callers snap these against another box's features so bbox
 * centers and edges line up.
 */
export function boxFeaturePoints(box: Box, kindPrefix = 'bbox'): SnapCandidate[] {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const x1 = x + w;
  const y1 = y + h;
  return [
    { x: cx, y: cy, kind: `${kindPrefix}-center` },
    { x, y, kind: `${kindPrefix}-corner` },
    { x: x1, y, kind: `${kindPrefix}-corner` },
    { x: x1, y: y1, kind: `${kindPrefix}-corner` },
    { x, y: y1, kind: `${kindPrefix}-corner` },
    { x: cx, y, kind: `${kindPrefix}-edge` },
    { x: x1, y: cy, kind: `${kindPrefix}-edge` },
    { x: cx, y: y1, kind: `${kindPrefix}-edge` },
    { x, y: cy, kind: `${kindPrefix}-edge` },
  ];
}

/**
 * Snap a moving delta so that whichever of the `moving` feature points lands nearest a
 * `targets` feature point (within `threshold`) coincides with it exactly. Returns the
 * corrected delta plus the snapped-to target (for a marker), or the delta unchanged.
 * `axis` restricts the correction to the free axis (see snapPoint).
 */
export function snapDelta(
  moving: readonly SnapCandidate[],
  targets: readonly SnapCandidate[],
  delta: { dx: number; dy: number },
  threshold: number,
  axis: SnapAxis = null,
): { dx: number; dy: number; target: { x: number; y: number } | null } {
  let best: SnapMatch | null = null;
  for (const m of moving) {
    const moved = { x: m.x + delta.dx, y: m.y + delta.dy };
    const match = snapPoint(moved, targets, threshold, axis);
    if (match && (!best || match.dist < best.dist)) best = match;
  }
  if (!best) return { dx: delta.dx, dy: delta.dy, target: null };
  return { dx: delta.dx + best.dx, dy: delta.dy + best.dy, target: best.point };
}
