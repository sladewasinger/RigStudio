/**
 * Unit tests for the AI Animate System v2 "A3. Filmstrip vision" frame-time selector —
 * `selectFilmstripTimes` (ui/snapshot.ts), pure and DOM-free: given a clip's duration and
 * tracks, decide WHEN to sample. Covers the keyframe-cluster-aware path (merging nearby
 * keys, capping at FILMSTRIP_MAX_FRAMES) and the evenly-spaced fallback (sparse/unkeyed
 * clips). The actual rendering (`renderClipFilmstrip`, `captureFilmstripFrame`) touches
 * the live canvas and is covered by the interaction suite instead.
 */

import { describe, expect, it } from 'vitest';
import { FILMSTRIP_MAX_FRAMES, selectFilmstripTimes } from '../ui/snapshot';
import { makeClip, makeTrack } from './helpers';

describe('selectFilmstripTimes', () => {
  it('falls back to evenly-spaced 0/25/50/75/100% when there are no keyframes at all', () => {
    const clip = makeClip({ duration: 1000, tracks: [] });
    expect(selectFilmstripTimes(clip)).toEqual([0, 250, 500, 750, 1000]);
  });

  it('the evenly-spaced fallback always includes 0 and the duration', () => {
    const clip = makeClip({ duration: 2000, tracks: [] });
    const times = selectFilmstripTimes(clip);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(2000);
    expect(times).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it('a zero-duration clip collapses the fallback to a single frame at 0 (no crash)', () => {
    const clip = makeClip({ duration: 0, tracks: [] });
    expect(selectFilmstripTimes(clip)).toEqual([0]);
  });

  it('fewer than 4 distinct keyframe clusters also falls back to evenly-spaced', () => {
    // Only 2 distinct times across the whole clip (a bare in/out pair) — too sparse for
    // cluster-driven sampling to mean anything.
    const clip = makeClip({
      duration: 800,
      tracks: [makeTrack('arm', 'rotate', [[0, 0, 'linear'], [800, 90, 'easeOut']])],
    });
    expect(selectFilmstripTimes(clip)).toEqual([0, 200, 400, 600, 800]);
  });

  it('exactly 4 well-separated clusters are returned as-is, sorted', () => {
    const clip = makeClip({
      duration: 2000,
      tracks: [
        makeTrack('arm', 'rotate', [[0, 0, 'linear'], [600, 45, 'linear'], [1200, -20, 'linear']]),
        makeTrack('leg', 'ty', [[1800, 10, 'linear']]),
      ],
    });
    expect(selectFilmstripTimes(clip)).toEqual([0, 600, 1200, 1800]);
  });

  it('keyframes within ~150ms of a neighbor merge into one cluster (mean, rounded)', () => {
    // [100,120,140] merge (gaps 20/20 <= 150) -> mean 120; then 500, 1000, 1500 stand
    // alone (gaps > 150) -> 4 clusters total, so the CLUSTER path is taken (not fallback).
    const clip = makeClip({
      duration: 1500,
      tracks: [
        makeTrack('a', 'rotate', [[100, 0, 'linear'], [500, 1, 'linear'], [1000, 2, 'linear'], [1500, 3, 'linear']]),
        makeTrack('b', 'rotate', [[120, 0, 'linear'], [140, 1, 'linear']]),
      ],
    });
    expect(selectFilmstripTimes(clip)).toEqual([120, 500, 1000, 1500]);
  });

  it('duplicate keyframe times across different tracks count once (Set-deduped)', () => {
    const clip = makeClip({
      duration: 1200,
      tracks: [
        makeTrack('a', 'rotate', [[0, 0, 'linear'], [400, 1, 'linear'], [800, 2, 'linear'], [1200, 3, 'linear']]),
        makeTrack('b', 'ty', [[0, 0, 'linear'], [400, 1, 'linear'], [800, 2, 'linear'], [1200, 3, 'linear']]),
      ],
    });
    expect(selectFilmstripTimes(clip)).toEqual([0, 400, 800, 1200]);
  });

  it('more than FILMSTRIP_MAX_FRAMES clusters are downsampled to exactly that many, keeping the first and last', () => {
    // 8 well-separated singleton clusters (gaps of 300ms, all > the 150ms merge window).
    const times8 = [0, 300, 600, 900, 1200, 1500, 1800, 2100];
    const clip = makeClip({
      duration: 2100,
      tracks: [makeTrack('a', 'rotate', times8.map((t, i) => [t, i, 'linear'] as [number, number, 'linear']))],
    });
    const result = selectFilmstripTimes(clip);
    expect(result.length).toBeLessThanOrEqual(FILMSTRIP_MAX_FRAMES);
    expect(result.length).toBe(FILMSTRIP_MAX_FRAMES);
    expect(result[0]).toBe(0); // first cluster always survives
    expect(result[result.length - 1]).toBe(2100); // last cluster always survives
    // Deterministic evenly-spaced index pick: idx = round(i*7/5) for i=0..5 -> 0,1,3,4,6,7.
    expect(result).toEqual([0, 300, 900, 1200, 1800, 2100]);
  });

  it('never returns more than FILMSTRIP_MAX_FRAMES regardless of how many clusters exist', () => {
    const many = Array.from({ length: 20 }, (_, i) => i * 300);
    const clip = makeClip({
      duration: many[many.length - 1],
      tracks: [makeTrack('a', 'rotate', many.map((t, i) => [t, i, 'linear'] as [number, number, 'linear']))],
    });
    expect(selectFilmstripTimes(clip).length).toBeLessThanOrEqual(FILMSTRIP_MAX_FRAMES);
  });

  it('a candidate-shaped input ({duration, tracks} without the rest of Clip) works identically', () => {
    // Mirrors panels/ai.ts's AiPreviewState — selectFilmstripTimes only needs this shape.
    const candidate = {
      duration: 1000,
      tracks: [{ keyframes: [{ time: 0 }, { time: 1000 }] }],
    };
    expect(selectFilmstripTimes(candidate)).toEqual([0, 250, 500, 750, 1000]);
  });
});
