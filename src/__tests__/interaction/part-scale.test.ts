/**
 * Interaction tests for KEYABLE part scale (channels 'sx'/'sy'), the WYSIWYG fix that
 * makes the Animate canvas show keyed part scale the same way the .riv export replays it.
 *
 * The render path threads time through pose.ts's innerLocalTransform/groupTransformOf and
 * samples sx/sy via effectiveScaleX/effectiveScaleY (keyed absolute, rest.sx/sy fallback) —
 * exactly the effectiveZ/effectiveOpacity pattern. Scenario 1 is the mutation guard: it
 * measures the part's LIVE rendered matrix, so reverting innerLocalTransform to rest-only
 * (dropping the time sample) makes the y-scale constant across the scrub and the ratio
 * assertions fail. It also pins the two load-bearing conventions — the joint (pivot) is the
 * scale's fixed point, and the inner scale does NOT propagate to children. Scenario 2 pins
 * that Edit mode (poseTime() null) still shows rest scale regardless of the playhead.
 * Scenario 3 exercises the real inspector fields (keyable scale x / scale y) and one undo.
 *
 * The vertical scale factor is read as the y-column length hypot(c,d) of the part group's
 * transform matrix: the innermost scale multiplies sy into that column, so its length grows
 * EXACTLY with sy regardless of any baked rotation — a tighter, rotation-proof probe than a
 * screen bbox height.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkpoint, undo } from '../../core/history';
import { setKeyframeAt, addNullPart } from '../../core/model';
import { registerPart } from '../../view';
import { applyMat, invertMat, matrixOfTransform } from '../../geometry/transforms';
import {
  bootRig, resetRig, state, notify, setEditorMode, repaint, partMatrix, partByLabel,
  expectClose, selectByLabel, rootGEl, docToClient, clipTrack,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** The first sample art part with real geometry to scale. */
function artPart() {
  const p = state.doc!.parts.find((pp) => pp.kind === 'art' && pp.paths.length > 0);
  if (!p) throw new Error('no art part with paths in the sample');
  return p;
}

/** Vertical scale of a part's LIVE rendered matrix — grows exactly with sy. */
function yScale(label: string): number {
  const m = partMatrix(label);
  return Math.hypot(m.c, m.d);
}

/** y-scale of an arbitrary part group (child bone) read straight from rootG. */
function groupYScale(id: string): number {
  const g = rootGEl().querySelector(`[data-part-id="${id}"]`);
  if (!g) throw new Error(`no canvas group for part ${id}`);
  const m = matrixOfTransform(g.getAttribute('transform') ?? '');
  return Math.hypot(m.c, m.d);
}

/**
 * The screen position of the part's pivot as the RENDER places it: apply the live part
 * matrix to the pivot mapped into pre-baked local space (localPivotOf's math). This point
 * IS the inner scale's fixed point — a correct innermost scale leaves it put while the art
 * grows; a scale about the wrong origin would drag it.
 */
function pivotScreen(label: string): { x: number; y: number } {
  const part = partByLabel(label);
  const pl = applyMat(invertMat(matrixOfTransform(part.transform)), part.pivot.x, part.pivot.y);
  const root = applyMat(partMatrix(label), pl.x, pl.y);
  return docToClient(root);
}

// ---- Inspector field helpers (share keyableField/numberField's label.field shape) ----

function fieldLabel(label: string): HTMLLabelElement | null {
  return Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'))
    .find((f) => f.querySelector('span')?.textContent === label) ?? null;
}
function fieldInput(label: string): HTMLInputElement | null {
  return (fieldLabel(label)?.querySelector('input') as HTMLInputElement) ?? null;
}
function keyToggle(label: string): HTMLButtonElement {
  const t = fieldLabel(label)?.querySelector('.key-toggle') as HTMLButtonElement | null;
  if (!t) throw new Error(`no key toggle for "${label}"`);
  return t;
}

describe('scenario — keyed part sy scales the rendered artwork about its pivot across a scrub', () => {
  it('grows ~1.6x at the key, ~1.3x at the midpoint, keeps the pivot screen-fixed, and never scales children', () => {
    setEditorMode('animate');
    const part = artPart();
    // A child bone parented to the part: its transform composes the part's POSE (rotate +
    // translate) but NOT the part's innermost scale, so it must stay put as the part scales.
    const child = addNullPart(
      'bone', { x: part.pivot.x + 8, y: part.pivot.y + 8 }, part.id, 'scale_child',
    );
    registerPart(child);

    checkpoint();
    setKeyframeAt(part.id, 'sy', 0, 1, 'linear');
    setKeyframeAt(part.id, 'sy', 1000, 1.6, 'linear');
    notify();

    state.currentTime = 0;
    repaint();
    const base = yScale(part.label);
    const childBase = groupYScale(child.id);
    const pivot0 = pivotScreen(part.label);

    // Linear midpoint 1 → 1.6 = 1.3 (a stepped/rest-only read would give 1.0 here).
    state.currentTime = 500;
    repaint();
    expectClose(yScale(part.label) / base, 1.3, 0.02, 'sy linear midpoint');

    // At the key: the artwork is 1.6x taller.
    state.currentTime = 1000;
    repaint();
    expectClose(yScale(part.label) / base, 1.6, 0.01, 'sy at the key grows the artwork 1.6x');

    // Anchor invariant: the joint (pivot) is the scale's fixed point — screen-fixed.
    const pivot1 = pivotScreen(part.label);
    expectClose(pivot1.x, pivot0.x, 1.0, 'pivot x stays screen-fixed under scale');
    expectClose(pivot1.y, pivot0.y, 1.0, 'pivot y stays screen-fixed under scale');

    // Convention: inner scale does NOT propagate to children.
    expectClose(groupYScale(child.id), childBase, 0.001, 'the child part is not scaled by its parent');
  });
});

describe('scenario — Edit mode renders rest scale, ignoring a keyed sy at the playhead', () => {
  it('a keyed sy does not affect the Edit-mode render even with the playhead over the key', () => {
    setEditorMode('animate');
    const part = artPart();
    checkpoint();
    setKeyframeAt(part.id, 'sy', 0, 1, 'linear');
    setKeyframeAt(part.id, 'sy', 1000, 1.6, 'linear');
    notify();
    state.currentTime = 0;
    repaint();
    const animBase = yScale(part.label); // sy 1 == rest scale

    setEditorMode('setup');
    state.currentTime = 1000; // playhead parked over the 1.6 key
    repaint();
    expectClose(
      yScale(part.label), animBase, 0.005,
      'Edit render uses rest scale (poseTime() null), not the keyed 1.6',
    );
  });
});

describe('scenario — Animate inspector exposes keyable scale x / scale y fields', () => {
  it('shows the keyed sy filled at the playhead, Edit has only the rest field, and one undo clears the key', () => {
    setEditorMode('animate');
    const part = artPart();
    selectByLabel(part.label);

    expect(fieldInput('scale x'), 'keyable scale x field present in Animate').toBeTruthy();
    const syInput = fieldInput('scale y');
    expect(syInput, 'keyable scale y field present in Animate').toBeTruthy();

    // Unkeyed → hollow toggle, rest value (1).
    expect(keyToggle('scale y').classList.contains('is-keyed'), 'hollow when unkeyed').toBe(false);
    expect(Number(syInput!.value)).toBeCloseTo(1, 9);

    // Key sy 1.6 at t=1000, rebuild the inspector, confirm the field reflects it FILLED.
    state.currentTime = 1000;
    checkpoint();
    setKeyframeAt(part.id, 'sy', 1000, 1.6, 'linear');
    notify();
    expect(
      keyToggle('scale y').classList.contains('is-keyed'), 'filled circle at a keyed frame',
    ).toBe(true);
    expect(Number(fieldInput('scale y')!.value)).toBeCloseTo(1.6, 9);

    // One undo removes the key entirely (track empties → hollow toggle, rest value again).
    undo();
    notify();
    expect(clipTrack(part.id, 'sy'), 'undo removed the sy track').toBeFalsy();
    expect(keyToggle('scale y').classList.contains('is-keyed'), 'hollow after undo').toBe(false);

    // Edit mode swaps in the rest-scale numberField instead of the keyable one.
    setEditorMode('setup');
    selectByLabel(part.label);
    expect(fieldInput('scale y'), 'no keyable scale y in Edit mode').toBeFalsy();
    expect(fieldInput('rest scale y'), 'Edit shows the rest scale field instead').toBeTruthy();
  });
});
