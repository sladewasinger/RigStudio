/**
 * Interaction tests for AI Animate System v2 A4 "clip-scoped refinement threads": a
 * per (doc, clip) conversation recorded ONLY on a successful Apply (never on preview-
 * entry, Discard, or an un-applied Retry — `panels/ai/threads.ts`'s doc comment), shown
 * as a compact strip under the prompt box, switched when the timeline's clip dropdown
 * changes the active clip, and included as request context on a subsequent Modify.
 *
 * Mirrors aiPreview.test.ts's fabrication pattern (`__setAnimateCallForTest` swaps the
 * network call for a synchronous/deferred fabricator) so these drive the REAL
 * button-click -> busy -> preview -> Apply pipeline, minus the network.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AnimateResult, animateWithClaude } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import { getThread, recordTurn } from '../../panels/ai/threads';
import { activeClip } from '../../core/model';
import {
  bootRig, resetRig, setEditorMode, state, waitFor,
} from './harness';

interface AiPreviewHook {
  isActive: () => boolean;
  status: () => { clipLabel: string } | null;
  apply: () => void;
  discard: () => void;
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
function disableSnapshotToggle(): void {
  const cb = aiPanel().querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
  if (cb.checked) {
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
function threadStripText(): string | null {
  return aiPanel().querySelector('.ai-thread-info')?.textContent ?? null;
}
function clipSelectEl(): HTMLSelectElement {
  const el = document.querySelector('.tl-clip-mgmt select');
  if (!el) throw new Error('clip select not found');
  return el as HTMLSelectElement;
}
function switchToClipIndex(index: number): void {
  const sel = clipSelectEl();
  sel.value = String(index);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function fabricateResult(clipName: string, peak = 30, durationMs = 1000): AnimateResult {
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

/** Drives Create or Modify with a fabricated, immediately-resolved response and waits
 *  for the preview to enter. */
async function runRequest(
  mode: 'new' | 'modify', result: AnimateResult, promptText = 'wave more',
): Promise<void> {
  __setAnimateCallForTest(async () => result);
  setApiKey();
  disableSnapshotToggle();
  typePrompt(promptText);
  findBtn(mode === 'new' ? 'Create new animation' : 'Modify current animation').click();
  await waitFor(() => aiHook().isActive(), { message: `preview entered after ${mode}` });
}

/** Every `rig-studio-ai-thread:` key currently in localStorage — for before/after diffs
 *  that don't need to know exact doc/clip names. */
function allThreadKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('rig-studio-ai-thread:')) out.push(k);
  }
  return out;
}

describe('AI refinement threads (AI Animate System v2 A4)', () => {
  beforeAll(bootRig);
  beforeEach(() => {
    resetRig();
    setEditorMode('animate');
    // Threads persist in localStorage across tests within this file (only bootRig
    // clears it, once) — start every test from a clean slate for the active doc.
    for (const k of allThreadKeys()) localStorage.removeItem(k);
  });
  afterEach(() => {
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
  });

  it('Apply records a thread turn for the modified clip; the strip shows it', async () => {
    const clip = activeClip()!;
    const docName = state.doc!.name;
    expect(getThread(docName, clip.name)).toBeNull();
    expect(document.querySelector('.ai-thread-strip')).toBeNull(); // no strip before any turn

    await runRequest('modify', fabricateResult('unused', 45), 'wave the right arm more');
    previewActionBtn('apply')!.click();

    const thread = getThread(docName, clip.name);
    expect(thread).not.toBeNull();
    expect(thread!.turns).toHaveLength(1);
    expect(thread!.turns[0].instruction).toBe('wave the right arm more');
    expect(thread!.turns[0].mode).toBe('modify');
    expect(thread!.turns[0].summary).toContain('rotate');

    expect(threadStripText()).toContain('1 refinement turn');
    expect(threadStripText()).toContain('wave the right arm more');
  });

  it('mode "new" records the turn under the NEWLY CREATED clip, not the reference clip', async () => {
    const referenceClip = activeClip()!;
    const docName = state.doc!.name;

    await runRequest('new', fabricateResult('brand_new_clip', 20), 'a brand new wave');
    previewActionBtn('apply')!.click();

    const newClip = state.doc!.clips[state.doc!.clips.length - 1];
    expect(newClip.name).toBe('brand_new_clip');
    expect(getThread(docName, newClip.name)!.turns[0].instruction).toBe('a brand new wave');
    // The clip that was sent as reference context was never modified and gets no thread.
    expect(getThread(docName, referenceClip.name)).toBeNull();
  });

  it('a second Modify request includes the THREAD CONTEXT block from the first turn', async () => {
    const clip = activeClip()!;
    recordTurn(state.doc!.name, clip.name, {
      instruction: 'wave once', mode: 'modify', summary: 'left_arm.rotate ×3',
      clip: { duration: 1000, tracks: [] },
    });

    let capturedInstruction = '';
    __setAnimateCallForTest(async (_key, _doc, _clip, instruction) => {
      capturedInstruction = instruction;
      return fabricateResult('unused', 10);
    });
    setApiKey();
    disableSnapshotToggle();
    typePrompt('now wave twice');
    findBtn('Modify current animation').click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered' });

    expect(capturedInstruction).toContain('THREAD CONTEXT');
    expect(capturedInstruction).toContain('wave once'); // the prior turn's instruction
    expect(capturedInstruction).toContain('now wave twice'); // this request's own instruction
  });

  it('switching the active clip switches the visible thread strip', () => {
    const doc = state.doc!;
    const clipA = doc.clips[state.activeClipIndex];
    doc.clips.push({ name: 'clip_b_for_threads_test', duration: 1000, tracks: [] });
    recordTurn(doc.name, clipA.name, {
      instruction: 'turn for clip A', mode: 'modify', summary: 's',
      clip: { duration: 1000, tracks: [] },
    });
    recordTurn(doc.name, 'clip_b_for_threads_test', {
      instruction: 'turn for clip B', mode: 'modify', summary: 's',
      clip: { duration: 1000, tracks: [] },
    });
    switchToClipIndex(state.activeClipIndex); // no-op switch just to force a rebuild onto clip A's strip
    expect(threadStripText()).toContain('turn for clip A');

    switchToClipIndex(doc.clips.length - 1);
    expect(state.activeClipIndex).toBe(doc.clips.length - 1);
    expect(threadStripText()).toContain('turn for clip B');
    expect(threadStripText()).not.toContain('turn for clip A');
  });

  it('the clear-thread control removes the thread after a confirm, and does nothing on cancel', async () => {
    const clip = activeClip()!;
    const docName = state.doc!.name;
    recordTurn(docName, clip.name, {
      instruction: 'to be cleared', mode: 'modify', summary: 's',
      clip: { duration: 1000, tracks: [] },
    });
    switchToClipIndex(state.activeClipIndex); // force a rebuild so the strip mounts
    expect(document.querySelector('.ai-thread-strip')).not.toBeNull();

    // Cancel: the dialog closes, the thread survives.
    (aiPanel().querySelector('.ai-thread-clear') as HTMLButtonElement).click();
    await waitFor(() => document.querySelector('.ui-dialog'), { message: 'confirm dialog open' });
    (document.querySelector('.ui-dialog-close') as HTMLButtonElement).click();
    expect(getThread(docName, clip.name)).not.toBeNull();

    // Confirm: the thread is cleared and the strip disappears.
    (aiPanel().querySelector('.ai-thread-clear') as HTMLButtonElement).click();
    await waitFor(() => document.querySelector('.ui-dialog'), { message: 'confirm dialog open (2nd)' });
    (document.querySelector('.ui-dialog-primary') as HTMLButtonElement).click();
    await waitFor(() => getThread(docName, clip.name) === null, { message: 'thread cleared' });
    expect(document.querySelector('.ai-thread-strip')).toBeNull();
  });

  it('reload persistence: a doc replace with the SAME doc+clip names still finds the thread (keyed by name, not object identity)', async () => {
    interface RigStudioHook {
      loadProjectText: (text: string) => boolean;
      serializeDoc: (doc: NonNullable<typeof state.doc>) => string;
    }
    const hook = (window as unknown as { __rigStudio: RigStudioHook }).__rigStudio;

    const clip = activeClip()!;
    const docName = state.doc!.name;
    recordTurn(docName, clip.name, {
      instruction: 'survives a reload', mode: 'modify', summary: 's',
      clip: { duration: 1000, tracks: [] },
    });

    const beforeDocRef = state.doc;
    hook.loadProjectText(hook.serializeDoc(state.doc!)); // same content -> a genuine doc-object swap
    expect(state.doc).not.toBe(beforeDocRef); // proves this was a real replace, not a no-op
    expect(state.doc!.name).toBe(docName); // names match -> the store's key still resolves

    setEditorMode('animate');
    expect(getThread(docName, clip.name)!.turns[0].instruction).toBe('survives a reload');
    expect(threadStripText()).toContain('survives a reload');
  });

  it('Discard records nothing (no new thread key appears)', async () => {
    const before = allThreadKeys();
    await runRequest('modify', fabricateResult('unused', 15));
    previewActionBtn('discard')!.click();
    expect(allThreadKeys()).toEqual(before);
    expect(activeClip()).not.toBeNull();
    expect(getThread(state.doc!.name, activeClip()!.name)).toBeNull();
  });

  it('MUTATION CHECK — Retry (never applied) records nothing; only the eventual Apply records exactly one turn', async () => {
    const clip = activeClip()!;
    const docName = state.doc!.name;

    await runRequest('modify', fabricateResult('unused', 10), 'first attempt');
    expect(getThread(docName, clip.name), 'no turn yet — preview only, not applied').toBeNull();

    let resolveSecond: ((r: AnimateResult) => void) | null = null;
    __setAnimateCallForTest(() => new Promise((resolve) => { resolveSecond = resolve; }));
    previewActionBtn('retry')!.click();
    expect(aiHook().isActive(), 'preview exits immediately on retry').toBe(false);
    expect(getThread(docName, clip.name), 'retry itself never records a turn').toBeNull();

    resolveSecond!(fabricateResult('unused', 10));
    await waitFor(() => aiHook().isActive(), { message: 'fresh preview after retry resolves' });
    expect(getThread(docName, clip.name), 'still nothing — the retried candidate is only previewing').toBeNull();

    previewActionBtn('apply')!.click();
    const thread = getThread(docName, clip.name);
    expect(thread, 'the eventual Apply records exactly one turn, not one per attempt').not.toBeNull();
    expect(thread!.turns).toHaveLength(1);
  });
});
