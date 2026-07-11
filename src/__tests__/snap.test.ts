/**
 * Pure snapping math: nearest-within-threshold selection, threshold boundary, empty
 * candidate lists, axis-locked behavior, box feature points, and delta snapping.
 */
import { describe, expect, it } from 'vitest';
import { snapPoint, snapDelta, boxFeaturePoints, SnapCandidate } from '../snap';

describe('snapPoint', () => {
  it('returns the nearest candidate within threshold', () => {
    const cands: SnapCandidate[] = [
      { x: 10, y: 0, kind: 'far' },
      { x: 2, y: 1, kind: 'near' },
    ];
    const m = snapPoint({ x: 0, y: 0 }, cands, 5);
    expect(m).not.toBeNull();
    expect(m!.candidate.kind).toBe('near');
    expect(m!.point).toEqual({ x: 2, y: 1 });
    expect(m!.dx).toBe(2);
    expect(m!.dy).toBe(1);
    expect(m!.dist).toBeCloseTo(Math.hypot(2, 1), 12);
  });

  it('includes a candidate exactly at the threshold, excludes just beyond', () => {
    const at = snapPoint({ x: 0, y: 0 }, [{ x: 5, y: 0 }], 5);
    expect(at).not.toBeNull();
    expect(at!.dist).toBe(5);
    const beyond = snapPoint({ x: 0, y: 0 }, [{ x: 5.0001, y: 0 }], 5);
    expect(beyond).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(snapPoint({ x: 1, y: 2 }, [], 100)).toBeNull();
  });

  it('returns null for a non-positive threshold', () => {
    expect(snapPoint({ x: 0, y: 0 }, [{ x: 0, y: 0 }], 0)).toBeNull();
    expect(snapPoint({ x: 0, y: 0 }, [{ x: 0, y: 0 }], -1)).toBeNull();
  });

  it('axis="x" snaps only x and keeps y; ranks by |Δx| ignoring y', () => {
    const cands: SnapCandidate[] = [
      { x: 3, y: 100, kind: 'sharesX' }, // far in y, but Δx is tiny
      { x: 6, y: 0, kind: 'closeXY' },
    ];
    const m = snapPoint({ x: 0, y: 0 }, cands, 5, 'x');
    expect(m!.candidate.kind).toBe('sharesX');
    expect(m!.point).toEqual({ x: 3, y: 0 }); // y unchanged
    expect(m!.dx).toBe(3);
    expect(m!.dy).toBe(0);
    expect(m!.dist).toBe(3);
  });

  it('axis="y" snaps only y and keeps x', () => {
    const m = snapPoint({ x: 7, y: 0 }, [{ x: 0, y: 4 }], 5, 'y');
    expect(m!.point).toEqual({ x: 7, y: 4 });
    expect(m!.dx).toBe(0);
    expect(m!.dy).toBe(4);
    expect(m!.dist).toBe(4);
  });

  it('axis lock does not snap when the free-axis distance exceeds threshold', () => {
    // Candidate is close in 2D but far on x — an x-locked drag must not snap to it.
    const m = snapPoint({ x: 0, y: 0 }, [{ x: 20, y: 1 }], 5, 'x');
    expect(m).toBeNull();
  });
});

describe('boxFeaturePoints', () => {
  it('produces center, four corners, and four edge midpoints', () => {
    const pts = boxFeaturePoints({ x: 0, y: 0, w: 10, h: 20 });
    expect(pts).toHaveLength(9);
    const center = pts.find((p) => p.kind?.endsWith('center'));
    expect(center).toEqual({ x: 5, y: 10, kind: 'bbox-center' });
    const corners = pts.filter((p) => p.kind?.endsWith('corner')).map((p) => `${p.x},${p.y}`);
    expect(corners.sort()).toEqual(['0,0', '0,20', '10,0', '10,20'].sort());
    const edges = pts.filter((p) => p.kind?.endsWith('edge')).map((p) => `${p.x},${p.y}`);
    expect(edges.sort()).toEqual(['0,10', '10,10', '5,0', '5,20'].sort());
  });
});

describe('snapDelta', () => {
  it('corrects the delta so the nearest moving feature lands on a target', () => {
    // Moving pivot at (0,0); with a +5,+5 drag it reaches (5,5); a target sits at (6,6).
    const moving: SnapCandidate[] = [{ x: 0, y: 0, kind: 'pivot' }];
    const targets: SnapCandidate[] = [{ x: 6, y: 6, kind: 'pivot' }];
    const r = snapDelta(moving, targets, { dx: 5, dy: 5 }, 3);
    expect(r.target).toEqual({ x: 6, y: 6 });
    expect(r.dx).toBe(6); // 5 + correction 1
    expect(r.dy).toBe(6);
  });

  it('leaves the delta untouched when nothing is in range', () => {
    const r = snapDelta([{ x: 0, y: 0 }], [{ x: 100, y: 100 }], { dx: 1, dy: 1 }, 3);
    expect(r).toEqual({ dx: 1, dy: 1, target: null });
  });

  it('picks the globally nearest moving/target pair', () => {
    const moving: SnapCandidate[] = [
      { x: 0, y: 0, kind: 'a' },
      { x: 10, y: 0, kind: 'b' },
    ];
    // After a +1,0 drag: a→(1,0), b→(11,0). Target near b (11.5) is closer than any near a.
    const targets: SnapCandidate[] = [
      { x: 3, y: 0 }, // 2.0 from a
      { x: 11.5, y: 0 }, // 0.5 from b
    ];
    const r = snapDelta(moving, targets, { dx: 1, dy: 0 }, 3);
    expect(r.target).toEqual({ x: 11.5, y: 0 });
    expect(r.dx).toBeCloseTo(1.5, 12);
  });

  it('respects an axis lock (only x corrected)', () => {
    const moving: SnapCandidate[] = [{ x: 0, y: 0 }];
    const targets: SnapCandidate[] = [{ x: 2, y: 50 }];
    const r = snapDelta(moving, targets, { dx: 0, dy: 0 }, 5, 'x');
    expect(r.dx).toBe(2);
    expect(r.dy).toBe(0); // y lock preserved despite target's far y
  });
});
