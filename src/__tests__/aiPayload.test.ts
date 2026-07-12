/**
 * Unit tests for the AI Animate System v2 "A0. Targeting & root demotion" request
 * payload — the part hierarchy tree, the current selection, and the "never key root"
 * prompt rule. Exercises `buildScenePayload` (a pure function factored out of
 * ai/claude.ts specifically so this needs no live API call) plus the exported prompt
 * text constants. No network I/O anywhere in this file.
 */

import { describe, expect, it } from 'vitest';
import { buildScenePayload, SYSTEM, TARGETING_RULES } from '../ai/claude';
import { makeClip, makeDoc, makePart, makeTrack } from './helpers';

describe('buildScenePayload (AI request payload builder)', () => {
  it('includes an indented tree with nesting and kinds', () => {
    const body = makePart('body', { label: 'body', kind: 'group', parentId: null });
    const arm = makePart('arm', { label: 'left_arm', kind: 'art', parentId: 'body' });
    const hand = makePart('hand', { label: 'left_hand', kind: 'bone', parentId: 'arm' });
    // A shadow deliberately OUTSIDE the figure group — the exact case root demotion
    // exists to protect (CLAUDE.md "the shadow-follows-pip bug class dies here").
    const shadow = makePart('shadow', { label: 'shadow', kind: 'art', parentId: null });
    const doc = makeDoc([body, arm, hand, shadow]);

    const payload = buildScenePayload(doc, makeClip(), []);

    expect(payload.tree).toBe(
      'body (group)\n  left_arm (art)\n    left_hand (bone)\nshadow (art)',
    );
  });

  it('never hangs on a corrupted parent cycle (defensive — real docs are cycle-safe)', () => {
    const a = makePart('a', { label: 'a', parentId: 'b' });
    const b = makePart('b', { label: 'b', parentId: 'a' });
    const doc = makeDoc([a, b]);
    const payload = buildScenePayload(doc, makeClip(), []);
    expect(payload.tree).toBe(''); // neither node has a resolvable root parent
  });

  it('reports the current selection as {id, label} pairs, dropping unknown ids', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const leg = makePart('leg', { label: 'left_leg' });
    const doc = makeDoc([arm, leg]);

    const payload = buildScenePayload(doc, makeClip(), ['arm', 'nonexistent']);

    expect(payload.selection).toEqual([{ id: 'arm', label: 'left_arm' }]);
  });

  it('defaults to an empty selection when none is passed', () => {
    const doc = makeDoc([makePart('p1', { label: 'p1' })]);
    const payload = buildScenePayload(doc, makeClip());
    expect(payload.selection).toEqual([]);
  });

  it('still resolves track targets (incl. legacy "root") and part parents to labels', () => {
    const body = makePart('body', { label: 'body', kind: 'group' });
    const arm = makePart('arm', { label: 'left_arm', parentId: 'body' });
    const clip = makeClip({
      tracks: [
        makeTrack('arm', 'rotate', [[0, 0, 'linear'], [500, 45, 'easeOut']]),
        makeTrack('root', 'ty', [[0, 0, 'linear'], [500, -20, 'easeOut']]), // legacy track
      ],
    });
    const doc = makeDoc([body, arm], [clip]);

    const payload = buildScenePayload(doc, clip, []);

    const armPart = payload.parts.find((p) => p.label === 'left_arm')!;
    expect(armPart.parent).toBe('body');
    const armTrack = payload.currentClip.tracks.find((t) => t.target === 'left_arm')!;
    expect(armTrack.channel).toBe('rotate');
    const rootTrack = payload.currentClip.tracks.find((t) => t.target === 'root')!;
    expect(rootTrack.channel).toBe('ty'); // legacy root track passes through unresolved-as-is
  });
});

describe('AI prompt text — root demotion hard rule', () => {
  it('TARGETING_RULES forbids keying root and explains the group-targeting alternative', () => {
    expect(TARGETING_RULES.toLowerCase()).toContain('never set a track');
    expect(TARGETING_RULES).toContain('"root"');
    expect(TARGETING_RULES.toLowerCase()).toContain('group');
    expect(TARGETING_RULES.toLowerCase()).toContain('shadow');
  });

  it('the assembled animate SYSTEM prompt carries the never-root rule and mentions selection/tree', () => {
    expect(SYSTEM).toContain(TARGETING_RULES);
    expect(SYSTEM.toLowerCase()).toContain('selection');
    expect(SYSTEM.toLowerCase()).toContain('tree');
  });
});
