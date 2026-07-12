/**
 * Interaction tests for the opacity channel (keyable, continuous) and the Layers eye
 * (`RigPart.hidden`, editor-only, never keyable).
 *
 * Opacity mirrors the z-order channel's render wiring (render.ts's `applyOpacity`,
 * pose.ts's `effectiveOpacity`) but EASES normally instead of stepping — scenario 1 pins
 * a linear midpoint, which would fail if opacity were accidentally routed through the
 * stepped `sampleKeyList` path z uses. Scenario 2 exercises the real Setup-mode inspector
 * field (not a direct model call) so a regression in the field wiring itself is caught.
 *
 * The Layers eye is DATA (`part.hidden`), not app state and NEVER a channel — scenario 4
 * is the mutation guard for "toggling never creates keys" (CLAUDE.md's "Keyable channels
 * must map to Rive runtime features" convention: visibility has no such feature, so it
 * stays editor-only). Scenario 3 pins the render.ts `.part-hidden` (visibility:hidden)
 * class, that elementFromPoint hit-testing goes dead, and that undo restores everything
 * in one step. Scenario 5 pins the overlay.ts glyph-loop hidden gate for descendant bones
 * (glyphs render into a SEPARATE #overlay tree, not inside the hidden part's own flat DOM
 * group, so they need their own explicit skip — see overlay.ts's comment).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkpoint, undo } from '../../core/history';
import { setKeyframeAt, notify, addNullPart, selectPart } from '../../core/model';
import { registerPart } from '../../view';
import {
  bootRig, resetRig, state, setEditorMode, repaint, partGroupEl, expectClose,
  clientPointOnPart, hitAt, selectByLabel, overlayEl, overlayCount, renderPose,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** A Setup/Animate inspector field's <input>, found by its visible label text — works for
 *  both `numberField` (Setup) and `keyableField` (Animate) rows, which share the same
 *  `label.field > span` shape. Mirrors bones.test.ts's `fieldInput` helper. */
function fieldInput(label: string): HTMLInputElement | null {
  const field = Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'))
    .find((f) => f.querySelector('span')?.textContent === label);
  return (field?.querySelector('input') as HTMLInputElement) ?? null;
}

/** The Layers-panel eye button for a part row, found by its visible label. Re-query after
 *  every click — the eye handler calls notify(), which rebuilds the whole tree. */
function eyeButtonFor(label: string): HTMLButtonElement {
  const rows = [...document.querySelectorAll<HTMLElement>('#layers .layer-row.part')];
  const row = rows.find((r) => r.querySelector('.layer-name')?.textContent === label);
  if (!row) throw new Error(`no layer row for "${label}"`);
  const btn = row.querySelector<HTMLButtonElement>('.layer-eye');
  if (!btn) throw new Error(`no eye button in the "${label}" row`);
  return btn;
}

describe('scenario — keyed opacity fades a part group attribute across a scrub', () => {
  it('samples continuously (linear midpoint, not held) and omits the attribute at full opacity', () => {
    setEditorMode('animate');
    const part = state.doc!.parts[0];

    checkpoint();
    setKeyframeAt(part.id, 'opacity', 0, 1, 'linear');
    setKeyframeAt(part.id, 'opacity', 1000, 0.2, 'linear');
    notify();

    // t=0: opacity 1 → the DOM attribute is REMOVED entirely (byte-identical DOM to a
    // doc that never uses this channel), not written as "1".
    state.currentTime = 0;
    repaint();
    expect(
      partGroupEl(part.label).getAttribute('opacity'),
      'full opacity omits the attribute',
    ).toBeNull();

    // t=500: exact linear midpoint between 1 and 0.2 — an accidental stepped read (z's
    // semantics) would still show 1 here, so this is the mutation guard for continuity.
    state.currentTime = 500;
    repaint();
    expectClose(
      Number(partGroupEl(part.label).getAttribute('opacity')), 0.6, 0.001, 'linear midpoint',
    );

    // t=1000: exactly the second key's value.
    state.currentTime = 1000;
    repaint();
    expectClose(
      Number(partGroupEl(part.label).getAttribute('opacity')), 0.2, 0.001, 'value at the last key',
    );
  });
});

describe('scenario — rest opacity edit in Edit mode', () => {
  it('the inspector field writes part.rest.opacity and the canvas attribute follows it', () => {
    setEditorMode('setup');
    const part = state.doc!.parts[0];
    selectByLabel(part.label);

    const input = fieldInput('rest opacity');
    expect(input, 'a "rest opacity" field is present in Edit mode').toBeTruthy();
    expect(Number(input!.value)).toBeCloseTo(1, 9); // fresh doc → default rest opacity

    input!.value = '0.35';
    input!.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    expect(state.doc!.parts.find((p) => p.id === part.id)!.rest.opacity).toBeCloseTo(0.35, 9);
    expectClose(
      Number(partGroupEl(part.label).getAttribute('opacity')), 0.35, 0.001,
      'canvas attribute reflects the edited rest opacity',
    );

    // No keyframe was created by a Setup-mode edit (rest pose only, per the existing
    // absolute-keyframe convention this field just extends to a new channel).
    const clip = state.doc!.clips[state.activeClipIndex];
    expect(clip.tracks.some((t) => t.target === part.id && t.channel === 'opacity')).toBe(false);
  });
});

describe('scenario — Layers eye hides a part: visibility, hit-testing, undo', () => {
  it('toggling the eye marks the DOM hidden, kills elementFromPoint there, and one undo restores it', () => {
    setEditorMode('setup');
    const part = state.doc!.parts[0];
    notify(); // fresh Layers render

    const g = partGroupEl(part.label);
    expect(g.classList.contains('part-hidden'), 'starts visible').toBe(false);
    const pt = clientPointOnPart(part.label);
    expect(
      hitAt(pt.x, pt.y).closest('[data-part-id]'), 'hits the part before hiding',
    ).toBe(g);

    eyeButtonFor(part.label).click();

    expect(state.doc!.parts.find((p) => p.id === part.id)!.hidden).toBe(true);
    expect(g.classList.contains('part-hidden'), 'DOM group marked hidden').toBe(true);
    expect(getComputedStyle(g).visibility, 'actually invisible on screen').toBe('hidden');
    // The exact point that used to hit this part's group no longer resolves to it —
    // whatever is now on top (a sibling, or the bare svg) takes the hit instead.
    expect(hitAt(pt.x, pt.y).closest('[data-part-id]')).not.toBe(g);
    // The Layers row itself dims (re-query — notify() inside the click rebuilt the tree).
    const rowAfter = eyeButtonFor(part.label).closest('.layer-row');
    expect(rowAfter?.classList.contains('hidden-part')).toBe(true);

    // "selection of a hidden part stays possible via Layers ... canvas doesn't [show it]":
    // select it explicitly (still allowed while hidden) and confirm the overlay draws
    // NOTHING for it — no selection box, no pivot crosshair (a real gap a live check
    // caught: the pivot-handle crosshair has its own draw path, separate from the
    // selection-box loop, and needed its own isEffectivelyHidden guard).
    selectByLabel(part.label);
    expect(state.selectedPartId).toBe(part.id);
    expect(overlayCount('.select-box'), 'no selection box for a hidden selection').toBe(0);
    expect(overlayCount('.pivot-handle'), 'no pivot crosshair for a hidden selection').toBe(0);
    expect(overlayCount('.select-gizmo'), 'no select gizmo for a hidden selection').toBe(0);
    // Deselect before the hit-test check below — a SELECTED (visible) part legitimately
    // draws its own pivot-handle crosshair near the bbox center, which would otherwise
    // occlude clientPointOnPart's fallback point and confound this assertion with a
    // second, unrelated bit of overlay chrome.
    selectPart(null);
    notify();
    repaint();

    undo(); // rebuilds the canvas; state.doc and every DOM ref/client-point must be re-read
    expect(state.doc!.parts.find((p) => p.id === part.id)!.hidden).toBeUndefined();
    const gAfterUndo = partGroupEl(part.label);
    expect(gAfterUndo.classList.contains('part-hidden'), 'undo restores visibility').toBe(false);
    // Re-resolve the client point against the REBUILT DOM (buildCanvas replaced every
    // <path> element) rather than reusing the pre-undo `pt` — the harness's own rule:
    // "never keep overlay DOM references across renders — compute from strings".
    const ptAfterUndo = clientPointOnPart(part.label);
    expect(
      hitAt(ptAfterUndo.x, ptAfterUndo.y).closest('[data-part-id]'), 'hit-testing restored too',
    ).toBe(gAfterUndo);
  });
});

describe('scenario — Layers eye never creates keyframes (Animate mode guard)', () => {
  it('hides and shows a part in Animate mode with the active clip track count unchanged throughout', () => {
    setEditorMode('animate');
    const part = state.doc!.parts[0];
    notify();
    const before = state.doc!.clips[state.activeClipIndex].tracks.length;

    eyeButtonFor(part.label).click(); // hide
    expect(state.doc!.parts.find((p) => p.id === part.id)!.hidden).toBe(true);
    expect(state.doc!.clips[state.activeClipIndex].tracks.length, 'hiding creates no track').toBe(before);
    expect(
      state.doc!.clips[state.activeClipIndex].tracks.some((t) => t.target === part.id),
      'no track at all for this part appeared',
    ).toBe(false);

    eyeButtonFor(part.label).click(); // show again
    expect(state.doc!.parts.find((p) => p.id === part.id)!.hidden).toBe(false);
    expect(state.doc!.clips[state.activeClipIndex].tracks.length, 'showing creates no track').toBe(before);
  });
});

describe('scenario — a hidden part cascades to its descendant bone glyphs', () => {
  it('the overlay bone glyph disappears while an ancestor is hidden and returns once shown', () => {
    setEditorMode('setup');
    const parent = state.doc!.parts[0];
    const bone = addNullPart(
      'bone', { x: parent.pivot.x + 10, y: parent.pivot.y + 10 }, parent.id, 'eye_test_bone',
    );
    registerPart(bone);
    renderPose();

    const glyph = () => overlayEl().querySelector(`.null-glyph[data-part-id="${bone.id}"]`);
    expect(glyph(), 'glyph renders while the ancestor is visible').toBeTruthy();

    parent.hidden = true;
    renderPose();
    expect(glyph(), 'glyph gone once the ancestor (not the bone itself) is hidden').toBeNull();

    parent.hidden = false;
    renderPose();
    expect(glyph(), 'glyph returns once the ancestor is shown again').toBeTruthy();
  });
});
