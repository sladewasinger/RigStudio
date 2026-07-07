/**
 * Tests for the analytic IK solver and the skinning weight math.
 */

import { describe, expect, it } from 'vitest';
import { solveAim, solveTwoBone, Pt } from '../ik';
import { distToSegment, skinWeights } from '../skin';

/** Rotate `p` around `c` by deg (screen convention: +deg clockwise, +y down). */
function rot(p: Pt, c: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return {
    x: c.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: c.y + dx * Math.sin(r) + dy * Math.cos(r),
  };
}

describe('solveAim', () => {
  it('returns the signed angle that swings E onto the ray A→T', () => {
    const a = { x: 0, y: 0 };
    const e = { x: 10, y: 0 };
    expect(solveAim(a, e, { x: 0, y: 10 })).toBeCloseTo(90, 6); // +y is "down" → CW
    expect(solveAim(a, e, { x: 0, y: -10 })).toBeCloseTo(-90, 6);
    expect(solveAim(a, e, { x: 10, y: 0 })).toBeCloseTo(0, 6);
  });

  it('normalizes to (-180, 180]', () => {
    const a = { x: 0, y: 0 };
    const e = { x: 10, y: 0 };
    const d = solveAim(a, e, { x: -10, y: -0.001 });
    expect(d).toBeLessThanOrEqual(180);
    expect(d).toBeGreaterThan(-180);
  });
});

describe('solveTwoBone', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  const e = { x: 10, y: 10 }; // elbow bent 90°, links 10 and 10

  /** Apply the returned deltas the way the canvas does and return the new effector. */
  function forward(deltas: { delta1: number; delta2: number }): Pt {
    const b2 = rot(b, a, deltas.delta1);
    // Link 2 rides link 1: its rotation is delta1 + delta2 around the NEW elbow.
    const e1 = rot(e, a, deltas.delta1); // effector after link-1 swing
    return rot(e1, b2, deltas.delta2);
  }

  it('reaches an in-range target exactly', () => {
    const t = { x: 4, y: 12 };
    const out = forward(solveTwoBone(a, b, e, t));
    expect(out.x).toBeCloseTo(t.x, 4);
    expect(out.y).toBeCloseTo(t.y, 4);
  });

  it('clamps an out-of-reach target to full extension along A→T', () => {
    const t = { x: 100, y: 0 };
    const out = forward(solveTwoBone(a, b, e, t));
    // Fully extended chain has length ~20 toward +x.
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(20, 1);
    expect(out.y / 20).toBeCloseTo(0, 2);
  });

  it('preserves the current bend direction', () => {
    // Current elbow bends +y (cross > 0). Solving to a symmetric target must keep
    // the elbow on the same side rather than snapping through.
    const t = { x: 14, y: 6 };
    const d = solveTwoBone(a, b, e, t);
    const b2 = rot(b, a, d.delta1);
    const out = forward(d);
    const cross = (b2.x - a.x) * (out.y - b2.y) - (b2.y - a.y) * (out.x - b2.x);
    expect(cross).toBeGreaterThan(0);
  });

  it('degenerate zero-length links fall back to aiming', () => {
    const d = solveTwoBone(a, a, e, { x: 0, y: 5 });
    expect(d.delta2).toBe(0);
    expect(Number.isFinite(d.delta1)).toBe(true);
  });
});

describe('skin weights', () => {
  it('distToSegment measures perpendicular and endpoint distances', () => {
    const seg = { p: { x: 0, y: 0 }, q: { x: 10, y: 0 } };
    expect(distToSegment({ x: 5, y: 3 }, seg)).toBeCloseTo(3, 9);
    expect(distToSegment({ x: -4, y: 0 }, seg)).toBeCloseTo(4, 9);
    expect(distToSegment({ x: 13, y: 4 }, seg)).toBeCloseTo(5, 9);
    // Degenerate segment behaves as a point.
    expect(distToSegment({ x: 3, y: 4 }, { p: { x: 0, y: 0 }, q: { x: 0, y: 0 } })).toBeCloseTo(5, 9);
  });

  it('weights normalize to 1 and favor the nearest bone', () => {
    const segs = [
      { p: { x: 0, y: 0 }, q: { x: 10, y: 0 } },
      { p: { x: 0, y: 20 }, q: { x: 10, y: 20 } },
    ];
    const [w] = skinWeights([{ x: 5, y: 2 }], segs);
    expect(w[0] + w[1]).toBeCloseTo(1, 9);
    expect(w[0]).toBeGreaterThan(w[1]);
    // A point ON a bone is dominated by it.
    const [on] = skinWeights([{ x: 5, y: 0 }], segs);
    expect(on[0]).toBeGreaterThan(0.95);
    // Equidistant points split evenly.
    const [mid] = skinWeights([{ x: 5, y: 10 }], segs);
    expect(mid[0]).toBeCloseTo(0.5, 6);
  });
});
