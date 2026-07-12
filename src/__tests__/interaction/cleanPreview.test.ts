/**
 * Interaction tests for the AI Animate System v2 "A0. Targeting & root demotion" clean-
 * preview toggle: an Animate-mode canvas-tools button that hides every piece of editor
 * chrome (overlay contents — selection boxes, handles, pivots, bone/group glyphs+lines,
 * gizmos, snap markers, hints — plus the artboard rect and onion ghosts) so the clip can
 * be watched the way it will actually play/export, while the artwork itself keeps
 * animating and selection/drag interactions keep working underneath the hidden chrome.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { state, notify, ensureArtboard, setKeyframe } from '../../core/model';
import {
  bootRig, resetRig, selectByLabel, setEditorMode, overlayEl, count, repaint,
  medialPoints, placeBoneChain, partByLabel, rootGEl,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function cleanPreviewButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('#canvas-tools button'))
    .find((b) => b.title.startsWith('Clean preview'));
  if (!btn) throw new Error('clean-preview button not found in #canvas-tools');
  return btn;
}

/** A bone glyph on canvas so ".null-glyph" chrome actually has something to hide. */
function placeATestBone(): void {
  setEditorMode('setup');
  placeBoneChain(medialPoints('left_arm', 1));
}

/** Two straddling keyframes so renderOnion() actually has prev/next ghosts to draw. */
function seedOnionKeys(): void {
  const arm = partByLabel('left_arm');
  const clip = state.doc!.clips[state.activeClipIndex];
  const end = Math.max(500, Math.round(clip.duration / 10) * 10);
  clip.duration = end;
  state.currentTime = 0;
  setKeyframe(arm.id, 'rotate', 0);
  state.currentTime = end;
  setKeyframe(arm.id, 'rotate', 30);
  state.currentTime = Math.round(end / 2 / 10) * 10;
}

/** Real rendered artwork part groups only — excludes #overlay's bone/group glyphs,
 *  which ALSO carry data-part-id (see CLAUDE.md's bone-system section), so a naive
 *  document-wide count would conflate "chrome hidden" with "artwork gone". */
function artworkGroupCount(): number {
  return rootGEl().querySelectorAll('[data-part-id]').length;
}

describe('clean preview (AI Animate System v2 A0)', () => {
  it('is Animate-only: no toggle button while in Edit mode', () => {
    setEditorMode('setup');
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('#canvas-tools button'))
      .find((b) => b.title.startsWith('Clean preview'));
    expect(btn).toBeUndefined();
  });

  it('hides overlay chrome, bone glyphs, the artboard rect, and onion — artwork stays', () => {
    placeATestBone();
    setEditorMode('animate');
    selectByLabel('left_arm');
    state.onionSkin = true;
    seedOnionKeys();
    const ab = ensureArtboard(state.doc!);
    ab.enabled = true;
    notify();
    repaint();

    // Sanity: real chrome is present before the toggle.
    expect(overlayEl().children.length, 'overlay has chrome before the toggle').toBeGreaterThan(0);
    expect(count('.null-glyph'), 'bone glyph present before the toggle').toBeGreaterThan(0);
    const artCountBefore = artworkGroupCount();
    expect(artCountBefore, 'artwork groups present').toBeGreaterThan(0);
    const rect = document.getElementById('rig-artboard-rect')!;
    expect(rect.style.display, 'artboard rect visible before the toggle').not.toBe('none');
    expect(document.querySelectorAll('.onion-ghost').length, 'onion ghosts present before the toggle')
      .toBeGreaterThan(0);

    cleanPreviewButton().click();

    expect(state.cleanPreview).toBe(true);
    expect(overlayEl().children.length, 'overlay emptied by clean preview').toBe(0);
    expect(count('.null-glyph'), 'bone glyphs hidden (they only ever live in #overlay)').toBe(0);
    expect(rect.style.display, 'artboard rect hidden').toBe('none');
    expect(document.querySelectorAll('.onion-ghost').length, 'onion ghosts hidden').toBe(0);
    // Artwork itself is untouched — same part groups, still in the DOM.
    expect(artworkGroupCount(), 'artwork groups unchanged').toBe(artCountBefore);
  });

  it('toggling back restores every piece of chrome', () => {
    placeATestBone();
    setEditorMode('animate');
    selectByLabel('left_arm');
    state.onionSkin = true;
    seedOnionKeys();
    ensureArtboard(state.doc!).enabled = true;
    notify();
    repaint();

    cleanPreviewButton().click();
    expect(state.cleanPreview).toBe(true);

    cleanPreviewButton().click();
    expect(state.cleanPreview).toBe(false);
    expect(overlayEl().children.length, 'overlay chrome restored').toBeGreaterThan(0);
    expect(count('.null-glyph'), 'bone glyph restored').toBeGreaterThan(0);
    const rect = document.getElementById('rig-artboard-rect')!;
    expect(rect.style.display, 'artboard rect restored').not.toBe('none');
    expect(document.querySelectorAll('.onion-ghost').length, 'onion ghosts restored').toBeGreaterThan(0);
  });

  it('selection/drag interactions keep working while clean — the button itself shows active state', () => {
    setEditorMode('animate');
    selectByLabel('left_arm');
    const btn = cleanPreviewButton();
    expect(btn.classList.contains('active')).toBe(false);

    btn.click();
    expect(state.cleanPreview).toBe(true);
    expect(cleanPreviewButton().classList.contains('active'), 're-rendered button reflects ON state').toBe(true);

    // Selecting a different part still works normally with chrome hidden — input isn't gated.
    selectByLabel('right_arm');
    expect(state.selectedPartId).toBe(state.doc!.parts.find((p) => p.label === 'right_arm')!.id);
    expect(overlayEl().children.length, 'overlay stays empty — selection changed, chrome still hidden').toBe(0);
  });

  it('Edit mode never hides its own chrome, even if the flag is left on from Animate', () => {
    setEditorMode('animate');
    selectByLabel('left_arm');
    cleanPreviewButton().click();
    expect(state.cleanPreview).toBe(true);

    setEditorMode('setup');
    repaint();
    expect(overlayEl().children.length, 'Edit-mode chrome renders regardless of the Animate-only flag')
      .toBeGreaterThan(0);
  });
});
