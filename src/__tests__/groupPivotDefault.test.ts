/**
 * Headless group-pivot default (the 2026-07-14 defect fix): a group minted around
 * members WITHOUT an explicit pivot — every headless surface: scripts/agents on the
 * headless facade (which re-exports core/model wholesale), MCP tool bodies operating
 * on a swapped-in session doc — defaults its pivot to the members' geometry bbox
 * center computed PURE-DOC (`core/partHierarchy.ts`'s `memberGeometryPivot` through
 * `geometry/pathBounds.ts`), instead of whatever junk the caller had (the real user
 * file: a root group `Girl` wrapping a figure around x 100–400 / y −850…−1000 got
 * pivot (−0.5, 0), so every rotation orbited a point far below the artwork).
 *
 * Contract pinned here:
 *  - no pivot argument → members' subtree geometry bbox center, exact through baked
 *    part transforms, per-path transforms, rest pose, and rest scale about the pivot;
 *  - an EXPLICIT pivot always wins (the in-app Ctrl+G flow keeps its DOM-measured box);
 *  - geometry-less selections (bones-only) fall back to the members' pivot average
 *    (mirrors `panels/canvasTools.ts`);
 *  - `addNullPart` (a members-less null) keeps its required explicit pivot — no default
 *    anywhere near it;
 *  - the bbox math is EXACT (analytic cubic extrema — control points never inflate the
 *    box) and reuses `pathToCubics` for arcs.
 */
import { describe, expect, it } from 'vitest';
import {
  addNullPart, groupParts, memberGeometryPivot,
} from '../core/model';
import { IDENTITY, matrixOfTransform } from '../geometry/transforms';
import { pathBoundsThroughMatrix } from '../geometry/pathBounds';
import { makeDoc, makePart, makePath, resetState } from './helpers';

describe('pathBoundsThroughMatrix (geometry/pathBounds.ts)', () => {
  it('boxes a rectangle exactly through the identity', () => {
    const b = pathBoundsThroughMatrix('M 100 -1000 L 400 -1000 L 400 -850 L 100 -850 Z', IDENTITY)!;
    expect(b).toEqual({ minX: 100, minY: -1000, maxX: 400, maxY: -850 });
  });

  it('solves cubic interior extrema analytically (control points never inflate the box)', () => {
    // y(t) peaks at t=0.5 with value −75; the control points sit at −100. A
    // control-polygon walk would report minY −100; skipping interior extrema entirely
    // would report 0. Only the analytic solve lands −75.
    const b = pathBoundsThroughMatrix('M 0 0 C 0 -100 100 -100 100 0', IDENTITY)!;
    expect(b.minY).toBeCloseTo(-75, 9);
    expect(b.maxY).toBeCloseTo(0, 9);
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.maxX).toBeCloseTo(100, 9);
  });

  it('maps control points through the matrix BEFORE taking extrema (affine-exact)', () => {
    const m = matrixOfTransform('translate(10,20) scale(2,1)');
    const b = pathBoundsThroughMatrix('M 0 0 C 0 -100 100 -100 100 0', m)!;
    expect(b.minX).toBeCloseTo(10, 9); // 0·2+10
    expect(b.maxX).toBeCloseTo(210, 9); // 100·2+10
    expect(b.minY).toBeCloseTo(-55, 9); // −75+20
    expect(b.maxY).toBeCloseTo(20, 9);
  });

  it('handles arcs through pathToCubics (semicircle bulging −y)', () => {
    // From (0,0) to (100,0), r=50, sweep 1: the semicircle spans y ∈ [−50, 0].
    const b = pathBoundsThroughMatrix('M 0 0 A 50 50 0 0 1 100 0', IDENTITY)!;
    expect(b.minY).toBeCloseTo(-50, 1); // cubic arc approximation ≪ 0.05 off
    expect(b.maxY).toBeCloseTo(0, 6);
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(100, 6);
  });

  it('returns null for coordinate-free data', () => {
    expect(pathBoundsThroughMatrix('', IDENTITY)).toBeNull();
  });
});

/** Two plain rect art parts spanning the Girl-like extent: x 100–400, y −1000…−850. */
function girlLikeParts() {
  return [
    makePart('arm', {
      paths: [makePath('arm.p', { d: 'M 100 -1000 L 400 -1000 L 400 -925 L 100 -925 Z' })],
    }),
    makePart('body', {
      paths: [makePath('body.p', { d: 'M 100 -925 L 400 -925 L 400 -850 L 100 -850 Z' })],
    }),
  ];
}

describe('groupParts pivot default (headless creation around members)', () => {
  it('defaults the pivot to the members\' geometry bbox center — the Girl defect scenario', () => {
    resetState(makeDoc(girlLikeParts()));
    const group = groupParts(['arm', 'body'])!;
    // The figure's true center — NOT (0,0)/(−0.5,0), which made rotations orbit a
    // point far below the artwork.
    expect(group.pivot).toEqual({ x: 250, y: -925 });
    expect(group.kind).toBe('group');
  });

  it('an EXPLICIT pivot always wins (the in-app Ctrl+G flow is untouched)', () => {
    resetState(makeDoc(girlLikeParts()));
    const group = groupParts(['arm', 'body'], { x: 7, y: 9 })!;
    expect(group.pivot).toEqual({ x: 7, y: 9 });
  });

  it('maps geometry through the baked part transform AND the per-path transform', () => {
    resetState(makeDoc([
      makePart('a', {
        transform: 'translate(50,10)',
        paths: [makePath('a.p', { d: 'M 0 0 L 20 0 L 20 20 L 0 20 Z', transform: 'translate(-10,0)' })],
      }),
    ]));
    const group = groupParts(['a'])!;
    expect(group.pivot).toEqual({ x: 50, y: 20 }); // rect shifted by (40,10) → x[40,60] y[10,30]
  });

  it('includes the member\'s REST pose (a moved part boxes where it renders)', () => {
    resetState(makeDoc([
      makePart('a', {
        rest: { rotate: 0, tx: 100, ty: -50, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
        paths: [makePath('a.p', { d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z' })],
      }),
    ]));
    const group = groupParts(['a'])!;
    expect(group.pivot).toEqual({ x: 105, y: -45 });
  });

  it('applies rest scale innermost about the member\'s own pivot (pose-kernel mirror)', () => {
    resetState(makeDoc([
      makePart('a', {
        pivot: { x: 10, y: 0 },
        rest: { rotate: 0, tx: 0, ty: 0, sx: 2, sy: 1, kx: 0, ky: 0, opacity: 1 },
        paths: [makePath('a.p', { d: 'M 0 0 L 20 0 L 20 10 L 0 10 Z' })],
      }),
    ]));
    const group = groupParts(['a'])!;
    // x' = 2x − 10 about the pivot: [0,20] → [−10,30], center back at the pivot's x.
    expect(group.pivot).toEqual({ x: 10, y: 5 });
  });

  it('a container member contributes its WHOLE subtree\'s art', () => {
    resetState(makeDoc([
      makePart('holder', { kind: 'group' }),
      makePart('leaf', {
        parentId: 'holder',
        paths: [makePath('leaf.p', { d: 'M 100 -1000 L 400 -1000 L 400 -850 L 100 -850 Z' })],
      }),
    ]));
    const group = groupParts(['holder'])!;
    expect(group.pivot).toEqual({ x: 250, y: -925 });
  });

  it('hidden members are excluded from the box (mirrors partRootBoxes)', () => {
    const [arm, body] = girlLikeParts();
    body.hidden = true;
    resetState(makeDoc([arm, body]));
    const group = groupParts(['arm', 'body'])!;
    expect(group.pivot).toEqual({ x: 250, y: -962.5 }); // the visible arm rect alone
  });

  it('a skinned member\'s geometry maps through the IDENTITY (already root-space)', () => {
    resetState(makeDoc([
      makePart('skinned', {
        // Bind zeroes these in real docs; junk values here PROVE they are ignored.
        transform: 'translate(1000,0)',
        rest: { rotate: 0, tx: 500, ty: 500, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
        skin: { bones: [] },
        paths: [makePath('s.p', { d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z' })],
      }),
    ]));
    const group = groupParts(['skinned'])!;
    expect(group.pivot).toEqual({ x: 5, y: 5 });
  });

  it('bones-only selections fall back to the members\' pivot average (in-app parity)', () => {
    resetState(makeDoc([
      makePart('b1', { kind: 'bone', pivot: { x: 10, y: 20 } }),
      makePart('b2', { kind: 'bone', pivot: { x: 30, y: 40 } }),
    ]));
    const group = groupParts(['b1', 'b2'])!;
    expect(group.pivot).toEqual({ x: 20, y: 30 });
  });

  it('memberGeometryPivot is exposed for other member-wrapping creation paths', () => {
    const doc = makeDoc(girlLikeParts());
    resetState(doc);
    const members = doc.parts;
    expect(memberGeometryPivot(members, doc.parts)).toEqual({ x: 250, y: -925 });
  });
});

describe('addNullPart keeps its required explicit pivot (members-less nulls unchanged)', () => {
  it('stores exactly the pivot it is given — no defaulting anywhere near it', () => {
    resetState(makeDoc([]));
    expect(addNullPart('group', { x: 3, y: 4 }, null).pivot).toEqual({ x: 3, y: 4 });
    expect(addNullPart('bone', { x: 1, y: 2 }, null).pivot).toEqual({ x: 1, y: 2 });
  });
});
