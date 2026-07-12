/**
 * Interaction tests for AI Animate System v2 "A2. Preview-before-apply": a successful
 * Create/Modify request no longer applies straight to the doc — it enters a canvas-only
 * PREVIEW (the candidate loops via view's setPoseSampler while the timeline keeps
 * showing the real clip) that the user reviews with Apply / Retry / Discard.
 *
 * Network calls are never made: `__setAnimateCallForTest` (panels/ai.ts) swaps the
 * function `runAnimate` awaits for a synchronous/deferred fabricator, so these tests
 * drive the REAL button-click → busy → preview → Apply/Retry/Discard pipeline exactly
 * as a live request would, minus the network. `window.__aiPreview` (mirrors
 * `window.__smPanel`) gives headless, deterministic access to the preview clock and
 * lifecycle without needing requestAnimationFrame to actually fire.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AnimateResult, animateWithClaude } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import { canUndo, undo } from '../../core/history';
import {
  bootRig, resetRig, setEditorMode, state, partByLabel, partMatrix, waitFor,
} from './harness';

interface RigStudioHook {
  loadProjectText: (text: string) => boolean;
  serializeDoc: (doc: NonNullable<typeof state.doc>) => string;
}
function hook(): RigStudioHook {
  return (window as unknown as { __rigStudio: RigStudioHook }).__rigStudio;
}

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
  apply: () => void;
  discard: () => void;
  busy: () => boolean;
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
function previewActionBtn(action: 'apply' | 'retry' | 'discard'): HTMLButtonElement | null {
  return aiPanel().querySelector(`[data-ai-action="${action}"]`);
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
/** The snapshot toggle is checked by default — uncheck it so runAnimate never calls
 *  the real canvas-rasterization path (irrelevant to A2, and pure overhead here). */
function disableSnapshotToggle(): void {
  const cb = aiPanel().querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
  if (cb.checked) {
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function partRotationDeg(label: string): number {
  const m = partMatrix(label);
  return Math.atan2(m.b, m.a) * (180 / Math.PI);
}

/** A fabricated AnimateResult keying left_arm.rotate 0 -> `peak` over the clip, by
 *  LABEL (exactly the shape a real structured-output response has). */
function fabricateResult(peak: number, clipName = 'ai_preview_test', durationMs = 1000): AnimateResult {
  return {
    clip: {
      name: 'ignored',
      clipName,
      duration: durationMs,
      tracks: [{
        target: 'left_arm',
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: durationMs / 2, value: peak, easing: 'linear' },
          { time: durationMs, value: 0, easing: 'linear' },
        ],
      }],
    },
    rig: null,
    clampedCount: 0,
  };
}

/** Drives the real "Create new animation" button with a fabricated, immediately-
 *  resolved response, and waits for the preview to enter. */
async function runCreate(result: AnimateResult): Promise<void> {
  __setAnimateCallForTest(async () => result);
  setApiKey();
  disableSnapshotToggle();
  typePrompt('wave the right arm');
  findBtn('Create new animation').click();
  await waitFor(() => aiHook().isActive(), { message: 'preview entered after Create' });
}

describe('AI preview-before-apply (AI Animate System v2 A2)', () => {
  beforeAll(bootRig);
  beforeEach(() => {
    resetRig();
    setEditorMode('animate');
  });
  afterEach(() => {
    // Never let a failed test's preview bleed into the next one.
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
  });

  it('a fabricated result enters preview: sampler drives the canvas, doc is untouched, clean-preview auto-enables', async () => {
    state.cleanPreview = false;
    const beforeDoc = hook().serializeDoc(state.doc!);
    const beforeAngle = partRotationDeg('left_arm');
    expect(state.dirty).toBe(false);

    await runCreate(fabricateResult(137.5));

    // MUTATION CHECK: if enterPreview ever applied straight to the doc instead of
    // previewing, these two would fail immediately (before Apply/Discard is even
    // clicked) — proving the later "discard leaves zero trace" test isn't vacuous.
    expect(hook().serializeDoc(state.doc!)).toBe(beforeDoc);
    expect(state.dirty).toBe(false);
    expect(state.cleanPreview).toBe(true); // auto-enabled on entry

    const status = aiHook().status();
    expect(status).not.toBeNull();
    expect(status!.mode).toBe('new');
    expect(status!.clipLabel).toBe('ai_preview_test');
    expect(status!.keyCount).toBe(3);
    expect(status!.structuralSummary).toBe('');

    // Sampler active: driving the preview clock to the candidate's peak keyframe moves
    // the CANVAS pose away from whatever the real doc showed — proof setPoseSampler is
    // actually wired, not just that module state changed.
    aiHook().tick(500);
    const duringAngle = partRotationDeg('left_arm');
    expect(Math.abs(duringAngle - beforeAngle)).toBeGreaterThan(5);

    // The timeline's own clip/time are untouched (canvas-only preview).
    expect(state.activeClipIndex).toBe(0);
    expect(state.currentTime).toBe(0);
  });

  it('Apply commits exactly like A1 (one undo reverts the whole thing; clean-preview restored)', async () => {
    state.cleanPreview = false;
    const clipsBefore = state.doc!.clips.length;

    await runCreate(fabricateResult(45, 'apply_test_clip'));
    expect(aiHook().isActive()).toBe(true);

    previewActionBtn('apply')!.click();

    expect(aiHook().isActive()).toBe(false);
    expect(state.cleanPreview).toBe(false); // restored to its prior value
    expect(state.doc!.clips.length).toBe(clipsBefore + 1);
    const newClip = state.doc!.clips[state.doc!.clips.length - 1];
    expect(newClip.name).toBe('apply_test_clip');
    expect(newClip.tracks[0].target).toBe(partByLabel('left_arm').id); // label resolved
    expect(state.activeClipIndex).toBe(state.doc!.clips.length - 1); // switched to it
    expect(canUndo()).toBe(true);

    undo(); // one undo reverts the WHOLE apply (rig + clip), per applyAiResult's contract
    expect(state.doc!.clips.length).toBe(clipsBefore);
  });

  it('Discard leaves zero trace: doc byte-identical, sampler cleared, chrome restored', async () => {
    state.cleanPreview = false;
    const beforeDoc = hook().serializeDoc(state.doc!);
    const beforeAngle = partRotationDeg('left_arm');

    await runCreate(fabricateResult(90));
    aiHook().tick(500);
    expect(Math.abs(partRotationDeg('left_arm') - beforeAngle)).toBeGreaterThan(5); // preview visibly active

    previewActionBtn('discard')!.click();

    expect(aiHook().isActive()).toBe(false);
    expect(hook().serializeDoc(state.doc!)).toBe(beforeDoc); // doc byte-identical
    expect(state.dirty).toBe(false);
    expect(state.cleanPreview).toBe(false); // chrome restored (prior value)
    // Sampler cleared: the canvas falls back to the REAL doc pose, not the candidate's.
    expect(Math.abs(partRotationDeg('left_arm') - beforeAngle)).toBeLessThan(0.01);
    expect(previewActionBtn('discard')).toBeNull(); // the bar itself is gone
  });

  it('Retry discards the current preview and re-enters the busy path, then shows a fresh preview', async () => {
    await runCreate(fabricateResult(20, 'first_attempt'));
    expect(aiHook().isActive()).toBe(true);

    let resolveSecond: ((r: AnimateResult) => void) | null = null;
    __setAnimateCallForTest(() => new Promise((resolve) => { resolveSecond = resolve; }));

    previewActionBtn('retry')!.click();

    // Preview exits immediately; the busy path re-enters (a new request is in flight).
    expect(aiHook().isActive()).toBe(false);
    await waitFor(() => aiHook().busy(), { message: 'busy path re-entered after Retry' });

    resolveSecond!(fabricateResult(20, 'second_attempt'));
    await waitFor(() => aiHook().isActive(), { message: 'fresh preview entered after Retry resolves' });

    expect(aiHook().busy()).toBe(false);
    expect(aiHook().status()!.clipLabel).toBe('second_attempt'); // proves a REAL re-request, not a stale replay
  });

  it('switching to Edit mode discards the preview silently (no doc mutation)', async () => {
    const beforeDoc = hook().serializeDoc(state.doc!);
    await runCreate(fabricateResult(30));
    expect(aiHook().isActive()).toBe(true);

    setEditorMode('setup');

    expect(aiHook().isActive()).toBe(false);
    expect(hook().serializeDoc(state.doc!)).toBe(beforeDoc);
    expect(state.dirty).toBe(false);

    setEditorMode('animate');
    expect(previewActionBtn('apply')).toBeNull(); // no stale preview bar reappears
  });

  it('a doc replace discards the preview silently', async () => {
    await runCreate(fabricateResult(30));
    expect(aiHook().isActive()).toBe(true);

    // A genuine replace through the exact path New/Open/Load-sample use (mirrors
    // docReplaceReset.test.ts): same content, but afterDocReplaced() resets history.
    hook().loadProjectText(hook().serializeDoc(state.doc!));

    expect(aiHook().isActive()).toBe(false);
  });

  it('starting a new request while previewing discards the old preview first', async () => {
    await runCreate(fabricateResult(10, 'preview_one'));
    expect(aiHook().status()!.clipLabel).toBe('preview_one');

    await runCreate(fabricateResult(10, 'preview_two'));
    expect(aiHook().isActive()).toBe(true);
    expect(aiHook().status()!.clipLabel).toBe('preview_two');
  });

  it('structural-only edits cannot pose-preview: the summary line carries them, the candidate track is dropped', async () => {
    const structuralResult: AnimateResult = {
      clip: {
        name: 'x', clipName: 'structural_test', duration: 1000,
        tracks: [{
          target: 'brand_new_bone', // does not exist in the doc yet
          channel: 'rotate',
          keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 500, value: 90, easing: 'linear' }],
        }],
      },
      rig: {
        addBones: [{
          label: 'brand_new_bone', pivot: { x: 0, y: 0 }, parent: null, tip: null,
          bindParts: ['left_arm'],
        }],
        reparent: [],
        movePivots: [],
      },
      clampedCount: 0,
    };
    await runCreate(structuralResult);

    const status = aiHook().status()!;
    expect(status.keyCount).toBe(0); // the track's target never resolves pre-apply
    expect(status.structuralSummary).toContain('+1 bone');
    expect(status.structuralSummary).toContain('binds left_arm');
  });
});
