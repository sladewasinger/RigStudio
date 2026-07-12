// @vitest-environment jsdom
/**
 * Unit tests for the AI Animate System v2 "A1. Session & intent UX" apply path:
 * clip-name sanitize/dedupe, protected-keyframe snapshot/restore (mutation-checked, per
 * ROADMAP.md's testing note for this phase), duration clamping, and the create-new /
 * modify-in-place `applyAiResult` flows including undo.
 *
 * jsdom is opted in (file docblock, same pattern as importSvg.test.ts) ONLY because
 * core/history.ts's checkpoint()/undo() dispatch a CustomEvent at `document` — no
 * canvas/SVG rendering is exercised anywhere here. Every fabricated AnimateResult below
 * passes `rig: null`, so `applyAiResult`'s structural-edits step short-circuits before
 * touching the view facade (registerPart/bindPartsToBones), which is the only reason
 * panels/ai.ts is importable at all without a real canvas.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  sanitizeClipName, snapshotProtectedKeys, enforceProtectedKeys, state,
} from '../core/model';
import { clampRawClip, RawClip, AnimateResult } from '../ai/claude';
import { applyAiResult, applyAnimateResult } from '../panels/ai';
import { undo, resetHistory, canUndo } from '../core/history';
import { makeDoc, makePart, makeClip, makeTrack, resetState } from './helpers';

beforeEach(() => {
  resetState(null);
  resetHistory();
});

// ---- clipName sanitize/dedupe ----

describe('sanitizeClipName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(sanitizeClipName('  wave  ', [])).toBe('wave');
    expect(sanitizeClipName('a    b', [])).toBe('a b');
  });

  it('falls back to a generic name when blank, null, or undefined', () => {
    expect(sanitizeClipName('', [])).toBe('New animation');
    expect(sanitizeClipName('   ', [])).toBe('New animation');
    expect(sanitizeClipName(null, [])).toBe('New animation');
    expect(sanitizeClipName(undefined, [])).toBe('New animation');
  });

  it('keeps a unique proposed name as-is', () => {
    expect(sanitizeClipName('wave', ['idle', 'jump'])).toBe('wave');
  });

  it('de-dupes like a file manager: wave, wave 2, wave 3', () => {
    expect(sanitizeClipName('wave', ['wave'])).toBe('wave 2');
    expect(sanitizeClipName('wave', ['wave', 'wave 2'])).toBe('wave 3');
    expect(sanitizeClipName('wave', ['wave', 'wave 2', 'wave 3'])).toBe('wave 4');
  });

  it('de-dupes case-insensitively', () => {
    expect(sanitizeClipName('Wave', ['wave'])).toBe('Wave 2');
    expect(sanitizeClipName('wave', ['Wave', 'WAVE 2'])).toBe('wave 3');
  });
});

// ---- protected-key snapshot/restore ----

describe('snapshotProtectedKeys / enforceProtectedKeys', () => {
  function clipWithKeys() {
    return makeClip({
      tracks: [
        makeTrack('arm', 'rotate', [[0, 0, 'linear'], [300, 45, 'easeOut'], [600, 0, 'easeIn']]),
        makeTrack('leg', 'ty', [[0, 0, 'linear'], [300, -10, 'easeOut']]),
        makeTrack('head', 'rotate', [[100, 5, 'linear']]), // no key near t=300
      ],
    });
  }

  it("snapshots exactly the keys within keyAt's 5ms tolerance of the given time", () => {
    const clip = clipWithKeys();
    const snap = snapshotProtectedKeys(clip, 302); // within tolerance of 300
    expect(snap).toHaveLength(2);
    expect(snap.find((k) => k.target === 'arm')).toMatchObject({
      channel: 'rotate', time: 300, value: 45, easing: 'easeOut',
    });
    expect(snap.find((k) => k.target === 'leg')).toMatchObject({
      channel: 'ty', time: 300, value: -10, easing: 'easeOut',
    });
    expect(snap.find((k) => k.target === 'head')).toBeUndefined();
  });

  it('returns nothing when no track has a key near the given time', () => {
    const clip = clipWithKeys();
    expect(snapshotProtectedKeys(clip, 450)).toEqual([]);
  });

  it('restores a protected key a hostile response moved, re-valued, or removed entirely', () => {
    const clip = clipWithKeys();
    const protectedKeys = snapshotProtectedKeys(clip, 300);
    expect(protectedKeys).toHaveLength(2);

    // Hostile response: arm's key re-timed AND re-valued, leg's whole track deleted.
    clip.tracks[0].keyframes[1] = { time: 305, value: 999, easing: 'linear' };
    clip.tracks = clip.tracks.filter((t) => t.target !== 'leg');

    const restored = enforceProtectedKeys(clip, protectedKeys);
    expect(restored).toBe(2);

    const armKey = clip.tracks.find((t) => t.target === 'arm')!
      .keyframes.find((k) => Math.abs(k.time - 300) <= 5)!;
    expect(armKey).toMatchObject({ time: 300, value: 45, easing: 'easeOut' });

    const legTrack = clip.tracks.find((t) => t.target === 'leg');
    expect(legTrack).toBeDefined();
    expect(legTrack!.keyframes[0]).toMatchObject({ time: 300, value: -10, easing: 'easeOut' });
  });

  it('is a no-op (0 restored) when the response left protected keys untouched', () => {
    const clip = clipWithKeys();
    const protectedKeys = snapshotProtectedKeys(clip, 300);
    expect(enforceProtectedKeys(clip, protectedKeys)).toBe(0);
  });

  it('MUTATION CHECK: without calling enforceProtectedKeys, a hostile change sticks — proving the "restores" assertions above are not vacuous', () => {
    const clip = clipWithKeys();
    snapshotProtectedKeys(clip, 300); // snapshot taken, but enforcement deliberately skipped
    clip.tracks[0].keyframes[1].value = 999;
    const armKey = clip.tracks.find((t) => t.target === 'arm')!
      .keyframes.find((k) => Math.abs(k.time - 300) <= 5)!;
    expect(armKey.value).toBe(999); // would be 45 if enforcement ran
  });
});

// ---- duration clamping ----

describe('clampRawClip (duration pin)', () => {
  function rawClip(overrides: Partial<RawClip> = {}): RawClip {
    return {
      name: 'x',
      duration: 999999, // the model drifted the duration — must be ignored
      tracks: [
        {
          target: 'arm',
          channel: 'rotate',
          keyframes: [
            { time: -50, value: 0, easing: 'linear' },
            { time: 100, value: 20, easing: 'easeOut' },
            { time: 5000, value: 40, easing: 'easeIn' },
          ],
        },
      ],
      ...overrides,
    };
  }

  it("forces the output duration to the pinned value, ignoring the response's own duration", () => {
    const { clip } = clampRawClip(rawClip(), 500);
    expect(clip.duration).toBe(500);
  });

  it('clamps out-of-range keyframe times into [0, duration] and counts how many', () => {
    const { clip, clampedCount } = clampRawClip(rawClip(), 500);
    expect(clip.tracks[0].keyframes.map((k) => k.time)).toEqual([0, 100, 500]);
    expect(clampedCount).toBe(2); // -50 -> 0, 5000 -> 500
  });

  it('leaves in-range times alone and reports zero clamps', () => {
    const clean = rawClip({
      tracks: [{
        target: 'arm', channel: 'rotate',
        keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 400, value: 20, easing: 'easeOut' }],
      }],
    });
    const { clampedCount } = clampRawClip(clean, 500);
    expect(clampedCount).toBe(0);
  });

  it('re-sorts keyframes by time after clamping (boundary collisions can reorder them)', () => {
    const raw = rawClip({
      tracks: [{
        target: 'arm',
        channel: 'rotate',
        keyframes: [
          { time: 5000, value: 1, easing: 'linear' },
          { time: -50, value: 2, easing: 'linear' },
          { time: 200, value: 3, easing: 'linear' },
        ],
      }],
    });
    const { clip } = clampRawClip(raw, 500);
    expect(clip.tracks[0].keyframes.map((k) => k.value)).toEqual([2, 3, 1]); // 0, 200, 500
  });

  it('preserves clipName and other RawClip fields untouched', () => {
    const { clip } = clampRawClip(rawClip({ clipName: 'wave' }), 500);
    expect(clip.clipName).toBe('wave');
    expect(clip.name).toBe('x');
  });
});

// ---- applyAiResult: create new animation ----

describe('applyAiResult — create new animation', () => {
  it('adds a sanitized/deduped clip and switches to it; one undo removes it and restores the prior active clip', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const doc = makeDoc([arm]); // exactly one clip ("idle") at index 0
    state.doc = doc;
    state.activeClipIndex = 0;
    resetHistory();

    const fabricated: AnimateResult = {
      clip: {
        name: 'ignored', clipName: 'wave', duration: 2000,
        tracks: [{
          target: 'left_arm', channel: 'rotate',
          keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 500, value: 45, easing: 'easeOut' }],
        }],
      },
      rig: null,
      clampedCount: 0,
    };

    const outcome = applyAiResult(fabricated, 'new', { clipName: fabricated.clip.clipName });
    expect(outcome).not.toBeNull();
    expect(state.doc!.clips).toHaveLength(2);
    expect(state.doc!.clips[1].name).toBe('wave');
    expect(state.activeClipIndex).toBe(1);
    // Track target resolved from the LABEL "left_arm" to the part's real id.
    expect(state.doc!.clips[1].tracks[0].target).toBe('arm');
    expect(outcome!.restoredCount).toBe(0);

    undo();
    // Re-read state.doc after undo — the snapshot swap replaces the object.
    expect(state.doc!.clips).toHaveLength(1);
    expect(state.doc!.clips[0].name).toBe('idle');
    expect(state.activeClipIndex).toBe(0); // restored to the prior active clip
  });

  it('dedupes the proposed name against the doc\'s existing clips', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const existing = makeClip({ name: 'wave' });
    const doc = makeDoc([arm], [existing]);
    state.doc = doc;
    state.activeClipIndex = 0;
    resetHistory();

    const fabricated: AnimateResult = {
      clip: { name: 'x', clipName: 'wave', duration: 2000, tracks: [] },
      rig: null,
      clampedCount: 0,
    };
    const outcome = applyAiResult(fabricated, 'new', { clipName: fabricated.clip.clipName });
    expect(outcome!.clip.name).toBe('wave 2');
    expect(state.doc!.clips.map((c) => c.name)).toEqual(['wave', 'wave 2']);
  });

  it('falls back to sanitizeClipName\'s generic name when clipName is missing', () => {
    const doc = makeDoc([]);
    state.doc = doc;
    resetHistory();
    const fabricated: AnimateResult = {
      clip: { name: 'x', duration: 2000, tracks: [] },
      rig: null,
      clampedCount: 0,
    };
    const outcome = applyAiResult(fabricated, 'new', {});
    expect(outcome!.clip.name).toBe('New animation');
  });

  it('drops tracks whose target label no longer resolves (unknown part)', () => {
    const doc = makeDoc([]);
    state.doc = doc;
    resetHistory();
    const fabricated: AnimateResult = {
      clip: {
        name: 'x', clipName: 'ghost', duration: 1000,
        tracks: [{ target: 'no_such_part', channel: 'rotate', keyframes: [] }],
      },
      rig: null,
      clampedCount: 0,
    };
    const outcome = applyAiResult(fabricated, 'new', { clipName: 'ghost' });
    expect(outcome!.clip.tracks).toEqual([]);
  });

  it('returns null when there is no document loaded', () => {
    state.doc = null;
    const fabricated: AnimateResult = {
      clip: { name: 'x', duration: 1000, tracks: [] }, rig: null, clampedCount: 0,
    };
    expect(applyAiResult(fabricated, 'new', {})).toBeNull();
  });
});

// ---- applyAiResult: modify current animation with protection ----

describe('applyAiResult — modify current animation with protection', () => {
  it('keeps the playhead-time keys byte-identical through a hostile fabricated response', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const leg = makePart('leg', { label: 'left_leg' });
    const clip = makeClip({
      name: 'idle',
      duration: 1000,
      tracks: [
        makeTrack('arm', 'rotate', [[0, 0, 'linear'], [500, 30, 'easeOut'], [1000, 0, 'easeIn']]),
        makeTrack('leg', 'ty', [[0, 0, 'linear'], [500, -8, 'easeOut']]),
      ],
    });
    const doc = makeDoc([arm, leg], [clip]);
    state.doc = doc;
    state.activeClipIndex = 0;
    state.currentTime = 500;
    resetHistory();

    const protectedKeys = snapshotProtectedKeys(clip, 500);
    expect(protectedKeys).toHaveLength(2);

    // Hostile fabricated response: rewrites everything by LABEL, exactly like a real
    // Claude reply would, including the two protected targets.
    const fabricated: AnimateResult = {
      clip: {
        name: 'idle', duration: 1000,
        tracks: [
          {
            target: 'left_arm', channel: 'rotate',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 500, value: 999, easing: 'linear' }, // moved value at the protected time
            ],
          },
          // left_leg's track dropped entirely.
        ],
      },
      rig: null,
      clampedCount: 0,
    };

    const outcome = applyAiResult(fabricated, 'modify', { clip, protectedKeys });
    expect(outcome).not.toBeNull();
    expect(outcome!.restoredCount).toBe(2);
    expect(outcome!.structural).toContain('restored 2 protected keys');

    const armKey = clip.tracks.find((t) => t.target === arm.id && t.channel === 'rotate')!
      .keyframes.find((k) => Math.abs(k.time - 500) <= 5)!;
    expect(armKey).toMatchObject({ time: 500, value: 30, easing: 'easeOut' });

    const legTrack = clip.tracks.find((t) => t.target === leg.id && t.channel === 'ty');
    expect(legTrack).toBeDefined();
    expect(legTrack!.keyframes[0]).toMatchObject({ time: 500, value: -8, easing: 'easeOut' });

    // Non-protected keys from the response DID apply — protection is scoped to the
    // snapshotted keys only, not a freeze of the whole clip.
    const armStart = clip.tracks.find((t) => t.target === arm.id)!
      .keyframes.find((k) => k.time === 0)!;
    expect(armStart.value).toBe(0);
  });

  it('without protection, a hostile response is applied verbatim (protection is opt-in)', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const clip = makeClip({ tracks: [makeTrack('arm', 'rotate', [[500, 30, 'easeOut']])] });
    const doc = makeDoc([arm], [clip]);
    state.doc = doc;
    resetHistory();

    const fabricated: AnimateResult = {
      clip: {
        name: 'idle', duration: 2000,
        tracks: [{ target: 'left_arm', channel: 'rotate', keyframes: [{ time: 500, value: 999, easing: 'linear' }] }],
      },
      rig: null,
      clampedCount: 0,
    };
    const outcome = applyAiResult(fabricated, 'modify', { clip }); // no protectedKeys passed
    expect(outcome!.restoredCount).toBe(0);
    expect(clip.tracks[0].keyframes[0].value).toBe(999);
  });

  it('checkpoints exactly once — one undo reverts the whole modify', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const clip = makeClip({ tracks: [] });
    const doc = makeDoc([arm], [clip]);
    state.doc = doc;
    resetHistory();

    const fabricated: AnimateResult = {
      clip: {
        name: 'idle', duration: 2000,
        tracks: [{ target: 'left_arm', channel: 'rotate', keyframes: [{ time: 0, value: 10, easing: 'linear' }] }],
      },
      rig: null,
      clampedCount: 0,
    };
    applyAiResult(fabricated, 'modify', { clip });
    expect(state.doc!.clips[0].tracks).toHaveLength(1);

    undo();
    expect(state.doc!.clips[0].tracks).toHaveLength(0);
  });
});

// ---- applyAnimateResult (back-compat wrapper) ----

describe('applyAnimateResult (back-compat wrapper, pre-A1 single-button behavior)', () => {
  it('still edits the given clip in place and returns the structural summary string', () => {
    const arm = makePart('arm', { label: 'left_arm' });
    const clip = makeClip({ tracks: [] });
    const doc = makeDoc([arm], [clip]);
    state.doc = doc;
    resetHistory();

    const result: AnimateResult = {
      clip: {
        name: 'x', duration: 2000,
        tracks: [{ target: 'left_arm', channel: 'rotate', keyframes: [{ time: 0, value: 10, easing: 'linear' }] }],
      },
      rig: null,
      clampedCount: 0,
    };
    const structural = applyAnimateResult(clip, result);
    expect(structural).toBe('');
    expect(clip.tracks[0].target).toBe('arm');
  });

  it('returns "" and does nothing for a null clip — no checkpoint is pushed', () => {
    const doc = makeDoc([]);
    state.doc = doc;
    resetHistory();
    expect(canUndo()).toBe(false);
    const out = applyAnimateResult(null, {
      clip: { name: 'x', duration: 1, tracks: [] }, rig: null, clampedCount: 0,
    });
    expect(out).toBe('');
    expect(canUndo()).toBe(false); // a no-op call must not have checkpointed
  });
});
