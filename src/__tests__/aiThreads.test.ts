// @vitest-environment jsdom
/**
 * Unit tests for AI Animate System v2 A4 "clip-scoped refinement threads" — the STORE
 * (`panels/ai/threads.ts`, localStorage-backed) and the pure request-block builder
 * (`ai/threads.ts`). jsdom is opted in (mirrors aiApply.test.ts's docblock) purely for a
 * real `localStorage` — no DOM/canvas is exercised anywhere here.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getThread, recordTurn, clearThread, sweepStaleThreads, summarizeTracks, MAX_TURNS,
} from '../panels/ai/threads';
import { buildThreadContextBlock } from '../ai/threads';
import { makeTrack } from './helpers';

beforeEach(() => {
  localStorage.clear();
});

function turn(instruction: string, overrides: Partial<Parameters<typeof recordTurn>[2]> = {}) {
  return {
    instruction,
    mode: 'modify' as const,
    summary: 'left_arm.rotate ×2',
    clip: { duration: 1000, tracks: [] },
    ...overrides,
  };
}

describe('panels/ai/threads store', () => {
  it('getThread returns null when nothing has been recorded', () => {
    expect(getThread('doc', 'clip')).toBeNull();
  });

  it('recordTurn creates a thread with one turn, id/atMs assigned', () => {
    const t = recordTurn('doc', 'clip', turn('wave more'));
    expect(t.docName).toBe('doc');
    expect(t.clipName).toBe('clip');
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].instruction).toBe('wave more');
    expect(t.turns[0].id).toBeTruthy();
    expect(t.turns[0].atMs).toBeGreaterThan(0);
  });

  it('multiple recordTurn calls append in order', () => {
    recordTurn('doc', 'clip', turn('first'));
    recordTurn('doc', 'clip', turn('second'));
    const t = getThread('doc', 'clip')!;
    expect(t.turns.map((x) => x.instruction)).toEqual(['first', 'second']);
  });

  it(`caps at MAX_TURNS (${MAX_TURNS}), dropping the OLDEST turn first`, () => {
    for (let i = 1; i <= MAX_TURNS + 2; i++) recordTurn('doc', 'clip', turn(`turn ${i}`));
    const t = getThread('doc', 'clip')!;
    expect(t.turns).toHaveLength(MAX_TURNS);
    // Turns 1 and 2 were pruned; the surviving window is the most recent MAX_TURNS.
    expect(t.turns[0].instruction).toBe('turn 3');
    expect(t.turns[t.turns.length - 1].instruction).toBe(`turn ${MAX_TURNS + 2}`);
  });

  it('persists round-trip through localStorage (simulates a reload: a FRESH getThread call re-parses)', () => {
    recordTurn('doc', 'clip', turn('persisted'));
    const raw = localStorage.getItem('rig-studio-ai-thread:doc:clip');
    expect(raw).toBeTruthy();
    // A brand-new read (no shared in-memory cache) still finds it — proves the store is
    // genuinely storage-backed, not just an in-process singleton.
    const reread = getThread('doc', 'clip');
    expect(reread?.turns[0].instruction).toBe('persisted');
  });

  it('keys by BOTH doc name and clip name — distinct docs/clips never collide', () => {
    recordTurn('docA', 'idle', turn('a'));
    recordTurn('docB', 'idle', turn('b'));
    recordTurn('docA', 'wave', turn('c'));
    expect(getThread('docA', 'idle')!.turns[0].instruction).toBe('a');
    expect(getThread('docB', 'idle')!.turns[0].instruction).toBe('b');
    expect(getThread('docA', 'wave')!.turns[0].instruction).toBe('c');
  });

  it('clearThread removes exactly that thread, leaving others untouched', () => {
    recordTurn('doc', 'idle', turn('keep me'));
    recordTurn('doc', 'wave', turn('clear me'));
    clearThread('doc', 'wave');
    expect(getThread('doc', 'wave')).toBeNull();
    expect(getThread('doc', 'idle')).not.toBeNull();
  });

  it('sweepStaleThreads prunes threads whose clip is no longer in the doc, leaving surviving clips and other docs alone', () => {
    recordTurn('doc', 'idle', turn('survives'));
    recordTurn('doc', 'deleted_clip', turn('stale'));
    recordTurn('other_doc', 'deleted_clip', turn('unrelated doc, untouched'));

    sweepStaleThreads('doc', ['idle']); // 'deleted_clip' no longer exists in this doc

    expect(getThread('doc', 'idle')).not.toBeNull();
    expect(getThread('doc', 'deleted_clip')).toBeNull();
    expect(getThread('other_doc', 'deleted_clip')).not.toBeNull(); // untouched — different doc
  });

  it('sweepStaleThreads is a no-op when every thread\'s clip still exists', () => {
    recordTurn('doc', 'idle', turn('a'));
    recordTurn('doc', 'wave', turn('b'));
    sweepStaleThreads('doc', ['idle', 'wave', 'jump']);
    expect(getThread('doc', 'idle')).not.toBeNull();
    expect(getThread('doc', 'wave')).not.toBeNull();
  });
});

describe('summarizeTracks', () => {
  const labelOf = (id: string) => ({ p1: 'left_arm', p2: 'right_leg' }[id] ?? id);

  it('formats one entry per non-empty track as "label.channel ×count"', () => {
    const tracks = [
      makeTrack('p1', 'rotate', [[0, 0, 'linear'], [500, 45, 'linear']]),
      makeTrack('p2', 'ty', [[0, 0, 'linear']]),
    ];
    expect(summarizeTracks(tracks, labelOf)).toBe('left_arm.rotate ×2, right_leg.ty ×1');
  });

  it('resolves ids to labels via the passed lookup', () => {
    const tracks = [makeTrack('p1', 'rotate', [[0, 0, 'linear']])];
    expect(summarizeTracks(tracks, labelOf)).toContain('left_arm.rotate');
  });

  it('skips tracks with zero keyframes', () => {
    const tracks = [
      makeTrack('p1', 'rotate', [[0, 0, 'linear']]),
      makeTrack('p2', 'ty', []),
    ];
    expect(summarizeTracks(tracks, labelOf)).toBe('left_arm.rotate ×1');
  });

  it("returns 'no tracks' when every track is empty or there are none", () => {
    expect(summarizeTracks([], labelOf)).toBe('no tracks');
    expect(summarizeTracks([makeTrack('p1', 'rotate', [])], labelOf)).toBe('no tracks');
  });

  it('"root" target is passed through literally, never through labelOf', () => {
    const tracks = [makeTrack('root', 'tx', [[0, 0, 'linear']])];
    expect(summarizeTracks(tracks, labelOf)).toBe('root.tx ×1');
  });
});

describe('buildThreadContextBlock (ai/threads.ts, pure — no localStorage)', () => {
  it('returns empty string for zero turns', () => {
    expect(buildThreadContextBlock([])).toBe('');
  });

  it('includes every turn\'s instruction and summary, in order, numbered', () => {
    const block = buildThreadContextBlock([
      { instruction: 'wave the arm', mode: 'modify', summary: 'left_arm.rotate ×3' },
      { instruction: 'make it faster', mode: 'modify', summary: 'left_arm.rotate ×3' },
    ]);
    expect(block).toContain('THREAD CONTEXT');
    expect(block).toContain('1. [modify] "wave the arm" -> left_arm.rotate ×3');
    expect(block).toContain('2. [modify] "make it faster" -> left_arm.rotate ×3');
    expect(block.indexOf('wave the arm')).toBeLessThan(block.indexOf('make it faster'));
  });

  it('tells the model to increment, preserving prior work', () => {
    const block = buildThreadContextBlock([{ instruction: 'x', mode: 'modify', summary: 'y' }]);
    expect(block.toLowerCase()).toContain('increment');
    expect(block.toLowerCase()).toContain('preserving prior work');
  });

  it('adds a regenerated-candidate note only when retryNote is true', () => {
    const turns = [{ instruction: 'x', mode: 'modify' as const, summary: 'y' }];
    const plain = buildThreadContextBlock(turns);
    const retried = buildThreadContextBlock(turns, { retryNote: true });
    expect(plain.toLowerCase()).not.toContain('regenerated');
    expect(retried.toLowerCase()).toContain('regenerated');
  });
});
