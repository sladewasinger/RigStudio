/**
 * Interaction tests for AI Animate System v2 A6 "Polish": a one-click preset
 * refinement turn on the active clip that routes through the SAME Modify flow as a
 * free-text request (fabricated network seam, same pattern as aiTemplates.test.ts /
 * aiThreads.test.ts), landing in the normal A2 preview and recording an A4 thread turn
 * on Apply — but WITHOUT ever touching the prompt box (`panels/ai/polish.ts`'s module
 * doc; `panels/ai/state.ts`'s `polishInstruction` field carries the instruction instead
 * of `promptText`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AnimateResult, animateWithClaude } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import { getThread } from '../../panels/ai/threads';
import { activeClip, setKeyframeAt } from '../../core/model';
import {
  bootRig, resetRig, setEditorMode, state, waitFor, partByLabel, notify,
} from './harness';

interface AiPreviewHook {
  isActive: () => boolean;
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
function polishBtn(): HTMLButtonElement {
  const btn = aiPanel().querySelector('.ai-polish-btn');
  if (!btn) throw new Error('no .ai-polish-btn in the AI panel');
  return btn as HTMLButtonElement;
}
function promptBox(): HTMLTextAreaElement {
  return aiPanel().querySelector('textarea') as HTMLTextAreaElement;
}
function previewActionBtn(action: 'apply' | 'retry' | 'discard'): HTMLButtonElement | null {
  return aiPanel().querySelector(`[data-ai-action="${action}"]`);
}
function typePrompt(text: string): void {
  const box = promptBox();
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
function setApiKey(): void {
  const input = aiPanel().querySelector('input[type="password"]') as HTMLInputElement;
  input.value = 'sk-test-key';
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function disableSnapshotToggle(): void {
  const cb = aiPanel().querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
  if (cb.checked) {
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** Give the active clip one real keyframe so the Polish button has something to work
 *  with — the pristine sample's default clip starts with zero tracks. */
function addAKeyframe(): void {
  setKeyframeAt(partByLabel('left_arm').id, 'rotate', 0, 0);
  setKeyframeAt(partByLabel('left_arm').id, 'rotate', 1000, 30);
  notify();
}

/** Every `rig-studio-ai-thread:` key currently in localStorage — threads persist
 *  across tests within this file (only bootRig clears localStorage, once), so
 *  beforeEach sweeps them for a clean slate (mirrors aiThreads.test.ts). */
function allThreadKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('rig-studio-ai-thread:')) out.push(k);
  }
  return out;
}

function fabricateResult(clipName: string): AnimateResult {
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
          { time: 500, value: 20, easing: 'linear' },
          { time: 1000, value: 0, easing: 'linear' },
        ],
      }],
    },
    rig: null,
    clampedCount: 0,
  };
}

describe('AI Polish button (AI Animate System v2 A6)', () => {
  beforeAll(bootRig);
  beforeEach(() => {
    resetRig();
    setEditorMode('animate');
    typePrompt(''); // clear any promptText a previous test left in the module-scope mirror
    for (const k of allThreadKeys()) localStorage.removeItem(k);
  });
  afterEach(() => {
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
  });

  it('is disabled with an explanatory title when the active clip has no keyframes; enables once one exists', () => {
    expect(activeClip()!.tracks.some((t) => t.keyframes.length > 0)).toBe(false);
    expect(polishBtn().disabled).toBe(true);
    expect(polishBtn().title.length).toBeGreaterThan(0);

    addAKeyframe();
    expect(polishBtn().disabled).toBe(false);
  });

  it('disables itself the instant a request starts (not just Create/Modify/Critique)', async () => {
    addAKeyframe();
    let resolveLater: ((r: AnimateResult) => void) | null = null;
    __setAnimateCallForTest(() => new Promise((resolve) => { resolveLater = resolve; }));
    setApiKey();
    disableSnapshotToggle();

    expect(polishBtn().disabled).toBe(false);
    polishBtn().click();
    expect(polishBtn().disabled, 'busy must disable Polish immediately, like every other action button').toBe(true);

    resolveLater!(fabricateResult('polished_clip'));
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after the deferred response' });
  });

  it('MUTATION-SENSITIVE: one click sends immediately — the captured instruction carries the polish contract AND the RIG PROFILE block, and the app lands in preview', async () => {
    addAKeyframe();
    let captured = '';
    __setAnimateCallForTest(async (_key, _doc, _clip, instruction) => {
      captured = instruction;
      return fabricateResult('polished_clip');
    });
    setApiKey();
    disableSnapshotToggle();

    expect(aiHook().isActive()).toBe(false);
    polishBtn().click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Polish' });

    expect(captured).toContain('RIG PROFILE');
    expect(captured).toContain('POLISH PASS');
    expect(captured).toContain('PRESERVING THE CHOREOGRAPHY');
    expect(captured).toContain('left_arm'); // named from the analyzed track, via the profile
  });

  it('the user\'s own typed prompt text survives a full polish turn (send -> preview -> Apply) untouched', async () => {
    addAKeyframe();
    typePrompt('my own untouched draft');
    __setAnimateCallForTest(async () => fabricateResult('polished_clip'));
    setApiKey();
    disableSnapshotToggle();

    polishBtn().click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Polish' });
    expect(promptBox().value).toBe('my own untouched draft');

    previewActionBtn('apply')!.click();
    expect(promptBox().value).toBe('my own untouched draft');
  });

  it('Apply records an A4 thread turn carrying the polish instruction, mode "modify"', async () => {
    addAKeyframe();
    const clip = activeClip()!;
    const docName = state.doc!.name;
    expect(getThread(docName, clip.name)).toBeNull();

    __setAnimateCallForTest(async () => fabricateResult('polished_clip'));
    setApiKey();
    disableSnapshotToggle();
    polishBtn().click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Polish' });
    previewActionBtn('apply')!.click();

    const thread = getThread(docName, clip.name);
    expect(thread).not.toBeNull();
    expect(thread!.turns).toHaveLength(1);
    expect(thread!.turns[0].mode).toBe('modify');
    expect(thread!.turns[0].instruction).toContain('POLISH PASS');
  });

  it('Discard leaves no thread turn and does not clear the prompt box', async () => {
    addAKeyframe();
    const clip = activeClip()!;
    const docName = state.doc!.name;
    typePrompt('still here');
    __setAnimateCallForTest(async () => fabricateResult('polished_clip'));
    setApiKey();
    disableSnapshotToggle();

    polishBtn().click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Polish' });
    previewActionBtn('discard')!.click();

    expect(getThread(docName, clip.name)).toBeNull();
    expect(promptBox().value).toBe('still here');
  });
});
