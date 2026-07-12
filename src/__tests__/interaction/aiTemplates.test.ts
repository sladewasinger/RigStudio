/**
 * Interaction tests for AI Animate System v2 A5 "Rig Profile + motion templates":
 * the template quick-action row FILLS the prompt box from the CURRENT rig's profile
 * (never auto-sends — the locked fill-don't-fire decision in `panels/ai/templates.ts`),
 * the filled prompt then routes through the NORMAL create-new flow (fabricated network
 * seam, same as aiPreview/aiThreads), and every Create/Modify request carries the
 * RIG PROFILE context block. The girl-fixture scenario is the rig-AGNOSTIC proof: the
 * same button on a different character names HER structure, not the sample's.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AnimateResult, animateWithClaude } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import { activeClip } from '../../core/model';
import {
  bootRig, loadFixtureSvg, resetRig, setEditorMode, waitFor,
} from './harness';

interface AiPreviewHook {
  isActive: () => boolean;
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
function promptBox(): HTMLTextAreaElement {
  return aiPanel().querySelector('textarea') as HTMLTextAreaElement;
}
function templateBtn(id: string): HTMLButtonElement {
  const btn = aiPanel().querySelector(`.ai-template-row [data-template="${id}"]`);
  if (!btn) throw new Error(`no template button "${id}"`);
  return btn as HTMLButtonElement;
}
function actionBtn(text: string): HTMLButtonElement {
  const btn = Array.from(aiPanel().querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn as HTMLButtonElement;
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
function typePrompt(text: string): void {
  const box = promptBox();
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('AI motion templates + rig profile (AI Animate System v2 A5)', () => {
  beforeAll(bootRig);
  beforeEach(() => {
    resetRig();
    setEditorMode('animate');
    typePrompt(''); // clear any promptText a previous test left in the module-scope mirror
  });
  afterEach(() => {
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
  });

  it('shows one quick-action button per archetype', () => {
    const row = aiPanel().querySelector('.ai-template-row')!;
    expect(row).not.toBeNull();
    const ids = Array.from(row.querySelectorAll('button')).map((b) => (b as HTMLElement).dataset.template);
    expect(ids).toEqual(['walk', 'breathe', 'jump', 'wave', 'gesture']);
  });

  it('a template click FILLS the prompt with profile-derived targets and beats — and does NOT send', () => {
    let calls = 0;
    __setAnimateCallForTest(async () => { calls++; return fabricateResult('never'); });

    expect(promptBox().value).toBe('');
    templateBtn('wave').click();

    const text = promptBox().value;
    // The sample's profile pairs left_/right_ limbs; a wave leads with the arm-like
    // pair's right side — a REAL part label resolved from THIS rig, not a placeholder.
    expect(text).toContain('right_arm');
    expect(text).toMatch(/- \d+–\d+ms \(/); // absolute-ms beat map from the set duration
    expect(text).toContain(`${activeClip()!.duration}ms`);
    // Fill, never fire: no request left, no preview entered, panel idle.
    expect(calls).toBe(0);
    expect(aiHook().isActive()).toBe(false);
    expect(aiHook().busy()).toBe(false);
  });

  it('the filled prompt survives a panel rebuild (promptText mirror) and stays editable', () => {
    templateBtn('breathe').click();
    const filled = promptBox().value;
    expect(filled.length).toBeGreaterThan(0);
    setEditorMode('setup'); // panel unmounts entirely in Edit mode…
    setEditorMode('animate'); // …and rebuilds from ai.promptText
    expect(promptBox().value).toBe(filled);
  });

  it('the filled prompt routes through the NORMAL create flow — the request carries the template targets AND the profile block', async () => {
    let captured = '';
    __setAnimateCallForTest(async (_key, _doc, _clip, instruction) => {
      captured = instruction;
      return fabricateResult('walk_test');
    });
    setApiKey();
    disableSnapshotToggle();

    templateBtn('walk').click();
    actionBtn('Create new animation').click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Create' });

    // The template's own instruction text, with real striders from the profile…
    expect(captured).toContain('left_leg');
    expect(captured).toContain('right_leg');
    expect(captured).toMatch(/- \d+–\d+ms \(/);
    // …and the A5 profile block prepended by requests.ts (leads the whole request).
    expect(captured).toContain('RIG PROFILE');
    expect(captured.indexOf('RIG PROFILE')).toBe(0);
  });

  it('a FREE-TEXT Modify request also carries the RIG PROFILE block (chains/roles/symmetry)', async () => {
    let captured = '';
    __setAnimateCallForTest(async (_key, _doc, _clip, instruction) => {
      captured = instruction;
      return fabricateResult('unused');
    });
    setApiKey();
    disableSnapshotToggle();
    typePrompt('sway gently side to side');
    actionBtn('Modify current animation').click();
    await waitFor(() => aiHook().isActive(), { message: 'preview entered after Modify' });

    expect(captured).toContain('RIG PROFILE');
    expect(captured).toContain('symmetry pair: left_arm <-> right_arm');
    expect(captured).toContain('torso: body');
    expect(captured).toContain('sway gently side to side'); // the user's own text survives intact
  });

  it('RIG-AGNOSTIC PROOF: the same button on the girl fixture names HER structure', async () => {
    await loadFixtureSvg('girl_example.svg');
    setEditorMode('animate');

    templateBtn('walk').click();
    const text = promptBox().value;
    // Her CamelCase arm pair (the only symmetry pair she has) becomes the striders;
    // her figure group / torso guess is named for the body bob — none of the sample's
    // snake_case names appear.
    expect(text).toContain('LeftArm');
    expect(text).toContain('RightArm');
    expect(text).toContain('Pants'); // the size-rank torso fallback, named as the bob target
    expect(text).not.toContain('left_arm');
    expect(text).not.toContain('left_leg');
  });
});
