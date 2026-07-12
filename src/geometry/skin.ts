/**
 * Linear-blend skinning helpers (pure math — the canvas does the per-frame DOM work).
 *
 * Weights are automatic: for every geometry point, each bound bone contributes by
 * inverse-square distance to its BIND-TIME segment (origin → tip), normalized across
 * the bones. Points sitting on a bone get (almost) all of its weight; points between
 * two bones blend smoothly — the classic cheap auto-weighting.
 */

import type { RigPart } from '../core/model';

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
 * Whether a bone segment overlaps an axis-aligned box (Liang–Barsky clip). Pure —
 * unit-testable.
 *
 * LEGACY: this was Bones 2.0's auto-bind targeting test, but a bounding box is far too
 * eager — a shoulder joint sits inside the body's box, so an arm bone dragged the whole
 * body in. Auto-bind now hit-tests the chain against each part's actual FILLED geometry
 * (`view/rigOps.ts` `chainFillCoverage`, via the live DOM `isPointInFill`). Kept as a
 * self-contained clip helper; no longer wired into binding.
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

// ---- Group-level auto-bind targeting (pure, unit-testable) ----
//
// The functions below decide WHICH art parts a placed bone chain should skin, given the
// object the chain "lives under". They are pure over a `parts` array (mirroring
// `boneChain` above them in spirit) rather than reading the live `state.doc`, so the
// targeting logic itself is unit-testable without a DOM/canvas — `view/rigOps.ts`'s
// `autoBindPlacedBone` calls them against the live doc.

/**
 * Every ART descendant of `part` at any depth (excludes `part` itself), with paths of its
 * own — mirrors `view/pose.ts`'s `groupDescendants` (the same any-kind subtree walk
 * against the live doc), filtered down to bindable art. Cycle-safe.
 */
export function artDescendantsOf(parts: RigPart[], part: RigPart): RigPart[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const isUnder = (p: RigPart): boolean => {
    const seen = new Set<string>();
    let cur: RigPart | undefined = p;
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentId === part.id) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };
  return parts.filter((p) => p.kind === 'art' && p.paths.length > 0 && isUnder(p));
}

/**
 * Expand one auto-bind TARGET — a selected part, or the object a bone chain's root hangs
 * under — into the full set of art parts a chain placed under it should skin (Group-level
 * auto-bind, completing the strict-hierarchy design "multi-object cases group first"): a
 * part with CHILD ART — kind 'group', or an art part whose own descendants include
 * further art (Pip's nested body-in-body: an outer "body" carrying its own "shadow" path,
 * with a nested "body" carrying the pill/red/outline paths) — expands to every art
 * descendant PLUS itself if it has paths of its own. A plain leaf art part (no descendant
 * art) resolves to just itself; anything else (a bone, an empty group) resolves to
 * nothing.
 */
export function expandBindTarget(parts: RigPart[], part: RigPart): RigPart[] {
  const self = part.kind === 'art' && part.paths.length > 0 ? [part] : [];
  const descendants = artDescendantsOf(parts, part);
  if (part.kind !== 'group' && descendants.length === 0) return self;
  const seen = new Map<string, RigPart>();
  for (const p of [...self, ...descendants]) seen.set(p.id, p);
  return [...seen.values()];
}

/**
 * The part a bone chain's ROOT bone is parented to (the object the chain "lives under",
 * hierarchy-as-assignment) — resolved from the CHAIN itself rather than current
 * selection, so a later pen-tool session extending the chain (with one of the chain's own
 * BONES selected as the continuation anchor, not the original group/art) still
 * re-resolves the same target. Null for a free-standing chain (no parent) or a dangling
 * parent reference.
 */
export function chainAnchorPart(parts: RigPart[], chain: RigPart[]): RigPart | null {
  const chainIds = new Set(chain.map((b) => b.id));
  const root = chain.find((b) => !b.parentId || !chainIds.has(b.parentId));
  if (!root?.parentId) return null;
  return parts.find((p) => p.id === root.parentId) ?? null;
}
