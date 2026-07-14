/**
 * Interaction tests for PIN-TO-REST (2026-07-14): a per-node skin-weight override field
 * that holds a fraction of a node at its BIND-POSE position regardless of which bone(s)
 * would otherwise carry it — CLAUDE.md's Bone system section, "Weight model". Reported
 * bug this fixes: an origin-end bone-carry override (t=0) still rotates WITH that bone
 * (it just picks which bone carries the node, never "don't follow any bone"), so a
 * user's armpit nodes swung away from the torso instead of staying put.
 *
 * Full realistic gestures via the harness (elementFromPoint hit targets, real drag
 * sequences) — see "Testing interactions" in CLAUDE.md. The primary scenario drives the
 * REAL inspector UI (panels/inspectorSections/skinSection.ts's "Pin to body" slider +
 * apply button), not the view-layer function directly, so a UI regression there would
 * be caught here too.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { parsePath } from '../../geometry/paths';
import { selectPart as modelSelectPart, notify } from '../../core/model';
import {
  setNodeBinding, setNodePin, recomputeAutoWeights, deleteSelectedNodes, selectedNodeCount,
} from '../../view';
import {
  bootRig, resetRig, state, partByLabel, gestureDrag, click, clientCenterOf, overlayEl,
  expectClose, setEditorMode, enterNodeMode, medialPoints, placeBoneChain, selectByLabel,
  pathElById, renderPose,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** The connected-chain invariant (copied from bones.test.ts/skinnedPose.test.ts): a
 *  child bone's origin never drifts from its parent's tip after any gesture. */
function assertNoGap(): void {
  const parts = state.doc?.parts ?? [];
  for (const child of parts) {
    if (child.kind !== 'bone' || !child.parentId || child.attachedRoot) continue;
    const parent = parts.find((p) => p.id === child.parentId && p.kind === 'bone');
    if (!parent || !parent.boneTip) continue;
    expectClose(child.pivot.x + child.rest.tx, parent.boneTip.x, 0.3, 'no gap: child origin x == parent tip x');
    expectClose(child.pivot.y + child.rest.ty, parent.boneTip.y, 0.3, 'no gap: child origin y == parent tip y');
  }
}
afterEach(assertNoGap);

const LIMB = 'left_leg';

/** Mirrors skinnedPose.test.ts's skinLimb(): bind a 2-bone chain with LIMB selected
 *  first, so bone 1 parents to it (predictable — the skin binds to exactly LIMB). */
function skinLimb() {
  selectByLabel(LIMB);
  const bones = placeBoneChain(medialPoints(LIMB, 2));
  expect(partByLabel(LIMB).skin, 'limb auto-bound').toBeTruthy();
  expect(bones[0].parentId, 'bone 1 parented to the limb').toBe(partByLabel(LIMB).id);
  return bones;
}

/** Every `.node-handle[data-field="x"]` for `pathId`, in DOM order. */
function nodeHandles(pathId: string): SVGElement[] {
  return Array.from(
    overlayEl().querySelectorAll(`.node-handle[data-path-id="${pathId}"][data-field="x"]`),
  ) as SVGElement[];
}

/** A node's current RENDERED doc-space coordinate, read straight off the live `d`
 *  attribute (skinned parts write deformed doc-space coordinates directly — no group
 *  transform — so this is the same "screen-equivalent" measurement the exporter and the
 *  live canvas both use). */
function nodeDocPos(pathId: string, cmdIndex: number): { x: number; y: number } {
  const cmds = parsePath(pathElById(pathId).getAttribute('d')!);
  const c = cmds[cmdIndex] as unknown as { x: number; y: number };
  return { x: c.x, y: c.y };
}

/** Find the "Pin to body" slider + its apply/clear buttons in the REAL inspector DOM. */
function pinControls(): { slider: HTMLInputElement; apply: HTMLButtonElement; clear: HTMLButtonElement } {
  const rows = Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'));
  const row = rows.find((r) => (r.querySelector('span')?.textContent ?? '').startsWith('pin to body'));
  expect(row, '"Pin to body" field present in the inspector').toBeTruthy();
  const slider = row!.querySelector('input[type="range"]') as HTMLInputElement;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#inspector .align-grid button'));
  const apply = buttons.find((b) => b.textContent === 'apply pin')!;
  const clear = buttons.find((b) => b.textContent === 'clear pin')!;
  expect(apply, '"apply pin" button present').toBeTruthy();
  expect(clear, '"clear pin" button present').toBeTruthy();
  return { slider, apply, clear };
}

function setSliderPct(input: HTMLInputElement, pct: number): void {
  input.value = String(pct);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Grab the root bone's tip handle and drag it, reshaping (rotating) the whole chain —
 *  the same gesture bones.test.ts's "rotating a bone deforms every bound body piece"
 *  scenario uses. Exits node-editing mode first (a realistic workflow: pin the nodes,
 *  then go pose the limb). */
function rotateChainByTipDrag(rootBoneId: string, dx: number, dy: number): void {
  state.mode = 'rig';
  modelSelectPart(rootBoneId);
  notify();
  renderPose();
  const tipEl = overlayEl().querySelector('[data-role="bone-tip"]') as SVGElement;
  expect(tipEl, 'root bone tip handle present').toBeTruthy();
  const from = clientCenterOf(tipEl);
  gestureDrag(from, { x: from.x + dx, y: from.y + dy });
}

describe('scenario PIN1 — pinning a node via the REAL inspector UI holds it through a bone rotation', () => {
  it('a 100% pin holds the node within 0.5px while an unpinned node keeps articulating', () => {
    setEditorMode('setup');
    const bones = skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);

    const handles = nodeHandles(pathId);
    expect(handles.length, 'left_leg has multiple path nodes').toBeGreaterThan(3);

    // Pin the FIRST handle; leave a different one (the last) unpinned as a control.
    const pinnedHandle = handles[0];
    const controlHandle = handles[handles.length - 1];
    const pinnedCmdIndex = Number(pinnedHandle.dataset.cmdIndex);
    const controlCmdIndex = Number(controlHandle.dataset.cmdIndex);

    const pt = clientCenterOf(pinnedHandle);
    click(pt.x, pt.y);
    expect(selectedNodeCount(), 'exactly one node selected').toBe(1);

    const { slider, apply } = pinControls();
    setSliderPct(slider, 100);
    apply.click();

    const ov = partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(pinnedCmdIndex)];
    expect(ov?.pin, 'pin recorded on the doc via the real UI').toBe(1);

    const pinnedBefore = nodeDocPos(pathId, pinnedCmdIndex);
    const controlBefore = nodeDocPos(pathId, controlCmdIndex);

    rotateChainByTipDrag(bones[0].id, 45, -30);

    const pinnedAfter = nodeDocPos(pathId, pinnedCmdIndex);
    const controlAfter = nodeDocPos(pathId, controlCmdIndex);
    const pinnedDrift = Math.hypot(pinnedAfter.x - pinnedBefore.x, pinnedAfter.y - pinnedBefore.y);
    const controlDrift = Math.hypot(controlAfter.x - controlBefore.x, controlAfter.y - controlBefore.y);

    expectClose(pinnedDrift, 0, 0.5, `pinned node holds at rest (drift=${pinnedDrift.toFixed(3)}px)`);
    expect(controlDrift, `unpinned node still articulates (drift=${controlDrift.toFixed(2)}px)`)
      .toBeGreaterThan(2);
  });
});

describe('scenario PIN2 — a 50% pin roughly halves the drift versus 0%/100%', () => {
  it('interpolates between fully-driven and fully-held', () => {
    setEditorMode('setup');
    const bones = skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);
    const handle = nodeHandles(pathId)[0];
    const cmdIndex = Number(handle.dataset.cmdIndex);
    const pt = clientCenterOf(handle);
    click(pt.x, pt.y);

    const restPos = nodeDocPos(pathId, cmdIndex);

    // 0% (no pin at all): baseline drift.
    rotateChainByTipDrag(bones[0].id, 40, -25);
    const drift0 = Math.hypot(
      nodeDocPos(pathId, cmdIndex).x - restPos.x, nodeDocPos(pathId, cmdIndex).y - restPos.y,
    );
    expect(drift0, 'unpinned baseline actually moves').toBeGreaterThan(2);

    // Undo the rotation, then set pin=50%, then rotate the SAME amount again.
    undo();
    enterNodeMode(LIMB, pathId);
    const pt2 = clientCenterOf(nodeHandles(pathId)[0]);
    click(pt2.x, pt2.y);
    const { slider, apply } = pinControls();
    setSliderPct(slider, 50);
    apply.click();
    const restPos2 = nodeDocPos(pathId, cmdIndex);
    rotateChainByTipDrag(bones[0].id, 40, -25);
    const drift50 = Math.hypot(
      nodeDocPos(pathId, cmdIndex).x - restPos2.x, nodeDocPos(pathId, cmdIndex).y - restPos2.y,
    );

    expect(drift50, '50% pin roughly halves the drift').toBeLessThan(drift0 * 0.7);
    expect(drift50, '...but is not fully held either').toBeGreaterThan(drift0 * 0.2);
  });
});

describe('scenario PIN3 — pin lifecycle: survives a plain node drag, dies on structural edits and recompute', () => {
  it('a plain (non-structural) node-position drag keeps the pin', () => {
    setEditorMode('setup');
    skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);
    const handle = nodeHandles(pathId)[1];
    const cmdIndex = Number(handle.dataset.cmdIndex);
    const pt = clientCenterOf(handle);
    click(pt.x, pt.y);
    expect(setNodePin(1), 'pin set via the view layer').toBe(true);
    expect(partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(cmdIndex)]?.pin).toBe(1);

    // Drag the SAME node's handle a few px — a plain position edit, not a structural
    // command-count change, so nodeTypes/overrides stay in lockstep (CLAUDE.md: "Plain
    // node drags ... keep the index, so they keep overrides").
    const from = clientCenterOf(nodeHandles(pathId)[1]);
    gestureDrag(from, { x: from.x + 4, y: from.y + 3 });

    expect(
      partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(cmdIndex)]?.pin,
      'pin survives a plain node drag',
    ).toBe(1);
  });

  it('a structural node edit (delete) drops the pin along with the rest of the override', () => {
    setEditorMode('setup');
    skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);
    const handles = nodeHandles(pathId);
    // Never the M (start) node — deleteSelectedNodes refuses that one.
    const target = handles[handles.length - 1];
    const cmdIndex = Number(target.dataset.cmdIndex);
    const pt = clientCenterOf(target);
    click(pt.x, pt.y);
    expect(setNodeBinding(partByLabel(LIMB).skin!.bones[0].id, null, 0), 'bone carry set').toBe(true);
    expect(setNodePin(1), 'pin set').toBe(true);
    expect(partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(cmdIndex)]).toEqual(
      { a: partByLabel(LIMB).skin!.bones[0].id, b: null, t: 0, pin: 1 },
    );

    expect(deleteSelectedNodes(), 'node deleted').toBe(true);

    expect(
      partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(cmdIndex)],
      'the whole override (carry AND pin) is gone after the structural edit',
    ).toBeUndefined();
    expect(partByLabel(LIMB).skin!.bones.length, 'the bone binding itself is untouched').toBe(2);
  });

  it('"recompute auto weights" drops every pin along with every override', () => {
    setEditorMode('setup');
    skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);
    const handle = nodeHandles(pathId)[0];
    const pt = clientCenterOf(handle);
    click(pt.x, pt.y);
    expect(setNodePin(1), 'pin set').toBe(true);
    expect(partByLabel(LIMB).skin!.overrides, 'override present before recompute').toBeTruthy();
    void pathId;

    expect(recomputeAutoWeights(), 'recompute reports a change').toBe(true);

    expect(partByLabel(LIMB).skin!.overrides, 'every override (incl. every pin) gone').toBeUndefined();
  });
});

describe('scenario PIN4 — undo restores a pin set through the real inspector UI', () => {
  it('undo removes the applied pin and restores the exact prior doc state', () => {
    setEditorMode('setup');
    skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    enterNodeMode(LIMB, pathId);
    const handle = nodeHandles(pathId)[0];
    const cmdIndex = Number(handle.dataset.cmdIndex);
    const pt = clientCenterOf(handle);
    click(pt.x, pt.y);

    expect(partByLabel(LIMB).skin!.overrides, 'no overrides before applying').toBeFalsy();

    const { slider, apply } = pinControls();
    setSliderPct(slider, 100);
    apply.click();
    expect(partByLabel(LIMB).skin!.overrides?.[pathId]?.[String(cmdIndex)]?.pin, 'pin applied').toBe(1);
    expect(canUndo(), 'the apply spent an undo step').toBe(true);

    undo();

    expect(
      partByLabel(LIMB).skin!.overrides,
      'undo restores the doc to having no overrides at all',
    ).toBeFalsy();
  });
});
