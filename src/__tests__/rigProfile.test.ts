// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Unit tests for AI Animate System v2 A5's rig profile (`ai/rigProfile.ts`) and its
 * request block (`ai/profileBlock.ts`): fabricated rigs pin each heuristic (chains,
 * symmetry, roles, figure group, cache invalidation), and BOTH real bundled fixtures
 * (the sample character + the nested girl_example) prove the profile is rig-agnostic —
 * jsdom is opted in solely so `importSvg` has a DOMParser for those two.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRigProfile, getRigProfile, rigSignature, RigProfile,
} from '../ai/rigProfile';
import { buildRigProfileBlock } from '../ai/profileBlock';
import { importSvg } from '../io/importSvg';
import { RigPart } from '../core/model';
import { IDENTITY } from '../geometry/transforms';
import { makePart, makePath } from './helpers';
// eslint-disable-next-line import/no-unresolved
import PIP_SVG from '../../public/PIP_MASTER.svg?raw';
// eslint-disable-next-line import/no-unresolved
import GIRL_SVG from '../../public/girl_example.svg?raw';

function bone(id: string, parentId: string | null, pivot: { x: number; y: number },
  tip: { x: number; y: number }): RigPart {
  return makePart(id, { kind: 'bone', parentId, pivot, boneTip: tip, paths: [] });
}

function skinnedArt(id: string, boneIds: string[]): RigPart {
  return makePart(id, {
    paths: [makePath(`${id}_p`)],
    skin: {
      bones: boneIds.map((b) => ({
        id: b, restWorldInv: IDENTITY, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } },
      })),
    },
  });
}

const roleOf = (profile: RigProfile, id: string) =>
  profile.roles.find((r) => r.id === id)?.role;

describe('rig profile — chains', () => {
  it('collects a 3-bone chain root→leaf with doc-space lengths and the art it deforms', () => {
    const parts = [
      skinnedArt('limb_art', ['b1', 'b2', 'b3']),
      bone('b1', 'limb_art', { x: 0, y: 0 }, { x: 30, y: 0 }), // rooted under ART — still one chain
      bone('b2', 'b1', { x: 30, y: 0 }, { x: 30, y: 40 }),
      bone('b3', 'b2', { x: 30, y: 40 }, { x: 30, y: 50 }),
    ];
    const p = buildRigProfile(parts);
    expect(p.chains).toHaveLength(1);
    expect(p.chains[0].bones.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(p.chains[0].bones.map((b) => b.length)).toEqual([30, 40, 10]);
    expect(p.chains[0].totalLength).toBe(80);
    expect(p.chains[0].deforms).toEqual([{ id: 'limb_art', label: 'limb_art' }]);
  });

  it('a branch stays ONE chain (both children collected after their parent)', () => {
    const parts = [
      bone('root', null, { x: 0, y: 0 }, { x: 10, y: 0 }),
      bone('kid_a', 'root', { x: 10, y: 0 }, { x: 20, y: 0 }),
      bone('kid_b', 'root', { x: 10, y: 0 }, { x: 10, y: 10 }),
    ];
    const p = buildRigProfile(parts);
    expect(p.chains).toHaveLength(1);
    expect(p.chains[0].bones.map((b) => b.id)).toEqual(['root', 'kid_a', 'kid_b']);
  });

  it('independent chains stay separate, each with its own deform set', () => {
    const parts = [
      skinnedArt('art_a', ['a1']),
      skinnedArt('art_b', ['b1']),
      bone('a1', null, { x: 0, y: 0 }, { x: 5, y: 0 }),
      bone('b1', null, { x: 50, y: 0 }, { x: 55, y: 0 }),
    ];
    const p = buildRigProfile(parts);
    expect(p.chains).toHaveLength(2);
    expect(p.chains.map((c) => c.deforms[0].id).sort()).toEqual(['art_a', 'art_b']);
  });

  it('a boneless rig has no chains', () => {
    expect(buildRigProfile([makePart('a', { paths: [makePath('p')] })]).chains).toEqual([]);
  });
});

describe('rig profile — symmetry pairs', () => {
  it('pairs snake_case, CamelCase, and suffix spellings; unpaired sides are ignored', () => {
    const parts = [
      makePart('p1', { label: 'left_fin' }), makePart('p2', { label: 'right_fin' }),
      makePart('p3', { label: 'LeftClaw' }), makePart('p4', { label: 'RightClaw' }),
      makePart('p5', { label: 'antenna_left' }), makePart('p6', { label: 'antenna_right' }),
      makePart('p7', { label: 'left_orphan' }), // no right side — never a pair
    ];
    const p = buildRigProfile(parts);
    const bases = p.symmetryPairs.map((sp) => sp.base).sort();
    expect(bases).toEqual(['antenna', 'claw', 'fin']);
    const fin = p.symmetryPairs.find((sp) => sp.base === 'fin')!;
    expect(fin.left.id).toBe('p1');
    expect(fin.right.id).toBe('p2');
  });

  it('detects mirrored baked transforms (matrix reflection) and editor flips (negative rest sx)', () => {
    const parts = [
      makePart('m1', { label: 'left_wing', transform: 'rotate(20,5,5)' }),
      makePart('m2', { label: 'right_wing', transform: 'matrix(-1,0,0,1,100,0) rotate(20,5,5)' }),
      makePart('f1', { label: 'left_pad' }),
      makePart('f2', {
        label: 'right_pad',
        rest: { rotate: 0, tx: 0, ty: 0, sx: -1, sy: 1, kx: 0, ky: 0, opacity: 1 },
      }),
      makePart('r1', { label: 'left_hook', transform: 'rotate(30)' }),
      makePart('r2', { label: 'right_hook', transform: 'rotate(-30)' }), // rotated, NOT reflected
    ];
    const p = buildRigProfile(parts);
    const by = (base: string) => p.symmetryPairs.find((sp) => sp.base === base)!;
    expect(by('wing').mirrored).toBe(true);
    expect(by('pad').mirrored).toBe(true); // flip lives in rest.sx, not the matrix
    expect(by('hook').mirrored).toBe(false); // pair still exists via labels
  });

  it('identical (identity) transforms are NOT called mirrored', () => {
    const p = buildRigProfile([
      makePart('a', { label: 'left_dot' }), makePart('b', { label: 'right_dot' }),
    ]);
    expect(p.symmetryPairs[0].mirrored).toBe(false);
  });
});

describe('rig profile — roles', () => {
  it('label keywords map through camelCase/separators; edge matches only (no mid-word hits)', () => {
    const parts = [
      makePart('t', { label: 'MainBody' }),
      makePart('h', { label: 'head' }),
      makePart('l', { label: 'forearm' }), // suffix 'arm'
      makePart('f', { label: 'left_eye' }),
      makePart('s', { label: 'drop-shadow' }),
      makePart('x', { label: 'gearbox' }), // contains 'ear' mid-word — must stay 'part'
    ];
    const p = buildRigProfile(parts);
    expect(roleOf(p, 't')).toBe('torso');
    expect(roleOf(p, 'h')).toBe('head');
    expect(roleOf(p, 'l')).toBe('limb');
    expect(roleOf(p, 'f')).toBe('face');
    expect(roleOf(p, 's')).toBe('shadow');
    expect(roleOf(p, 'x')).toBe('part');
  });

  it('shadow outranks limb for combined labels (arm_shadow is a shadow)', () => {
    const p = buildRigProfile([makePart('a', { label: 'arm_shadow' })]);
    expect(roleOf(p, 'a')).toBe('shadow');
  });

  it('art deformed by a bone chain defaults to limb without any keyword', () => {
    const parts = [
      skinnedArt('tentacle_thing', ['b1']),
      bone('b1', null, { x: 0, y: 0 }, { x: 10, y: 0 }),
    ];
    expect(roleOf(buildRigProfile(parts), 'tentacle_thing')).toBe('limb');
  });

  it('with no labeled torso, the LARGEST roleless direct child of the figure group becomes torso', () => {
    const big = makePath('bp', { d: 'M 0,0 L 100,0 L 100,100 L 0,100 Z' });
    const small = makePath('sp', { d: 'M 0,0 L 5,0 L 5,5 L 0,5 Z' });
    const parts = [
      makePart('fig', { label: 'creature', kind: 'group' }),
      makePart('hull', { label: 'hull', parentId: 'fig', paths: [big] }),
      makePart('bump', { label: 'bump', parentId: 'fig', paths: [small] }),
      makePart('dome', { label: 'head_dome', parentId: 'fig', paths: [small] }),
    ];
    const p = buildRigProfile(parts);
    expect(p.figureGroup?.id).toBe('fig');
    expect(roleOf(p, 'hull')).toBe('torso');
    expect(roleOf(p, 'bump')).toBe('part');
    expect(roleOf(p, 'dome')).toBe('head');
  });

  it('roleless art OUTSIDE the figure group is a prop; inside stays plain part', () => {
    const leaf = makePath('lp');
    const parts = [
      makePart('fig', { label: 'creature', kind: 'group' }),
      makePart('a1', { label: 'core_body', parentId: 'fig', paths: [leaf] }),
      makePart('a2', { label: 'thing_one', parentId: 'fig', paths: [leaf] }),
      makePart('loose', { label: 'balloon', parentId: null, paths: [leaf] }),
    ];
    const p = buildRigProfile(parts);
    expect(roleOf(p, 'loose')).toBe('prop');
    expect(roleOf(p, 'a2')).toBe('part');
  });
});

describe('rig profile — figure group', () => {
  it('picks the part whose descendants cover the majority of art', () => {
    const leaf = makePath('lp');
    const parts = [
      makePart('fig', { label: 'whole_figure', kind: 'group' }),
      makePart('a', { parentId: 'fig', paths: [leaf] }),
      makePart('b', { parentId: 'fig', paths: [leaf] }),
      makePart('c', { parentId: 'b', paths: [leaf] }),
      makePart('loose', { paths: [leaf] }),
    ];
    expect(buildRigProfile(parts).figureGroup).toEqual({ id: 'fig', label: 'whole_figure' });
  });

  it('a flat rig (no covering group) honestly reports null', () => {
    const leaf = makePath('lp');
    const parts = [makePart('a', { paths: [leaf] }), makePart('b', { paths: [leaf] })];
    expect(buildRigProfile(parts).figureGroup).toBeNull();
  });

  it('a group covering a MINORITY of art is not the figure', () => {
    const leaf = makePath('lp');
    const parts = [
      makePart('g', { kind: 'group' }),
      makePart('a', { parentId: 'g', paths: [leaf] }),
      makePart('b', { paths: [leaf] }),
      makePart('c', { paths: [leaf] }),
      makePart('d', { paths: [leaf] }),
    ];
    expect(buildRigProfile(parts).figureGroup).toBeNull();
  });
});

describe('rig profile — cache (getRigProfile)', () => {
  it('returns the SAME object while the hierarchy signature is unchanged', () => {
    const parts = [makePart('a', { label: 'left_fin' }), makePart('b', { label: 'right_fin' })];
    const first = getRigProfile(parts);
    expect(getRigProfile(parts)).toBe(first);
  });

  it('MUTATION CHECK — a hierarchy edit (new bone, relabel, tip move) rebuilds the profile', () => {
    const parts = [makePart('a', { label: 'left_fin' }), makePart('b', { label: 'right_fin' })];
    const before = getRigProfile(parts);
    parts.push(bone('nb', null, { x: 0, y: 0 }, { x: 25, y: 0 }));
    const withBone = getRigProfile(parts);
    expect(withBone).not.toBe(before);
    expect(withBone.chains).toHaveLength(1);
    expect(withBone.chains[0].bones[0].length).toBe(25);

    parts[2].boneTip = { x: 40, y: 0 }; // tip move changes the signature too
    const afterTip = getRigProfile(parts);
    expect(afterTip).not.toBe(withBone);
    expect(afterTip.chains[0].bones[0].length).toBe(40);

    parts[0].label = 'lonely_fin'; // relabel breaks the pair
    expect(getRigProfile(parts).symmetryPairs).toHaveLength(0);
  });

  it('signature covers ids/parents/labels/kinds/bone geometry/skin refs/rest-scale signs', () => {
    const parts = [skinnedArt('a', ['b1']), bone('b1', null, { x: 0, y: 0 }, { x: 9, y: 0 })];
    const sig = rigSignature(parts);
    parts[0].skin!.bones = []; // unbinding must invalidate (chain deforms change)
    expect(rigSignature(parts)).not.toBe(sig);
    const sig2 = rigSignature(parts);
    parts[0].rest.sx = -1; // a flip must invalidate (mirror detection reads it)
    expect(rigSignature(parts)).not.toBe(sig2);
  });
});

describe('rig profile — real fixtures (rig-agnostic proof)', () => {
  it('the bundled sample: limb pairs, torso/face/shadow roles, no fabricated figure group', () => {
    const doc = importSvg(PIP_SVG, 'sample.svg');
    const p = buildRigProfile(doc.parts);

    const bases = p.symmetryPairs.map((sp) => sp.base).sort();
    expect(bases).toEqual(['arm', 'leg']);
    const arm = p.symmetryPairs.find((sp) => sp.base === 'arm')!;
    expect(arm.left.label).toBe('left_arm');
    expect(arm.right.label).toBe('right_arm');

    const roleByLabel = (label: string) => p.roles.find((r) => r.label === label)?.role;
    expect(roleByLabel('body')).toBe('torso');
    expect(roleByLabel('face')).toBe('face');
    expect(roleByLabel('left_arm')).toBe('limb');
    expect(roleByLabel('right_leg')).toBe('limb');
    expect(roleByLabel('shadow')).toBe('shadow');

    expect(p.figureGroup).toBeNull(); // flat rig — nothing covers a majority of art
    expect(p.chains).toEqual([]); // no bones on import
  });

  it('girl_example: figure group found, arm pair despite CamelCase, sensible roles incl. the torso fallback', () => {
    const doc = importSvg(GIRL_SVG, 'girl_example.svg');
    const p = buildRigProfile(doc.parts);

    expect(p.figureGroup?.label).toBe('Girl');

    const arm = p.symmetryPairs.find((sp) => sp.base === 'arm')!;
    expect(arm).toBeDefined();
    expect([arm.left.label, arm.right.label].sort()).toEqual(['LeftArm', 'RightArm']);

    const roleByLabel = (label: string, n = 0) =>
      p.roles.filter((r) => r.label === label)[n]?.role;
    expect(roleByLabel('Head')).toBe('head');
    expect(roleByLabel('LeftArm')).toBe('limb');
    expect(roleByLabel('RightArm')).toBe('limb');
    expect(roleByLabel('Arm')).toBe('limb');
    // No torso keyword anywhere — the size-rank fallback must land on Pants (the only
    // roleless direct child of the figure group), never on shadow/face/head parts.
    expect(roleByLabel('Pants')).toBe('torso');
  });
});

describe('buildRigProfileBlock (ai/profileBlock.ts)', () => {
  it('returns "" for an empty profile (caller skips prepending)', () => {
    expect(buildRigProfileBlock({
      chains: [], symmetryPairs: [], roles: [], figureGroup: null,
    })).toBe('');
  });

  it('names figure group, grouped roles, pairs, and chains — and flags itself heuristic', () => {
    const parts = [
      makePart('fig', { label: 'creature', kind: 'group' }),
      makePart('t', { label: 'main_body', parentId: 'fig', paths: [makePath('p1')] }),
      makePart('l1', { label: 'left_fin', parentId: 'fig', paths: [makePath('p2')] }),
      makePart('l2', { label: 'right_fin', parentId: 'fig', paths: [makePath('p3')] }),
      bone('b1', 'l1', { x: 0, y: 0 }, { x: 12, y: 0 }),
      bone('b2', 'b1', { x: 12, y: 0 }, { x: 24, y: 0 }),
    ];
    parts[2].skin = {
      bones: [{ id: 'b1', restWorldInv: IDENTITY, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } } }],
    };
    const block = buildRigProfileBlock(buildRigProfile(parts));
    expect(block).toContain('RIG PROFILE');
    expect(block.toLowerCase()).toContain('heuristic');
    expect(block).toContain('figure group (whole-figure target): creature');
    expect(block).toContain('torso: main_body');
    expect(block).toContain('symmetry pair: left_fin <-> right_fin');
    expect(block).toContain('bone chain: b1 -> b2 (2 bones, total length 24, deforming left_fin');
    expect(block).not.toContain('- part:'); // the no-guess role stays out of the prompt
  });
});
