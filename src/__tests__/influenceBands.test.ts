import { describe, expect, it } from 'vitest';
import { deserializeDoc, normalizeDoc, serializeDoc, SkinBone } from '../core/model';
import {
  autoInfluenceProfile, influenceProfileOwner, influenceProfileWeights,
  normalizeInfluenceProfile,
} from '../geometry/skin';
import { makeDoc, makePart, makePath } from './helpers';

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const bones: SkinBone[] = [
  { id: 'upper', restWorldInv: identity, bindSeg: { p: { x: 0, y: 0 }, q: { x: 50, y: 0 } } },
  { id: 'lower', restWorldInv: identity, bindSeg: { p: { x: 50, y: 0 }, q: { x: 100, y: 0 } } },
];

describe('group influence bands', () => {
  it('creates a deterministic joint profile and normalized adjacent-bone rows', () => {
    const profile = autoInfluenceProfile(bones);
    expect(profile.bands).toEqual([{
      parentBoneId: 'upper', childBoneId: 'lower', center: 0, width: 35,
    }]);
    const rows = influenceProfileWeights(
      [{ x: 0, y: 5 }, { x: 50, y: 5 }, { x: 100, y: 5 }], bones, profile,
    );
    expect(rows[0]).toEqual([1, 0]);
    expect(rows[1][0]).toBeCloseTo(0.5);
    expect(rows[1][1]).toBeCloseTo(0.5);
    expect(rows[2]).toEqual([0, 1]);
    for (const row of rows) expect(row.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  });

  it('moves and sharpens the crossover without depending on path node indexes', () => {
    const profile = { bands: [{
      parentBoneId: 'upper', childBoneId: 'lower', center: 10, width: 10,
    }] };
    const rows = influenceProfileWeights(
      [{ x: 50, y: 0 }, { x: 60, y: 0 }, { x: 65, y: 0 }], bones, profile,
    );
    expect(rows[0]).toEqual([1, 0]);
    expect(rows[1][0]).toBeCloseTo(0.5);
    expect(rows[2]).toEqual([0, 1]);
  });

  it('repairs stale profiles and falls back when no joint is usable', () => {
    expect(normalizeInfluenceProfile({ bands: [{
      parentBoneId: 'upper', childBoneId: 'lower', center: 999, width: -1,
    }] }, bones).bands[0]).toEqual(expect.objectContaining({ center: 40, width: 1 }));
    expect(influenceProfileWeights([{ x: 20, y: 0 }], [bones[0]], { bands: [] })[0]).toEqual([1]);
  });

  it('resolves the nearest ancestor profile for every descendant, including hidden art', () => {
    const group = makePart('arm', { kind: 'group', influenceProfile: autoInfluenceProfile(bones) });
    const art = makePart('art', { parentId: group.id, paths: [makePath('armPath')] });
    const shadow = makePart('shadow', { parentId: art.id, hidden: true, paths: [makePath('shadowPath')] });
    expect(influenceProfileOwner([group, art, shadow], art)?.id).toBe(group.id);
    expect(influenceProfileOwner([group, art, shadow], shadow)?.id).toBe(group.id);
  });

  it('round-trips valid profiles and prunes malformed or dangling bands', () => {
    const upper = makePart('upper', { kind: 'bone' });
    const lower = makePart('lower', { kind: 'bone', parentId: upper.id });
    const group = makePart('arm', {
      kind: 'group',
      influenceProfile: { bands: [
        { parentBoneId: 'upper', childBoneId: 'lower', center: 4, width: 12 },
        { parentBoneId: 'missing', childBoneId: 'lower', center: 0, width: 8 },
      ] },
    });
    const loaded = deserializeDoc(serializeDoc(makeDoc([group, upper, lower])));
    expect(loaded.parts[0].influenceProfile?.bands).toEqual([
      { parentBoneId: 'upper', childBoneId: 'lower', center: 4, width: 12 },
    ]);
    loaded.parts[0].influenceProfile = { bands: [{
      parentBoneId: 'upper', childBoneId: 'lower', center: Number.NaN, width: 0,
    }] };
    normalizeDoc(loaded);
    expect(loaded.parts[0].influenceProfile).toBeNull();
  });
});
