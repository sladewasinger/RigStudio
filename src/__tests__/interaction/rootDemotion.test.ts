/**
 * Interaction tests for the AI Animate System v2 "A0. Targeting & root demotion":
 * the Animate-mode inspector no longer offers a way to key the legacy 'root' target —
 * that's the fix for the "shadow follows the figure" bug, where keying root silently
 * dragged along every part with no track of its own (props/shadows included). Edit mode
 * keeps root's PIVOT fields (still the anchor for any legacy root-keyed clip), and
 * sampling/rendering of a clip that already has root keyframes from an older project is
 * completely unchanged — only the UI that lets NEW clips key them is gone.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setKeyframe } from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, selectByLabel, repaint, rootGEl,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function inspectorHeadings(): string[] {
  return Array.from(document.querySelectorAll('#inspector h3')).map((h) => h.textContent ?? '');
}

function inspectorFieldLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll('#inspector label.field span')).map((s) => s.textContent);
}

describe('root demotion (AI Animate System v2 A0)', () => {
  it('Animate mode shows no "Figure (root)" section with nothing selected', () => {
    setEditorMode('animate');
    expect(inspectorHeadings()).not.toContain('Figure (root)');
    expect(inspectorFieldLabels()).not.toContain('jump y');
  });

  it('Animate mode shows no "Figure (root)" section with a part selected either', () => {
    setEditorMode('animate');
    selectByLabel('left_arm');
    // 'scale x'/'scale y' are legitimate PER-PART keyable fields shown for any selected
    // part in Animate (see inspector.ts's keyableField calls) — not root-specific, so
    // only 'jump y' (which only ever existed on the now-removed root section) and the
    // section heading are the meaningful assertions here.
    expect(inspectorHeadings()).not.toContain('Figure (root)');
    expect(inspectorFieldLabels()).not.toContain('jump y');
  });

  it('Edit mode still shows the root pivot fields', () => {
    setEditorMode('setup');
    expect(inspectorHeadings()).toContain('Figure (root)');
    const fields = inspectorFieldLabels();
    expect(fields).toContain('root pivot x');
    expect(fields).toContain('root pivot y');
  });

  it('a legacy root-keyed clip still samples and renders (back-compat)', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    setKeyframe('root', 'ty', 0);
    state.currentTime = 500;
    setKeyframe('root', 'ty', -30);

    state.currentTime = 500;
    repaint();
    expect(rootGEl().getAttribute('transform') ?? '').toContain('translate(0,-30)');

    state.currentTime = 0;
    repaint();
    expect(rootGEl().getAttribute('transform') ?? '').toContain('translate(0,0)');

    // Sanity: the track really did land under the deprecated 'root' target, exactly as
    // an older project would have written it — nothing about the model/exporters
    // changed, only the inspector's ability to CREATE new ones.
    const track = state.doc!.clips[state.activeClipIndex].tracks.find(
      (t) => t.target === 'root' && t.channel === 'ty',
    );
    expect(track?.keyframes.length).toBe(2);
  });
});
