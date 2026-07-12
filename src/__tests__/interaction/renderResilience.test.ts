/**
 * Interaction tests for render resilience (hardening wave, class 1) and the
 * zero-length-bone guards (class 2). CONFIRMED live bug: an exception thrown inside
 * renderSkinnedPart (malformed/dangling skin data) used to abort the WHOLE renderPose,
 * killing the entire canvas render — invisible and unhittable, not just the one broken
 * part. These tests poison a real, bound part's skin data mid-session (the way session
 * corruption actually happens — no reload, no normalizeDoc pass) and confirm the
 * render loop degrades to a rigid fallback for that ONE part, warns exactly once while
 * it stays broken, and leaves every other part rendering normally.
 *
 * Mutation-check note: removing render.ts's try/catch around renderSkinnedPart (or its
 * `if (!ok)` fallback branch) makes the first two scenarios below fail outright — either
 * the malformed-bindSeg case throws out of renderPose (canvas.querySelectorAll would
 * come back empty/stale) or the NaN case leaves "NaN" in the rendered `d` string.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  addNullPart, selectPart as modelSelectPart, notify, isUsableBoneTip, MIN_BONE_LENGTH,
} from '../../core/model';
import { startBonePlacement, endBoneChain, renderPose, autoBindPlacedBone } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, click, medialPoints,
  placeBoneChain,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Place a single bone by the pen-tool chain (origin click → tip click); returns the bone. */
function placeBoneGesture(from: { x: number; y: number }, to: { x: number; y: number }) {
  return placeBoneChain([from, to])[0];
}

/** Bind a real single-bone chain to `label` (the same auto-bind path bones.test.ts uses). */
function bindChain(label: string): { art: ReturnType<typeof partByLabel>; bone: ReturnType<typeof partByLabel> } {
  const pts = medialPoints(label, 1);
  modelSelectPart(null);
  notify();
  renderPose();
  const bone = placeBoneGesture(pts[0], pts[1]);
  return { art: partByLabel(label), bone };
}

/** Concatenated rendered `d` of a part's path elements (the live DOM geometry). */
function renderedD(label: string): string {
  return Array.from(partGroupEl(label).querySelectorAll('path'))
    .map((p) => p.getAttribute('d') ?? '').join('|');
}

/** The model's REST `d` for a part's paths (what a rigid fallback render must match). */
function modelRestD(label: string): string {
  return partByLabel(label).paths.map((p) => p.d).join('|');
}

describe('render resilience — a poisoned skin binding never aborts the whole canvas', () => {
  it('an exception inside skin data (malformed bindSeg) falls back to rigid rest, warns once, and leaves other parts alone', () => {
    const { art } = bindChain('right_arm');
    expect(art.skin, 'right_arm got skinned').toBeTruthy();
    const otherBefore = renderedD('body');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Missing bindSeg.q — reading b.bindSeg.q.x throws inside renderSkinnedPart.
      (art.skin!.bones[0].bindSeg as unknown as { q?: unknown }).q = undefined;
      renderPose();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(art.id);
      expect(renderedD('right_arm')).toBe(modelRestD('right_arm')); // rigid rest fallback
      expect(renderedD('body')).toBe(otherBefore); // unrelated part untouched

      renderPose(); // still broken — must NOT warn again
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('non-finite skin output (NaN bind matrix) falls back to rigid rest instead of leaking NaN into the path', () => {
    const { art } = bindChain('right_arm');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      art.skin!.bones[0].restWorldInv.a = NaN;
      renderPose();

      expect(warn).toHaveBeenCalledTimes(1);
      const d = renderedD('right_arm');
      expect(d).not.toContain('NaN');
      expect(d).toBe(modelRestD('right_arm'));
    } finally {
      warn.mockRestore();
    }
  });

  it('an empty skin.bones array falls back to rigid rest rather than collapsing every point to the origin', () => {
    const { art } = bindChain('right_arm');
    const restD = modelRestD('right_arm');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      art.skin!.bones = [];
      renderPose();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(renderedD('right_arm')).toBe(restD);
    } finally {
      warn.mockRestore();
    }
  });

  it('recovers automatically once the data is fixed, and re-warns on a fresh break', () => {
    const { art, bone } = bindChain('right_arm');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      art.skin!.bones[0].restWorldInv.a = NaN;
      renderPose();
      expect(warn).toHaveBeenCalledTimes(1);

      art.skin!.bones[0].restWorldInv.a = 1; // fix
      bone.rest.rotate = 25; // pose the bone so a genuinely-deformed render is observable
      renderPose();
      expect(warn).toHaveBeenCalledTimes(1); // clean render — no new warning
      expect(renderedD('right_arm')).not.toBe(modelRestD('right_arm')); // really deforming again

      art.skin!.bones[0].restWorldInv.a = NaN; // break again
      renderPose();
      expect(warn).toHaveBeenCalledTimes(2); // re-warned after a fresh break
    } finally {
      warn.mockRestore();
    }
  });
});

describe('zero-length bone guards (hardening wave, class 2)', () => {
  it('the pen-tool MIN_BONE_LENGTH guard drops a too-short chain segment; a real one yields a usable bone', () => {
    // RE-SPEC (pen-tool chains): press-drag-release is gone. A bare click now only SETS the
    // chain origin; a second click too close to it commits NO degenerate bone (the
    // MIN_BONE_LENGTH guard, the click-model equivalent of the old zero-length substitution),
    // and a real segment yields a usable-length bone.
    modelSelectPart(null);
    notify();
    renderPose();
    const pts = medialPoints('right_arm', 1); // [origin, tip] down the arm
    const before = state.doc!.parts.length;
    startBonePlacement();
    click(pts[0].x, pts[0].y); // sets the origin — commits nothing
    click(pts[0].x + 1, pts[0].y + 1); // ~1.4 px from the origin → below MIN_BONE_LENGTH → dropped
    expect(state.doc!.parts.length, 'a too-short click commits no degenerate bone').toBe(before);
    click(pts[1].x, pts[1].y); // a real medial-length segment → a usable bone
    endBoneChain();
    const bone = state.doc!.parts[state.doc!.parts.length - 1];
    expect(bone.kind).toBe('bone');
    expect(bone.boneTip, 'a committed bone always has a tip').toBeTruthy();
    expect(isUsableBoneTip(bone.pivot, bone.boneTip!)).toBe(true);
  });

  it('autoBindPlacedBone heals a fabricated degenerate tip before resolving the chain', () => {
    modelSelectPart(null);
    notify();
    const bone = addNullPart('bone', { x: 30, y: 30 }, null, 'degenerate_test_bone');
    bone.boneTip = { x: 30, y: 30 }; // exactly on its own pivot — zero length
    expect(isUsableBoneTip(bone.pivot, bone.boneTip)).toBe(false);

    autoBindPlacedBone(bone.id);

    expect(isUsableBoneTip(bone.pivot, bone.boneTip!)).toBe(true);
    expect(bone.boneTip).toEqual({ x: 30 + MIN_BONE_LENGTH, y: 30 });
  });
});
