/**
 * Interaction tests for AI Animate System v2 "A3. Filmstrip vision": rendering N frames
 * of a clip (instead of a single playhead snapshot) needs a real canvas/CTM, so this
 * lives in the interaction suite rather than the unit one (which covers the pure
 * `selectFilmstripTimes` time-selection logic — see `../filmstrip.test.ts`).
 *
 * Two paths, two invariants:
 *   - DOC path (`renderClipFilmstrip`, ui/snapshot.ts): scrubs `state.currentTime`
 *     across the active clip's frame times and MUST restore it — and the rendered pose
 *     — byte-exact even though rasterization is async. Mutation-checked by hand while
 *     writing this file: commenting out the `finally` restore in `renderClipFilmstrip`
 *     made the first test below fail (`state.currentTime` stuck at the last sampled
 *     frame time instead of the pre-capture value) — confirming the assertion isn't
 *     vacuous.
 *   - CANDIDATE path (`renderCandidateFilmstrip`, panels/ai.ts, exposed here via
 *     `window.__aiPreview.renderFilmstrip`) — the A2×A3 synergy Retry uses: frames must
 *     come from the PREVIEW's candidate pose, not the doc's, at the same wall-clock time.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AnimateResult, animateWithClaude } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import { activeClip, Clip } from '../../core/model';
import {
  captureFilmstripFrame, FilmstripFrame, renderClipFilmstrip, selectFilmstripTimes,
} from '../../ui/snapshot';
import {
  bootRig, resetRig, setEditorMode, state, partByLabel, partMatrix, renderPose, waitFor,
} from './harness';

interface AiPreviewStatus {
  mode: 'new' | 'modify';
  clipLabel: string;
  keyCount: number;
  structuralSummary: string;
  timeMs: number;
  duration: number;
}
interface AiPreviewHook {
  isActive: () => boolean;
  status: () => AiPreviewStatus | null;
  tick: (dtMs: number) => { timeMs: number } | null;
  discard: () => void;
  busy: () => boolean;
  renderFilmstrip: () => Promise<FilmstripFrame[]>;
}
function aiHook(): AiPreviewHook {
  return (window as unknown as { __aiPreview: AiPreviewHook }).__aiPreview;
}

function aiPanel(): HTMLElement {
  const el = document.querySelector('.ai-panel');
  if (!el) throw new Error('.ai-panel not mounted — call setEditorMode(\'animate\') first');
  return el as HTMLElement;
}
function findBtn(text: string): HTMLButtonElement {
  const btn = Array.from(aiPanel().querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn as HTMLButtonElement;
}
function typePrompt(text: string): void {
  const box = aiPanel().querySelector('textarea') as HTMLTextAreaElement;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
function setApiKey(v = 'sk-test-key'): void {
  const input = aiPanel().querySelector('input[type="password"]') as HTMLInputElement;
  input.value = v;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function partRotationDeg(label: string): number {
  const m = partMatrix(label);
  return Math.atan2(m.b, m.a) * (180 / Math.PI);
}

/** Overwrite the active clip's tracks with a known, cluster-friendly shape: 4 keyframes
 *  on left_arm.rotate spaced 600ms apart (well past the 150ms cluster-merge window),
 *  duration 1800ms — the CLUSTER path of `selectFilmstripTimes` returns exactly these 4
 *  times, so both the frame COUNT and the fact poses genuinely differ across the strip
 *  are deterministic. */
function setKnownClip(): Clip {
  const clip = activeClip()!;
  clip.duration = 1800;
  clip.tracks = [{
    target: partByLabel('left_arm').id,
    channel: 'rotate',
    keyframes: [
      { time: 0, value: 0, easing: 'linear' },
      { time: 600, value: 40, easing: 'linear' },
      { time: 1200, value: -40, easing: 'linear' },
      { time: 1800, value: 0, easing: 'linear' },
    ],
  }];
  return clip;
}

/** A fabricated AnimateResult keying left_arm.rotate 0 -> peak -> 0 over 1000ms, with a
 *  keyframe exactly at t=500 (the clip's midpoint) — 3 keyframes total, which is fewer
 *  than FILMSTRIP_MIN_CLUSTERS, so `selectFilmstripTimes` takes the evenly-spaced
 *  fallback (0/250/500/750/1000) and t=500 is always one of the returned frame times. */
function fabricateResult(peak: number, clipName = 'filmstrip_candidate_test'): AnimateResult {
  return {
    clip: {
      name: 'ignored',
      clipName,
      duration: 1000,
      tracks: [{
        target: 'left_arm',
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: peak, easing: 'linear' },
          { time: 1000, value: 0, easing: 'linear' },
        ],
      }],
    },
    rig: null,
    clampedCount: 0,
  };
}

describe('AI Animate System v2 A3 (filmstrip vision) — interaction', () => {
  beforeAll(bootRig);
  beforeEach(() => {
    resetRig();
    setEditorMode('animate');
  });
  afterEach(() => {
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
  });

  describe('DOC path (renderClipFilmstrip)', () => {
    it('returns the expected frame count with non-empty PNG data URLs, and restores currentTime + pose byte-exact', async () => {
      const clip = setKnownClip();
      state.currentTime = 333; // an arbitrary, non-frame-boundary starting point
      renderPose(); // establish the ACTUAL pre-capture rendered pose to compare against
      const beforeAngle = partRotationDeg('left_arm');

      const expectedTimes = selectFilmstripTimes(clip);
      expect(expectedTimes).toEqual([0, 600, 1200, 1800]); // cluster path, not the fallback

      const frames = await renderClipFilmstrip(clip);

      expect(frames.length).toBe(expectedTimes.length);
      expect(frames.map((f) => f.timeMs)).toEqual(expectedTimes);
      for (const f of frames) {
        expect(f.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        expect(f.dataUrl.length).toBeGreaterThan(200); // a real rasterized payload, not a stub
      }
      // The pose genuinely differs across the strip (0°, 40°, -40°, 0° keyed) — proof
      // each frame was captured at its OWN time, not 4 copies of one pose.
      expect(new Set(frames.map((f) => f.dataUrl)).size).toBeGreaterThan(1);

      // THE invariant that matters: byte-exact restoration of state + the rendered DOM,
      // despite 4 rounds of async rasterization in between.
      expect(state.currentTime).toBe(333);
      expect(partRotationDeg('left_arm')).toBeCloseTo(beforeAngle, 5);
    });

    it('restores currentTime even when a frame fails to rasterize partway through (try/finally)', async () => {
      const clip = setKnownClip();
      state.currentTime = 77;
      // Sabotage the viewBox mid-flight is impractical from outside; instead exercise
      // the same guarantee this function relies on (captureFilmstripFrame returning
      // null rather than throwing on a degenerate viewBox) by zeroing it for the
      // duration of the call — renderClipFilmstrip must still restore currentTime.
      const savedViewBox = { ...state.doc!.viewBox };
      state.doc!.viewBox = { x: 0, y: 0, w: 0, h: 0 };
      const frames = await renderClipFilmstrip(clip);
      state.doc!.viewBox = savedViewBox;

      expect(frames.length).toBe(0); // every frame's capture bailed out (zero-size viewBox)
      expect(state.currentTime).toBe(77); // restored regardless
    });
  });

  describe('CANDIDATE path (renderCandidateFilmstrip, exposed as __aiPreview.renderFilmstrip)', () => {
    async function runCreate(result: AnimateResult): Promise<void> {
      __setAnimateCallForTest(async () => result);
      setApiKey();
      // Leave the filmstrip checkbox at its default (checked) — irrelevant here since
      // this test drives runCreate's OWN request with no candidate frames yet (mode
      // 'new' fabricator resolves instantly), then calls the filmstrip hook directly.
      typePrompt('wave the right arm');
      findBtn('Create new animation').click();
      await waitFor(() => aiHook().isActive(), { message: 'preview entered after Create' });
    }

    it('samples the CANDIDATE, not the doc, at each frame time — and restores the preview clock', async () => {
      // Reference: what the DOC itself renders at t=500, BEFORE any preview exists.
      const savedTime = state.currentTime;
      state.currentTime = 500;
      const docFrame500 = await captureFilmstripFrame(500);
      state.currentTime = savedTime;
      expect(docFrame500).not.toBeNull();

      await runCreate(fabricateResult(137.5));
      const beforeTimeMs = aiHook().status()!.timeMs; // 0 — no real rAF tick in a headless/unfocused tab

      const candidateFrames = await aiHook().renderFilmstrip();

      expect(candidateFrames.length).toBeGreaterThan(0);
      for (const f of candidateFrames) expect(f.dataUrl.startsWith('data:image/png;base64,')).toBe(true);

      // Restore invariant on the CANDIDATE path: the preview clock and the doc's own
      // currentTime are both untouched by the capture batch.
      expect(aiHook().status()!.timeMs).toBe(beforeTimeMs);
      expect(state.currentTime).toBe(savedTime);

      // The candidate's frame at its keyed peak (t=500, 137.5°) must differ from what
      // the DOC renders at that same t — proof the filmstrip sampled the CANDIDATE.
      const candidateAt500 = candidateFrames.find((f) => f.timeMs === 500);
      expect(candidateAt500).toBeDefined();
      expect(candidateAt500!.dataUrl).not.toBe(docFrame500!.dataUrl);
    });

    it('resolves to [] when no preview is active', async () => {
      expect(aiHook().isActive()).toBe(false);
      const frames = await aiHook().renderFilmstrip();
      expect(frames).toEqual([]);
    });
  });
});
