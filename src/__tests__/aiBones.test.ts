/**
 * Unit tests for bones-aware AI prompting (the 2026-07-12 skinned-pose ruling, after a
 * user-confirmed failure: a generated "gesture" keyed rotate directly on skinned limb
 * parts — one swung as a rigid slab, another double-rotated on top of its articulated
 * bones). Pins the three enforcement layers:
 *  - the scene payload marks skinned parts (`skinned: true` + their controlling chain
 *    root→leaf in `bones`) so the model can see the posing mechanism;
 *  - the prompt text teaches bones-first articulation and forbids sx/sy on skinned
 *    parts (string pins, like aiPayload.test.ts's root-demotion suite);
 *  - `clampRawClip` DROPS forbidden sx/sy-on-skinned tracks while keeping bone tracks
 *    and legitimate part-level rotate/tx/ty (whole-limb accents per the ruling).
 * Plus the aiTemplates.test.ts-style source grep keeping prompts.ts rig-agnostic, and
 * the A5 profile block's posing-handles/bone-driven wording.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildScenePayload, clampRawClip, RawClip } from '../ai/claude';
import { CRITIQUE_SYSTEM, RIG_SEMANTICS, SYSTEM, TARGETING_RULES } from '../ai/prompts';
import { buildRigProfileBlock } from '../ai/profileBlock';
import { buildRigProfile } from '../ai/rigProfile';
import { IDENTITY } from '../geometry/transforms';
import { RigPart } from '../core/model';
import { makeClip, makeDoc, makePart, makePath } from './helpers';

function bone(id: string, parentId: string | null, pivot: { x: number; y: number },
  tip: { x: number; y: number }): RigPart {
  return makePart(id, { kind: 'bone', label: id, parentId, pivot, boneTip: tip, paths: [] });
}

function skinOf(boneIds: string[]): NonNullable<RigPart['skin']> {
  return {
    bones: boneIds.map((b) => ({
      id: b, restWorldInv: IDENTITY, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } },
    })),
  };
}

/** A limb-like art part deformed by a 2-bone chain parented under it (Bones 2.0
 *  hierarchy-as-assignment), plus an unskinned bystander. Non-anatomical labels, per
 *  the rig-agnostic convention. */
function skinnedDoc() {
  const limb = makePart('limb', {
    label: 'front_paddle', paths: [makePath('p1')], skin: skinOf(['b1', 'b2']),
  });
  const b1 = bone('b1', 'limb', { x: 0, y: 0 }, { x: 10, y: 0 });
  const b2 = bone('b2', 'b1', { x: 10, y: 0 }, { x: 20, y: 0 });
  const hull = makePart('hull', { label: 'main_hull', paths: [makePath('p2')] });
  return makeDoc([limb, b1, b2, hull]);
}

describe('buildScenePayload — skinned parts advertise their bone chain', () => {
  it('marks a skinned part with skinned: true and its chain ids+labels root→leaf', () => {
    const payload = buildScenePayload(skinnedDoc(), makeClip(), []);
    const limb = payload.parts.find((p) => p.label === 'front_paddle')!;
    expect(limb.skinned).toBe(true);
    expect(limb.bones).toEqual([
      { id: 'b1', label: 'b1' },
      { id: 'b2', label: 'b2' },
    ]);
  });

  it('resolves the FULL chain root→leaf even when skin.bones lists only the leaf, shuffled doc order', () => {
    // skin.bones is bind-time order and may lag a chain grown after binding — the
    // payload resolves through boneChain instead, then orders by parent links.
    const limb = makePart('limb', {
      label: 'front_paddle', paths: [makePath('p1')], skin: skinOf(['b2']),
    });
    const b1 = bone('b1', 'limb', { x: 0, y: 0 }, { x: 10, y: 0 });
    const b2 = bone('b2', 'b1', { x: 10, y: 0 }, { x: 20, y: 0 });
    const doc = makeDoc([b2, limb, b1]); // doc order deliberately NOT root-first
    const payload = buildScenePayload(doc, makeClip(), []);
    const entry = payload.parts.find((p) => p.label === 'front_paddle')!;
    expect(entry.bones).toEqual([
      { id: 'b1', label: 'b1' },
      { id: 'b2', label: 'b2' },
    ]);
  });

  it('unskinned parts (and the bones themselves) carry NO skinned/bones fields', () => {
    const payload = buildScenePayload(skinnedDoc(), makeClip(), []);
    for (const label of ['main_hull', 'b1', 'b2']) {
      const entry = payload.parts.find((p) => p.label === label)!;
      expect(entry.skinned).toBeUndefined();
      expect(entry.bones).toBeUndefined();
    }
  });

  it('the tree and flat list keep the chain\'s parent linkage under the limb visible', () => {
    const payload = buildScenePayload(skinnedDoc(), makeClip(), []);
    expect(payload.tree).toBe(
      'front_paddle (art)\n  b1 (bone)\n    b2 (bone)\nmain_hull (art)',
    );
    expect(payload.parts.find((p) => p.label === 'b1')!.parent).toBe('front_paddle');
    expect(payload.parts.find((p) => p.label === 'b2')!.parent).toBe('b1');
  });
});

describe('AI prompt text — bones-first articulation rules', () => {
  it('TARGETING_RULES teaches keying rotate on the BONES, root-first with a cascade', () => {
    const lower = TARGETING_RULES.toLowerCase();
    expect(TARGETING_RULES).toContain('"skinned": true');
    expect(lower).toContain('key "rotate" on its bones, root-first');
    expect(lower).toContain('40-80ms');
    expect(lower).toContain('rigid slab');
  });

  it('allows part-level rotate/tx/ty only as an accent, never a redundant duplicate', () => {
    const lower = TARGETING_RULES.toLowerCase();
    expect(lower).toContain('rotate/tx/ty on a skinned part moves the whole limb rigidly');
    expect(lower).toContain('never a substitute');
    expect(lower).toContain('never a redundant duplicate');
  });

  it('forbids sx/sy on skinned parts in BOTH the targeting rules and the channel docs', () => {
    expect(TARGETING_RULES.toLowerCase()).toContain('never key sx/sy on a skinned part');
    expect(RIG_SEMANTICS.toLowerCase()).toContain('forbidden on skinned');
  });

  it('carries the compact wrong/right failure example', () => {
    const lower = TARGETING_RULES.toLowerCase();
    expect(lower).toContain('wrong');
    expect(lower).toContain('right');
    expect(lower).toContain('cascading');
  });

  it('both assembled system prompts (animate AND critique) carry the skinned rules', () => {
    expect(SYSTEM).toContain(TARGETING_RULES);
    expect(CRITIQUE_SYSTEM).toContain(TARGETING_RULES);
  });
});

describe('clampRawClip — drops forbidden sx/sy tracks on skinned parts', () => {
  const raw = (): RawClip => ({
    name: 'x',
    duration: 1000,
    tracks: [
      { target: 'front_paddle', channel: 'sx', keyframes: [
        { time: 0, value: 1, easing: 'linear' }, { time: 500, value: 1.2, easing: 'easeOut' },
      ] },
      { target: 'front_paddle', channel: 'sy', keyframes: [
        { time: 0, value: 1, easing: 'linear' },
      ] },
      { target: 'front_paddle', channel: 'rotate', keyframes: [
        { time: 0, value: 0, easing: 'linear' }, { time: 500, value: -20, easing: 'easeOut' },
      ] },
      { target: 'front_paddle', channel: 'tx', keyframes: [
        { time: 0, value: 0, easing: 'linear' },
      ] },
      { target: 'b1', channel: 'rotate', keyframes: [
        { time: 0, value: 0, easing: 'linear' }, { time: 500, value: 30, easing: 'easeInOut' },
      ] },
      { target: 'main_hull', channel: 'sx', keyframes: [
        { time: 0, value: 1, easing: 'linear' },
      ] },
    ],
  });
  const skinned = new Set(['front_paddle']);

  it('removes sx/sy on the skinned part, keeps bone rotate + part rotate/tx and unskinned sx', () => {
    const { clip } = clampRawClip(raw(), 1000, skinned);
    const keys = clip.tracks.map((t) => `${t.target}.${t.channel}`);
    expect(keys).toEqual([
      'front_paddle.rotate', 'front_paddle.tx', 'b1.rotate', 'main_hull.sx',
    ]);
  });

  it('counts each dropped keyframe in clampedCount (the panel\'s surfacing channel)', () => {
    const { clampedCount } = clampRawClip(raw(), 1000, skinned);
    expect(clampedCount).toBe(3); // 2 sx keys + 1 sy key dropped, nothing out of range
  });

  it('still counts genuine out-of-range clamps on the surviving tracks', () => {
    const r = raw();
    r.tracks[4].keyframes.push({ time: 5000, value: 0, easing: 'linear' }); // b1.rotate
    const { clampedCount } = clampRawClip(r, 1000, skinned);
    expect(clampedCount).toBe(4); // 3 dropped keys + 1 clamped time
  });

  it('without a skinnedLabels set, nothing is dropped (back-compat default)', () => {
    const { clip, clampedCount } = clampRawClip(raw(), 1000);
    expect(clip.tracks).toHaveLength(6);
    expect(clampedCount).toBe(0);
  });
});

describe('rig profile block — chains read as posing handles', () => {
  it('spells the chain as THE POSING HANDLES for its deformed part and tags the role bone-driven', () => {
    const doc = skinnedDoc();
    const block = buildRigProfileBlock(buildRigProfile(doc.parts));
    expect(block).toContain(
      '- bone chain: b1 -> b2 (2 bones, total length 20, deforming front_paddle) — the ' +
        'POSING HANDLES for front_paddle: key rotate on these bones, root-first, to bend it',
    );
    expect(block).toContain('limb: front_paddle (bone-driven)');
  });

  it('a chain deforming nothing gets no posing-handles clause', () => {
    const doc = makeDoc([
      bone('b1', null, { x: 0, y: 0 }, { x: 10, y: 0 }),
    ]);
    const block = buildRigProfileBlock(buildRigProfile(doc.parts));
    expect(block).toContain('- bone chain: b1 (1 bone, total length 10)');
    expect(block).not.toContain('POSING HANDLES');
  });
});

describe('prompts.ts — rig-agnostic source guarantee', () => {
  it('prompts.ts contains NO rig-specific part-name literals (comments included)', () => {
    const src = readFileSync(join(__dirname, '../ai/prompts.ts'), 'utf8');
    // The bundled sample's and the girl fixture's identifying names — none may appear.
    for (const banned of [
      /pip/i, /left_arm/i, /right_arm/i, /left_leg/i, /right_leg/i,
      /LeftArm/, /RightArm/, /\bPants\b/, /girl/i,
    ]) {
      expect(src, `prompts.ts must not mention ${banned}`).not.toMatch(banned);
    }
  });
});
