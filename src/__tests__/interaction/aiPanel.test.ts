/**
 * Interaction tests for the AI Animate System v2 "A1. Session & intent UX" prompt-text
 * persistence: the textarea's content must survive inspector rebuilds (notify()), a
 * full Edit/Animate mode round trip (buildAiPanel isn't even called in Edit mode — the
 * panel is Animate-only by design, so this proves the module-level state outlives the
 * DOM element entirely), and a timeline view switch. Real DOM is required here (unlike
 * the pure-logic apply-path tests in aiApply.test.ts) since this is specifically about
 * a textarea surviving element churn across renders.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  bootRig, resetRig, setEditorMode, selectByLabel,
} from './harness';

function aiPanelPresent(): boolean {
  return !!document.querySelector('.ai-panel');
}

function promptBox(): HTMLTextAreaElement {
  const el = document.querySelector('.ai-panel textarea');
  if (!el) throw new Error('.ai-panel textarea not found — is the panel mounted?');
  return el as HTMLTextAreaElement;
}

/** Types into the (freshly-queried) prompt box via a real input event, matching the
 *  app's own `oninput` wiring rather than poking module state directly. */
function typePrompt(text: string): void {
  const box = promptBox();
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function timelineModeButton(mode: 'keys' | 'curves' | 'logic'): HTMLButtonElement {
  const el = document.querySelector(`[data-tl-action="mode-${mode}"]`);
  if (!el) throw new Error(`timeline mode button "${mode}" not found`);
  return el as HTMLButtonElement;
}

describe('AI panel prompt-text persistence (AI Animate System v2 A1)', () => {
  beforeAll(bootRig);
  beforeEach(resetRig);

  it('the panel only mounts in Animate mode', () => {
    setEditorMode('setup');
    expect(aiPanelPresent()).toBe(false);
    setEditorMode('animate');
    expect(aiPanelPresent()).toBe(true);
  });

  it('starts empty on a fresh boot', () => {
    setEditorMode('animate');
    expect(promptBox().value).toBe('');
  });

  it('survives a plain notify()-driven inspector rebuild (e.g. selecting a different part)', () => {
    setEditorMode('animate');
    typePrompt('bend at the knees');
    selectByLabel('left_arm'); // notify() + renderPose(), rebuilds every panel incl. this one
    expect(promptBox().value).toBe('bend at the knees');
  });

  it('survives a timeline view switch (logic <-> keys) even though it lives in a separate DOM subtree', () => {
    setEditorMode('animate');
    typePrompt('wave with the right arm');
    timelineModeButton('logic').click();
    timelineModeButton('keys').click();
    expect(promptBox().value).toBe('wave with the right arm');
  });

  it('survives a full Edit -> Animate round trip (the panel is unmounted entirely in Edit mode)', () => {
    setEditorMode('animate');
    typePrompt('jump, then land with a squash');

    setEditorMode('setup');
    expect(aiPanelPresent()).toBe(false); // proves the DOM element is really gone, not just hidden

    setEditorMode('animate');
    expect(promptBox().value).toBe('jump, then land with a squash'); // a FRESH textarea, same text
  });

  it('a second edit after a round trip is captured too (module state stays live, not a one-shot restore)', () => {
    setEditorMode('animate');
    typePrompt('first draft');
    setEditorMode('setup');
    setEditorMode('animate');
    typePrompt('revised direction');
    setEditorMode('setup');
    setEditorMode('animate');
    expect(promptBox().value).toBe('revised direction');
  });
});
