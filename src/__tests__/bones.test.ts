/**
 * Unit tests for Bones 2.0 pure logic: bone-chain resolution, per-node override weight
 * rows, weight sharpening, and normalizeDoc's override pruning.
 *
 * RE-SPEC: `segIntersectsBox` is retained as pure segment/box geometry but is NO LONGER
 * the auto-bind criterion — it bound anything a chain's bounding box merely grazed (the
 * user's arm bone dragged the body in). Auto-bind targeting now hit-tests the chain
 * against each part's actual FILLED geometry (`isPointInFill`, a live-DOM test) and is
 * covered at the rendered level in the interaction suite (`interaction/bones.test.ts`
 * B1/B6). These cases keep the box-clip math honest for any future reuse.
 */

import { describe, expect, it } from 'vitest';
import { boneChain, normalizeDoc, RigDoc, SkinOverride } from '../core/model';
import {
  artDescendantsOf, chainAnchorPart, distToSegment, expandBindTarget, overrideWeightRow,
  segIntersectsBox, skinWeights,
} from '../geometry/skin';
import { makeDoc, makePart, makePath } from './helpers';

describe('boneChain', () => {
  it('collects the root bone plus every descendant bone through bone-only links', () => {
    const arm = makePart('arm', { kind: 'art', paths: [makePath('p')] });
    const b1 = makePart('b1', { kind: 'bone', parentId: 'arm' });
    const b2 = makePart('b2', { kind: 'bone', parentId: 'b1' });
    const b3 = makePart('b3', { kind: 'bone', parentId: 'b2' });
    const doc = makeDoc([arm, b1, b2, b3]);
    // From any bone in the chain, the whole chain (root b1 + descendants) resolves.
    for (const id of ['b1', 'b2', 'b3']) {
      const chain = boneChain(doc.parts, id).map((p) => p.id);
      expect(chain).toEqual(['b1', 'b2', 'b3']);
    }
  });

  it('stops the walk at a non-bone parent (art is the chain root of the bones)', () => {
    const arm = makePart('arm', { kind: 'art' });
    const b1 = makePart('b1', { kind: 'bone', parentId: 'arm' });
    const b2 = makePart('b2', { kind: 'bone', parentId: 'b1' });
    const chain = boneChain(makeDoc([arm, b1, b2]).parts, 'b2').map((p) => p.id);
    expect(chain).toEqual(['b1', 'b2']); // the art is NOT in the chain
  });

  it('separates two independent chains', () => {
    const a1 = makePart('a1', { kind: 'bone' });
    const a2 = makePart('a2', { kind: 'bone', parentId: 'a1' });
    const c1 = makePart('c1', { kind: 'bone' });
    const c2 = makePart('c2', { kind: 'bone', parentId: 'c1' });
    const parts = makeDoc([a1, a2, c1, c2]).parts;
    expect(boneChain(parts, 'a2').map((p) => p.id)).toEqual(['a1', 'a2']);
    expect(boneChain(parts, 'c1').map((p) => p.id)).toEqual(['c1', 'c2']);
  });

  it('returns nothing for a non-bone id or a cycle guard', () => {
    const art = makePart('art', { kind: 'art' });
    expect(boneChain(makeDoc([art]).parts, 'art')).toEqual([]);
    // Self-parent cycle must not hang.
    const b = makePart('b', { kind: 'bone', parentId: 'b' });
    expect(boneChain(makeDoc([b]).parts, 'b').map((p) => p.id)).toEqual(['b']);
  });
});

describe('Group-level auto-bind targeting (pure)', () => {
  describe('artDescendantsOf', () => {
    it('collects every ART descendant at any depth, excluding the part itself', () => {
      // group ⊃ outerArt(1 path) ⊃ innerArt(3 paths) ⊃ bone ⊃ deepArt(1 path)
      const group = makePart('group', { kind: 'group' });
      const outerArt = makePart('outerArt', { kind: 'art', parentId: 'group', paths: [makePath('p0')] });
      const innerArt = makePart('innerArt', {
        kind: 'art', parentId: 'outerArt', paths: [makePath('p1'), makePath('p2'), makePath('p3')],
      });
      const bone = makePart('bone', { kind: 'bone', parentId: 'innerArt' });
      const deepArt = makePart('deepArt', { kind: 'art', parentId: 'bone', paths: [makePath('p4')] });
      const parts = [group, outerArt, innerArt, bone, deepArt];
      expect(artDescendantsOf(parts, group).map((p) => p.id).sort())
        .toEqual(['deepArt', 'innerArt', 'outerArt']);
      expect(artDescendantsOf(parts, outerArt).map((p) => p.id).sort())
        .toEqual(['deepArt', 'innerArt']);
    });
    it('excludes art parts with zero paths and the bone itself', () => {
      const arm = makePart('arm', { kind: 'art', paths: [] }); // art kind, but no geometry
      const bone = makePart('bone', { kind: 'bone', parentId: 'arm' });
      const group = makePart('group', { kind: 'group' });
      const child = makePart('child', { kind: 'art', parentId: 'group', paths: [makePath('p')] });
      const parts = [group, child, arm, bone];
      expect(artDescendantsOf(parts, group).map((p) => p.id)).toEqual(['child']);
      expect(artDescendantsOf(parts, arm)).toEqual([]); // arm itself has no eligible descendant
    });
    it('is cycle-safe (a corrupt parentId ring never hangs or false-positives)', () => {
      const a = makePart('a', { kind: 'art', parentId: 'b', paths: [makePath('pa')] });
      const b = makePart('b', { kind: 'art', parentId: 'a', paths: [makePath('pb')] });
      const target = makePart('target', { kind: 'group' });
      expect(() => artDescendantsOf([target, a, b], target)).not.toThrow();
      expect(artDescendantsOf([target, a, b], target)).toEqual([]); // neither is under target
    });
  });

  describe('expandBindTarget', () => {
    it('a GROUP expands to every art descendant (itself contributes nothing — no paths)', () => {
      const group = makePart('group', { kind: 'group' });
      const a = makePart('a', { kind: 'art', parentId: 'group', paths: [makePath('pa')] });
      const b = makePart('b', { kind: 'art', parentId: 'group', paths: [makePath('pb')] });
      const parts = [group, a, b];
      expect(expandBindTarget(parts, group).map((p) => p.id).sort()).toEqual(['a', 'b']);
    });
    it('an empty GROUP expands to nothing (not itself — a group never has paths)', () => {
      const group = makePart('group', { kind: 'group' });
      expect(expandBindTarget([group], group)).toEqual([]);
    });
    it('nested art-in-art (Pip\'s body) expands to itself PLUS its art descendants', () => {
      // outer "body" (1 path: shadow) ⊃ inner "body" (3 paths: pill/red/outline)
      const outer = makePart('outerBody', { kind: 'art', paths: [makePath('shadow')] });
      const inner = makePart('innerBody', {
        kind: 'art', parentId: 'outerBody',
        paths: [makePath('pill'), makePath('red'), makePath('outline')],
      });
      const parts = [outer, inner];
      expect(expandBindTarget(parts, outer).map((p) => p.id).sort()).toEqual(['innerBody', 'outerBody']);
      // Selecting the NESTED part only binds itself — it has no descendant of its own,
      // and its ancestor (outer) is not a descendant of it.
      expect(expandBindTarget(parts, inner).map((p) => p.id)).toEqual(['innerBody']);
    });
    it('a plain leaf art part (no descendant art) resolves to just itself', () => {
      const leaf = makePart('leaf', { kind: 'art', paths: [makePath('p')] });
      expect(expandBindTarget([leaf], leaf)).toEqual([leaf]);
    });
    it('a bone, or an art part with zero paths and no descendants, resolves to nothing', () => {
      const bone = makePart('bone', { kind: 'bone' });
      expect(expandBindTarget([bone], bone)).toEqual([]);
      const emptyArt = makePart('emptyArt', { kind: 'art', paths: [] });
      expect(expandBindTarget([emptyArt], emptyArt)).toEqual([]);
    });
    // MUTATION CHECK: reverting `expandBindTarget` to the old single-part targeting —
    // `return self;` unconditionally, dropping the `...descendants` union — turns the
    // GROUP test above into a failure (`[]` instead of `['a','b']`, since a group's own
    // `self` is always empty) and the nested-art-in-art test into a failure (`['outerBody']`
    // instead of `['innerBody','outerBody']`), pinning that the expansion is load-bearing.
  });

  describe('chainAnchorPart', () => {
    it("resolves the chain ROOT bone's parent, from any bone in the chain", () => {
      const group = makePart('group', { kind: 'group' });
      const b1 = makePart('b1', { kind: 'bone', parentId: 'group' });
      const b2 = makePart('b2', { kind: 'bone', parentId: 'b1' });
      const parts = [group, b1, b2];
      const chain = boneChain(parts, 'b2');
      expect(chainAnchorPart(parts, chain)?.id).toBe('group');
      expect(chainAnchorPart(parts, boneChain(parts, 'b1'))?.id).toBe('group');
    });
    it('returns null for a free-standing chain (no parent)', () => {
      const b1 = makePart('b1', { kind: 'bone' });
      const b2 = makePart('b2', { kind: 'bone', parentId: 'b1' });
      const parts = [b1, b2];
      expect(chainAnchorPart(parts, boneChain(parts, 'b2'))).toBeNull();
    });
    it('returns null for a dangling parent reference', () => {
      const b1 = makePart('b1', { kind: 'bone', parentId: 'ghost' });
      const parts = [b1];
      expect(chainAnchorPart(parts, boneChain(parts, 'b1'))).toBeNull();
    });
  });
});

describe('segIntersectsBox (legacy pure geometry — no longer the auto-bind criterion)', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  it('detects an endpoint inside the box', () => {
    expect(segIntersectsBox({ p: { x: 5, y: 5 }, q: { x: 50, y: 50 } }, box)).toBe(true);
  });
  it('detects a segment crossing the box with both endpoints outside', () => {
    expect(segIntersectsBox({ p: { x: -5, y: 5 }, q: { x: 15, y: 5 } }, box)).toBe(true);
  });
  it('rejects a segment that misses the box entirely', () => {
    expect(segIntersectsBox({ p: { x: -5, y: -5 }, q: { x: -1, y: 20 } }, box)).toBe(false);
    expect(segIntersectsBox({ p: { x: 20, y: 0 }, q: { x: 20, y: 10 } }, box)).toBe(false);
  });
  it('treats a touching edge as overlapping', () => {
    expect(segIntersectsBox({ p: { x: 10, y: 0 }, q: { x: 10, y: 10 } }, box)).toBe(true);
  });
});

describe('overrideWeightRow', () => {
  const ids = ['bone_a', 'bone_b', 'bone_c'];
  it('blends a at (1−t) with b at t', () => {
    expect(overrideWeightRow(ids, { a: 'bone_a', b: 'bone_b', t: 0.25 })).toEqual([0.75, 0.25, 0]);
    expect(overrideWeightRow(ids, { a: 'bone_a', b: 'bone_c', t: 1 })).toEqual([0, 0, 1]);
  });
  it('collapses to 100% a when b is null, missing, or equal to a', () => {
    expect(overrideWeightRow(ids, { a: 'bone_b', b: null, t: 0.5 })).toEqual([0, 1, 0]);
    expect(overrideWeightRow(ids, { a: 'bone_b', b: 'ghost', t: 0.5 })).toEqual([0, 1, 0]);
    expect(overrideWeightRow(ids, { a: 'bone_b', b: 'bone_b', t: 0.5 })).toEqual([0, 1, 0]);
  });
  it('clamps t into [0,1]', () => {
    expect(overrideWeightRow(ids, { a: 'bone_a', b: 'bone_b', t: 2 })).toEqual([0, 1, 0]);
    expect(overrideWeightRow(ids, { a: 'bone_a', b: 'bone_b', t: -1 })).toEqual([1, 0, 0]);
  });
  it('rows always sum to 1', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      const row = overrideWeightRow(ids, { a: 'bone_a', b: 'bone_c', t })!;
      expect(row.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
    }
  });
  it('returns null when a is unresolvable (caller falls back to auto)', () => {
    expect(overrideWeightRow(ids, { a: 'ghost', b: null, t: 0 })).toBeNull();
  });
});

describe('skinWeights sharpening', () => {
  const segs = [
    { p: { x: 0, y: 0 }, q: { x: 10, y: 0 } },
    { p: { x: 0, y: 20 }, q: { x: 10, y: 20 } },
  ];
  it('a sharper power concentrates weight on the nearer bone', () => {
    const pt = { x: 5, y: 6 }; // nearer bone 0 (6 away) than bone 1 (14 away)
    const [soft] = skinWeights([pt], segs, 2);
    const [sharp] = skinWeights([pt], segs, 4);
    expect(sharp[0]).toBeGreaterThan(soft[0]); // sharper pins more onto the nearest bone
    expect(soft[0] + soft[1]).toBeCloseTo(1, 12);
    expect(sharp[0] + sharp[1]).toBeCloseTo(1, 12);
  });
  it('still splits an equidistant point evenly at any power', () => {
    const [mid] = skinWeights([{ x: 5, y: 10 }], segs, 4);
    expect(mid[0]).toBeCloseTo(0.5, 9);
  });
});

// Render resilience (hardening wave): a bad bone bind — a zero-length bind segment or
// literally non-finite input — must degrade to a sane, finite result rather than NaN
// propagating into the rendered path. Mutation check: deleting the `len2 < 1e-12` early
// return in distToSegment turns the first test below into a NaN/Infinity assertion
// failure (0/0 in the projection-parameter divide).
describe('skinWeights / distToSegment tolerate degenerate input (render resilience)', () => {
  it('distToSegment treats a zero-length segment as a point distance, never NaN/Infinity', () => {
    const seg = { p: { x: 5, y: 5 }, q: { x: 5, y: 5 } }; // zero length
    const d = distToSegment({ x: 8, y: 9 }, seg);
    expect(d).toBeCloseTo(5, 9); // hypot(3,4)
    expect(Number.isFinite(d)).toBe(true);
  });

  it('skinWeights normalizes to 1 across bones even when one bind segment is zero-length', () => {
    const segs = [
      { p: { x: 0, y: 0 }, q: { x: 0, y: 0 } }, // degenerate — bind-time bone with no length
      { p: { x: 10, y: 0 }, q: { x: 20, y: 0 } },
    ];
    const [row] = skinWeights([{ x: 1, y: 0 }], segs, 4);
    expect(row.every((w) => Number.isFinite(w))).toBe(true);
    expect(row[0] + row[1]).toBeCloseTo(1, 9);
    expect(row[0]).toBeGreaterThan(row[1]); // point sits right next to the degenerate bone
  });

  it('skinWeights falls back to a uniform split rather than propagating NaN from a non-finite point', () => {
    const segs = [
      { p: { x: 0, y: 0 }, q: { x: 10, y: 0 } },
      { p: { x: 0, y: 20 }, q: { x: 10, y: 20 } },
    ];
    const [row] = skinWeights([{ x: NaN, y: 0 }], segs, 4);
    expect(row.every((w) => Number.isFinite(w))).toBe(true);
    expect(row[0] + row[1]).toBeCloseTo(1, 9);
  });
});

describe('normalizeDoc override pruning', () => {
  function docWithSkin(overrides: Record<string, Record<string, SkinOverride>>): RigDoc {
    const arm = makePart('arm', {
      kind: 'art',
      paths: [makePath('p1', { d: 'M 0,0 C 1,0 2,0 3,0' })],
      skin: {
        bones: [
          { id: 'b1', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } } },
          { id: 'b2', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 1, y: 0 }, q: { x: 2, y: 0 } } },
        ],
        overrides,
      },
    });
    const b1 = makePart('b1', { kind: 'bone' });
    const b2 = makePart('b2', { kind: 'bone' });
    return makeDoc([arm, b1, b2]);
  }

  it('keeps valid overrides and clamps t', () => {
    const doc = normalizeDoc(docWithSkin({ p1: { '1': { a: 'b1', b: 'b2', t: 5 } } }));
    const ov = doc.parts[0].skin!.overrides!.p1['1'];
    expect(ov).toEqual({ a: 'b1', b: 'b2', t: 1 });
  });

  it('drops overrides referencing a dangling bone id', () => {
    const doc = normalizeDoc(docWithSkin({ p1: { '1': { a: 'ghost', b: 'b2', t: 0.5 } } }));
    expect(doc.parts[0].skin!.overrides).toBeUndefined();
  });

  it('drops overrides with a non-finite t and empties clean', () => {
    const doc = normalizeDoc(docWithSkin({ p1: { '1': { a: 'b1', b: null, t: NaN } } }));
    expect(doc.parts[0].skin!.overrides).toBeUndefined();
  });

  it('keeps a null b (100% a)', () => {
    const doc = normalizeDoc(docWithSkin({ p1: { '2': { a: 'b2', b: null, t: 0 } } }));
    expect(doc.parts[0].skin!.overrides!.p1['2']).toEqual({ a: 'b2', b: null, t: 0 });
  });
});
