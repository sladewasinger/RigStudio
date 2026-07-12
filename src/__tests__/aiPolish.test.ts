/**
 * Unit tests for AI Animate System v2 A6 "Polish" (`panels/ai/polish.ts`'s PURE
 * instruction builder — the button is interaction-tested). Mirrors
 * `aiTemplates.test.ts`'s fabrication style: a deliberately non-anatomical profile
 * (hull/dome/paddle) so every "names the target" assertion proves the text came from
 * the PROFILE/CLIP, never a hardcoded literal — reinforced by the source-grep
 * guarantee at the bottom.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPolishInstruction } from '../panels/ai/polish';
import { RigProfile } from '../ai/rigProfile';
import { Clip } from '../core/model';

const PROFILE: RigProfile = {
  chains: [{
    bones: [
      { id: 'b1', label: 'upper_bone', length: 40 },
      { id: 'b2', label: 'lower_bone', length: 35 },
    ],
    totalLength: 75,
    deforms: [{ id: 'a1', label: 'front_paddle' }],
  }],
  symmetryPairs: [],
  roles: [
    { id: 't', label: 'main_hull', role: 'torso' },
    { id: 'h', label: 'top_dome', role: 'head' },
    { id: 'a1', label: 'front_paddle', role: 'limb' },
  ],
  figureGroup: { id: 'g', label: 'creature_rig' },
};

const EMPTY_PROFILE: RigProfile = { chains: [], symmetryPairs: [], roles: [], figureGroup: null };

/** A big rotate move with real anticipation room (starts well after 0ms). */
function clipWithBigMove(): Clip {
  return {
    name: 'c',
    duration: 1000,
    tracks: [{
      target: 'a1',
      channel: 'rotate',
      keyframes: [
        { time: 200, value: 0, easing: 'linear' },
        { time: 600, value: 40, easing: 'linear' },
        { time: 1000, value: 0, easing: 'linear' },
      ],
    }],
  };
}

/** A ty track that covers its whole range in a small fraction of the clip. */
function clipWithFastVertical(): Clip {
  return {
    name: 'c',
    duration: 1000,
    tracks: [{
      target: 't',
      channel: 'ty',
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 100, value: 100, easing: 'linear' },
        { time: 1000, value: 0, easing: 'linear' },
      ],
    }],
  };
}

/** A ty track that takes half the clip to cover its range — not "fast". */
function clipWithoutFastVertical(): Clip {
  return {
    name: 'c',
    duration: 1000,
    tracks: [{
      target: 't',
      channel: 'ty',
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 500, value: 50, easing: 'linear' },
        { time: 1000, value: 50, easing: 'linear' },
      ],
    }],
  };
}

describe('polish instruction — choreography-preservation contract', () => {
  it('states the contract explicitly: preserve choreography, never retime/remove poses, pinned duration', () => {
    const text = buildPolishInstruction(PROFILE, clipWithBigMove());
    expect(text).toContain('PRESERVING THE CHOREOGRAPHY EXACTLY AS-IS');
    expect(text).toContain('do NOT retime');
    expect(text).toContain('do NOT remove or replace');
    expect(text).toContain('1000ms');
  });

  it('an EMPTY clip (no tracks) still yields usable text — no "undefined", no crash', () => {
    const empty: Clip = { name: 'c', duration: 1500, tracks: [] };
    const text = buildPolishInstruction(PROFILE, empty);
    expect(text).not.toContain('undefined');
    expect(text).toContain('1500ms');
    expect(text.toLowerCase()).toContain('follow-through');
  });
});

describe('polish instruction — anticipation candidates', () => {
  it('a big move with lead-in room becomes an anticipation candidate, named from the profile', () => {
    const text = buildPolishInstruction(PROFILE, clipWithBigMove());
    expect(text).toContain('Anticipation —');
    expect(text).toContain('front_paddle.rotate: 0 -> 40 from 200ms to 600ms.');
  });

  it('a big move starting at 0ms has NO anticipation room and is excluded from that section', () => {
    const clip: Clip = {
      name: 'c',
      duration: 1000,
      tracks: [{
        target: 'a1',
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 300, value: 50, easing: 'linear' },
        ],
      }],
    };
    const text = buildPolishInstruction(PROFILE, clip);
    expect(text).not.toContain('Anticipation —');
    // ...but it's still a valid settle-with-overshoot arrival (no room requirement there).
    expect(text).toContain('front_paddle.rotate: arrives at 50 at 300ms.');
  });
});

describe('polish instruction — follow-through', () => {
  it('names the profile\'s actual bone chain, mirroring A5\'s followThroughNote', () => {
    const text = buildPolishInstruction(PROFILE, clipWithBigMove());
    expect(text.toLowerCase()).toContain('follow-through');
    expect(text).toContain('upper_bone -> lower_bone');
    expect(text).toContain('front_paddle'); // the chain's own deforms note
  });

  it('falls back to a generic note when the rig has no bone chains', () => {
    const text = buildPolishInstruction(EMPTY_PROFILE, clipWithBigMove());
    expect(text).toContain(
      'Follow-through: wherever a part has children in the rig hierarchy, let each ' +
        "child lag 40-80ms behind its parent's motion instead of moving as one rigid slab.",
    );
    expect(text).not.toContain('bone chain');
  });
});

describe('polish instruction — squash-and-stretch (conditional)', () => {
  it('appears, naming the target, when a ty track moves fast relative to its own range/the clip duration', () => {
    const text = buildPolishInstruction(PROFILE, clipWithFastVertical());
    expect(text.toLowerCase()).toContain('squash-and-stretch');
    expect(text).toContain('main_hull');
    expect(text.toLowerCase()).toContain('subtle');
  });

  it('is omitted when the only ty motion is slow relative to the clip', () => {
    const text = buildPolishInstruction(PROFILE, clipWithoutFastVertical());
    expect(text.toLowerCase()).not.toContain('squash-and-stretch');
  });

  it('is omitted entirely when the clip has no ty track at all', () => {
    const text = buildPolishInstruction(PROFILE, clipWithBigMove());
    expect(text.toLowerCase()).not.toContain('squash-and-stretch');
  });
});

describe('polish instruction — loop-clean reminder (conditional)', () => {
  it('appears when every multi-key track already starts and ends on the same value', () => {
    const loopClean: Clip = {
      name: 'c',
      duration: 1000,
      tracks: [{
        target: 'a1',
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: 40, easing: 'linear' },
          { time: 1000, value: 0, easing: 'linear' },
        ],
      }],
    };
    expect(buildPolishInstruction(PROFILE, loopClean).toLowerCase()).toContain('loops cleanly');
  });

  it('is absent when a track\'s first and last keyframes differ', () => {
    const notLoopClean: Clip = {
      name: 'c',
      duration: 1000,
      tracks: [{
        target: 'a1',
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 40, easing: 'linear' },
        ],
      }],
    };
    expect(buildPolishInstruction(PROFILE, notLoopClean).toLowerCase()).not.toContain('loops cleanly');
  });
});

describe('polish — rig-agnostic source guarantee', () => {
  it('polish.ts contains NO rig-specific part-name literals (comments included)', () => {
    const src = readFileSync(join(__dirname, '../panels/ai/polish.ts'), 'utf8');
    for (const banned of [
      /pip/i, /left_arm/i, /right_arm/i, /left_leg/i, /right_leg/i,
      /LeftArm/, /RightArm/, /\bPants\b/, /girl/i,
    ]) {
      expect(src, `polish.ts must not mention ${banned}`).not.toMatch(banned);
    }
  });
});
