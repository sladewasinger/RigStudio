/**
 * Tests for the analytic IK solver and the skinning weight math.
 */

import { describe, expect, it } from 'vitest';
import { solveAim, solveChainIK, solveTwoBone, Pt } from '../geometry/ik';
import { distToSegment, skinWeights } from '../geometry/skin';

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The segment lengths of a joint polyline. */
function segLens(joints: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < joints.length - 1; i++) out.push(dist(joints[i], joints[i + 1]));
  return out;
}

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

describe('solveChainIK (full-chain FABRIK)', () => {
  it('reaches an in-range target exactly for 2/3/5-joint chains', () => {
    // Chains laid along +x with a slight zig so the start pose is non-degenerate.
    const chains: Pt[][] = [
      [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: -1 }], // 2 segments (3 joints)
      [{ x: 0, y: 0 }, { x: 8, y: 2 }, { x: 16, y: -2 }, { x: 24, y: 1 }], // 3 segments
      [ // 5 segments (6 joints)
        { x: 0, y: 0 }, { x: 6, y: 1 }, { x: 12, y: -1 },
        { x: 18, y: 2 }, { x: 24, y: -2 }, { x: 30, y: 0 },
      ],
    ];
    for (const joints of chains) {
      const total = segLens(joints).reduce((a, b) => a + b, 0);
      const target = { x: total * 0.4, y: total * 0.35 }; // comfortably inside reach
      const out = solveChainIK(joints, target);
      expect(dist(out[out.length - 1], target)).toBeLessThan(0.05);
    }
  });

  it('preserves every segment length to 1e-9 (reachable AND unreachable)', () => {
    const joints: Pt[] = [
      { x: 0, y: 0 }, { x: 10, y: 3 }, { x: 22, y: -4 }, { x: 30, y: 5 },
    ];
    const lens = segLens(joints);
    const total = lens.reduce((a, b) => a + b, 0);
    for (const target of [{ x: 12, y: 9 }, { x: total * 3, y: total * 2 }]) {
      const out = solveChainIK(joints, target);
      const got = segLens(out);
      for (let i = 0; i < lens.length; i++) expect(got[i]).toBeCloseTo(lens[i], 9);
    }
  });

  it('pins the root joint byte-stable', () => {
    const joints: Pt[] = [{ x: 3, y: 7 }, { x: 13, y: 7 }, { x: 23, y: 7 }];
    const out = solveChainIK(joints, { x: 8, y: 20 });
    expect(out[0]).toEqual({ x: 3, y: 7 });
  });

  it('straightens toward an unreachable target at full extension', () => {
    const joints: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const total = segLens(joints).reduce((a, b) => a + b, 0);
    const target = { x: 100, y: 100 }; // far out of reach
    const out = solveChainIK(joints, target);
    const eff = out[out.length - 1];
    // End effector at full reach from the root, along the root→target ray.
    expect(dist(out[0], eff)).toBeCloseTo(total, 6);
    const ux = (target.x - out[0].x) / dist(out[0], target);
    const uy = (target.y - out[0].y) / dist(out[0], target);
    expect(eff.x).toBeCloseTo(out[0].x + ux * total, 4);
    expect(eff.y).toBeCloseTo(out[0].y + uy * total, 4);
    // Every segment points the same way (a straight line): consecutive unit dirs equal.
    for (let i = 1; i < out.length - 1; i++) {
      const d0x = (out[i].x - out[i - 1].x), d0y = (out[i].y - out[i - 1].y);
      const d1x = (out[i + 1].x - out[i].x), d1y = (out[i + 1].y - out[i].y);
      const l0 = Math.hypot(d0x, d0y), l1 = Math.hypot(d1x, d1y);
      const cos = (d0x * d1x + d0y * d1y) / (l0 * l1);
      expect(cos).toBeCloseTo(1, 6);
    }
  });

  it('keeps the current bend direction (no flip) for a reachable nearby target', () => {
    // Elbow bent "up" (−y). A symmetric-ish reachable target must NOT snap the elbow
    // through to the mirror solution.
    const joints: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: -6 }, { x: 20, y: 0 }];
    const bendSign = (js: Pt[]) => Math.sign(
      (js[1].x - js[0].x) * (js[2].y - js[1].y) - (js[1].y - js[0].y) * (js[2].x - js[1].x),
    );
    const before = bendSign(joints);
    const out = solveChainIK(joints, { x: 16, y: 4 });
    expect(bendSign(out)).toBe(before);
  });

  it('is deterministic — identical inputs give identical output twice', () => {
    const joints: Pt[] = [{ x: 0, y: 0 }, { x: 9, y: 2 }, { x: 18, y: -3 }, { x: 27, y: 1 }];
    const target = { x: 11, y: 13 };
    expect(solveChainIK(joints, target)).toEqual(solveChainIK(joints, target));
  });

  it('a 2-joint chain matches the analytic solveTwoBone elbow (within tolerance)', () => {
    // Same setup solveTwoBone's own tests use: A=(0,0), B=(10,0), E=(10,10).
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, e = { x: 10, y: 10 };
    const target = { x: 4, y: 12 };
    const { delta1 } = solveTwoBone(a, b, e, target);
    // Analytic elbow after link 1 swings by delta1 (screen: +deg clockwise, +y down).
    const r = (delta1 * Math.PI) / 180;
    const elbow = {
      x: a.x + (b.x - a.x) * Math.cos(r) - (b.y - a.y) * Math.sin(r),
      y: a.y + (b.x - a.x) * Math.sin(r) + (b.y - a.y) * Math.cos(r),
    };
    const out = solveChainIK([a, b, e], target);
    expect(dist(out[out.length - 1], target)).toBeLessThan(0.05); // both reach the target
    expect(dist(out[1], elbow)).toBeLessThan(0.05); // same elbow (same bend side)
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
