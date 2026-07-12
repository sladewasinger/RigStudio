/**
 * Unit tests for AI Animate System v2 A5 motion templates (`panels/ai/templates.ts`,
 * the PURE archetype builders — the button row is interaction-tested). The fabricated
 * profile uses deliberately NON-anatomical labels (fin/hull/dome) so every "names the
 * target" assertion proves the text came from the PROFILE, not from anything the
 * template hardcodes — reinforced by the source-grep test at the bottom (no rig-
 * specific part-name literals anywhere in templates.ts, comments included).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOTION_TEMPLATES } from '../panels/ai/templates';
import { RigProfile } from '../ai/rigProfile';

const PROFILE: RigProfile = {
  chains: [{
    bones: [
      { id: 'b1', label: 'upper_bone', length: 40 },
      { id: 'b2', label: 'lower_bone', length: 35 },
    ],
    totalLength: 75,
    deforms: [{ id: 'a1', label: 'front_paddle' }],
  }],
  symmetryPairs: [{
    base: 'fin',
    left: { id: 'p1', label: 'fin_left' },
    right: { id: 'p2', label: 'fin_right' },
    mirrored: true,
  }],
  roles: [
    { id: 't', label: 'main_hull', role: 'torso' },
    { id: 'h', label: 'top_dome', role: 'head' },
    { id: 'p1', label: 'fin_left', role: 'limb' },
    { id: 'p2', label: 'fin_right', role: 'limb' },
    { id: 'a1', label: 'front_paddle', role: 'limb' },
  ],
  figureGroup: { id: 'g', label: 'creature_rig' },
};

const EMPTY: RigProfile = { chains: [], symmetryPairs: [], roles: [], figureGroup: null };

/** Parse the beat-map lines "- {from}–{to}ms (name): ..." out of an instruction. */
function beats(text: string): { from: number; to: number }[] {
  return [...text.matchAll(/^- (\d+)–(\d+)ms \(/gm)]
    .map((m) => ({ from: Number(m[1]), to: Number(m[2]) }));
}

function byId(id: string) {
  const t = MOTION_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template "${id}"`);
  return t;
}

describe('motion templates — archetype instructions', () => {
  it('ships exactly the five A5 archetypes', () => {
    expect(MOTION_TEMPLATES.map((t) => t.id)).toEqual(
      ['walk', 'breathe', 'jump', 'wave', 'gesture'],
    );
  });

  it('every archetype: beat map covers 0..duration contiguously, in order, on 10ms grid', () => {
    for (const t of MOTION_TEMPLATES) {
      for (const d of [1000, 2000, 3000]) {
        const text = t.build(PROFILE, d);
        const bs = beats(text);
        expect(bs.length, `${t.id}@${d}`).toBeGreaterThanOrEqual(3);
        expect(bs[0].from, `${t.id}@${d} starts at 0`).toBe(0);
        expect(bs[bs.length - 1].to, `${t.id}@${d} ends at the set duration`).toBe(d);
        for (let i = 0; i < bs.length; i++) {
          expect(bs[i].to, `${t.id}@${d} beat ${i} ordered`).toBeGreaterThan(bs[i].from);
          if (i > 0) expect(bs[i].from, `${t.id}@${d} contiguous`).toBe(bs[i - 1].to);
          expect(bs[i].from % 10, `${t.id}@${d} 10ms grid`).toBe(0);
        }
        expect(text, `${t.id}@${d} states the duration`).toContain(`${d}ms`);
      }
    }
  });

  it('a non-10ms-multiple duration still ends exactly at the duration (clamped, never past)', () => {
    for (const t of MOTION_TEMPLATES) {
      const bs = beats(t.build(PROFILE, 1995));
      expect(bs[bs.length - 1].to).toBe(1995);
      for (const b of bs) expect(b.to).toBeLessThanOrEqual(1995);
    }
  });

  it('walk: names the symmetry pair as striders, counter-phase note, torso bob', () => {
    const text = byId('walk').build(PROFILE, 2000);
    expect(text).toContain('fin_left');
    expect(text).toContain('fin_right');
    expect(text).toContain('main_hull'); // torso bob target
    expect(text.toLowerCase()).toContain('counter-phase');
  });

  it('breathe: targets the torso role with head lag', () => {
    const text = byId('breathe').build(PROFILE, 2000);
    expect(text).toContain('main_hull');
    expect(text).toContain('top_dome');
    expect(text.toLowerCase()).toContain('inhale');
  });

  it('jump: targets the figure group with squash-and-stretch beats', () => {
    const text = byId('jump').build(PROFILE, 2000);
    expect(text).toContain('creature_rig');
    expect(text.toLowerCase()).toContain('squash');
    expect(text.toLowerCase()).toContain('anticipation');
  });

  it('wave: leads with the chain-deformed part and spells the chain for follow-through', () => {
    const text = byId('wave').build(PROFILE, 2000);
    expect(text).toContain('front_paddle');
    expect(text).toContain('upper_bone -> lower_bone');
    expect(text.toLowerCase()).toContain('follow-through');
  });

  it('wave without chains falls back to the pair\'s right side; without pairs, to a limb', () => {
    const noChains: RigProfile = { ...PROFILE, chains: [] };
    expect(byId('wave').build(noChains, 2000)).toContain('Primary target: fin_right');
    const noPairs: RigProfile = { ...noChains, symmetryPairs: [] };
    expect(byId('wave').build(noPairs, 2000)).toContain('Primary target: fin_left'); // first limb role
  });

  it('gesture: wind-up/strike beats naming the limb and the supporting torso', () => {
    const text = byId('gesture').build(PROFILE, 2000);
    expect(text).toContain('front_paddle');
    expect(text).toContain('main_hull');
    expect(text.toLowerCase()).toContain('wind-up');
  });

  it('an EMPTY profile still yields a usable generic instruction (no "undefined", still beat-mapped)', () => {
    for (const t of MOTION_TEMPLATES) {
      const text = t.build(EMPTY, 1500);
      expect(text).not.toContain('undefined');
      expect(text).toContain('Beat map');
      expect(beats(text).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('motion templates — rig-agnostic source guarantee', () => {
  it('templates.ts contains NO rig-specific part-name literals (comments included)', () => {
    const src = readFileSync(join(__dirname, '../panels/ai/templates.ts'), 'utf8');
    // The bundled sample's and the girl fixture's identifying names — none may appear.
    for (const banned of [
      /pip/i, /left_arm/i, /right_arm/i, /left_leg/i, /right_leg/i,
      /LeftArm/, /RightArm/, /\bPants\b/, /girl/i,
    ]) {
      expect(src, `templates.ts must not mention ${banned}`).not.toMatch(banned);
    }
  });
});
