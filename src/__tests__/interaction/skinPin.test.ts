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
import { selectPart as modelSelectPart, notify, setKeyframeAt, RigPart } from '../../core/model';
import { matrixOfTransform, applyMat } from '../../geometry/transforms';
import {
  setNodeBinding, setNodePin, recomputeAutoWeights, deleteSelectedNodes, selectedNodeCount,
  invalidateSkinCache,
} from '../../view';
import {
  bootRig, resetRig, state, partByLabel, gestureDrag, click, clientCenterOf, overlayEl,
  expectClose, setEditorMode, enterNodeMode, medialPoints, placeBoneChain, selectByLabel,
  pathElById, renderPose, pressKey, clientPointOnPart, clipTrack, repaint,
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

// ---- PIN5–PIN9: the pin target is the RIGID-EQUIVALENT pose, not world space ----
//
// User report 2026-07-14 ("Pinning works amazingly well, until I move the parent body —
// then the pinned nodes are frozen in place, not actually tracking with the overall
// group movements"): the pin lerp used to target the CONSTANT bind coordinate, nailing a
// pin=1 node to world space while the LBS side rode the ancestor chain. The fixed target
// is fullPose(part,t) · skin.restWorldInv · bindPos — where that vertex would render if
// the part were NOT skinned — matching the .riv runtime's pin-anchor semantics (the
// anchor RootBone is a child of the part's Node, so it rides the node hierarchy).
// Reproduced with the user's file: pin=1 nodes sat 94.5–98.1px from their
// rigid-equivalent position under the dance clip's keyed Girl rotate/tx/ty.

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Pin ONE node (the first handle) at `pin` via the view layer, then leave node mode.
 *  Returns the pinned command index plus a control (last-handle) index. */
function pinFirstNode(pathId: string, pin = 1): { pinnedCmd: number; controlCmd: number } {
  enterNodeMode(LIMB, pathId);
  const handles = nodeHandles(pathId);
  expect(handles.length, 'limb has multiple path nodes').toBeGreaterThan(3);
  const pinnedCmd = Number(handles[0].dataset.cmdIndex);
  const controlCmd = Number(handles[handles.length - 1].dataset.cmdIndex);
  const pt = clientCenterOf(handles[0]);
  click(pt.x, pt.y);
  expect(setNodePin(pin), 'pin set via the view layer').toBe(true);
  state.mode = 'rig';
  modelSelectPart(null);
  notify();
  renderPose();
  return { pinnedCmd, controlCmd };
}

/** Wrap left_leg + right_leg in a group via the REAL Ctrl+G binding (Edit mode). */
function groupLegs(): RigPart {
  modelSelectPart(partByLabel(LIMB).id);
  modelSelectPart(partByLabel('right_leg').id, true);
  notify();
  const before = new Set(state.doc!.parts.map((p) => p.id));
  pressKey('g', { ctrlKey: true });
  const group = state.doc!.parts.find((p) => !before.has(p.id));
  expect(group, 'Ctrl+G created a group').toBeTruthy();
  expect(group!.kind).toBe('group');
  repaint();
  return group!;
}

/** The keyed value at `time` on (target, channel), asserting the key exists. */
function keyedValue(target: string, channel: string, time: number): number {
  const key = clipTrack(target, channel)?.keyframes.find((k) => k.time === time);
  expect(key, `key ${target}.${channel}@${time} recorded`).toBeTruthy();
  return key!.value;
}

describe('scenario PIN5 — the user\'s bug: a pin=1 node rides a KEYED parent-group translate', () => {
  it('pinned and unpinned nodes both translate by exactly the keyed group tx/ty', () => {
    setEditorMode('setup');
    skinLimb();
    const pathId = partByLabel(LIMB).paths[0].id;
    const { pinnedCmd, controlCmd } = pinFirstNode(pathId);
    const group = groupLegs();
    const pinnedBind = nodeDocPos(pathId, pinnedCmd);
    const controlBind = nodeDocPos(pathId, controlCmd);

    setEditorMode('animate');
    state.currentTime = 500;
    renderPose();
    // The user's gesture: Shift+drag the parent body (pressing the group's NON-skinned
    // member) — Animate Shift+drag translates and keys group tx/ty at the playhead.
    const from = clientPointOnPart('right_leg');
    gestureDrag(from, { x: from.x + 50, y: from.y - 30 }, { shiftKey: true });
    const kx = keyedValue(group.id, 'tx', 500);
    const ky = keyedValue(group.id, 'ty', 500);
    expect(Math.hypot(kx, ky), 'the drag recorded a real translate').toBeGreaterThan(5);

    const pinnedDrift = dist(nodeDocPos(pathId, pinnedCmd),
      { x: pinnedBind.x + kx, y: pinnedBind.y + ky });
    const controlDrift = dist(nodeDocPos(pathId, controlCmd),
      { x: controlBind.x + kx, y: controlBind.y + ky });
    expectClose(pinnedDrift, 0, 0.05,
      `pin=1 node rides the keyed group translate (drift=${pinnedDrift.toFixed(3)}px)`);
    expectClose(controlDrift, 0, 0.05, 'unpinned node translates with the group too');
  });
});

describe('scenario PIN6 — a pin=1 node rides the skinned part\'s OWN keyed rotate + translate', () => {
  it('the pinned node lands exactly at ownPose(keys) · bindPos', () => {
    setEditorMode('setup');
    skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    const { pinnedCmd } = pinFirstNode(pathId);
    const bind = nodeDocPos(pathId, pinnedCmd);

    setEditorMode('animate');
    state.currentTime = 500;
    // Skinned parts accept rotate/translate pose drags (CLAUDE.md ruling). Rotate takes
    // the unified-gizmo second-click state (SP1's exact gesture: click selects, a
    // motionless second click toggles rotate mode, then the drag keys rotate); a
    // Shift+drag keys tx/ty regardless of handle mode (SP2). All at the playhead.
    let pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y);
    pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y);
    pt = clientPointOnPart(LIMB);
    gestureDrag(pt, { x: pt.x + 40, y: pt.y + 25 });
    const p2 = clientPointOnPart(LIMB);
    gestureDrag(p2, { x: p2.x - 30, y: p2.y + 20 }, { shiftKey: true });

    const rot = keyedValue(limb.id, 'rotate', 500);
    const tx = keyedValue(limb.id, 'tx', 500);
    const ty = keyedValue(limb.id, 'ty', 500);
    expect(Math.abs(rot), 'the drag recorded a real rotation').toBeGreaterThan(2);
    // Hand-composed ownPose (independent of the render path's own kernel calls):
    // translate(tx,ty) rotate(rot, pivot) — the rigid-equivalent of an unskinned part.
    const M = matrixOfTransform(
      `translate(${tx},${ty}) rotate(${rot},${limb.pivot.x},${limb.pivot.y})`,
    );
    const expected = applyMat(M, bind.x, bind.y);
    const drift = dist(nodeDocPos(pathId, pinnedCmd), expected);
    expectClose(drift, 0, 0.05,
      `pin=1 node rides the part's own keyed pose (drift=${drift.toFixed(3)}px)`);
  });
});

describe('scenario PIN7 — a 0.5 pin lands at the midpoint of LBS and rigid-equivalent', () => {
  it('pin=1 hits the rigid target exactly; pin=0.5 is the exact midpoint to pure LBS', () => {
    setEditorMode('setup');
    const bones = skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    const { pinnedCmd } = pinFirstNode(pathId);
    const group = groupLegs();
    const bind = nodeDocPos(pathId, pinnedCmd);

    setEditorMode('animate');
    state.currentTime = 500;
    // Articulate a bone so LBS and rigid-equivalent genuinely differ, then translate
    // the group (the user's "move the parent body").
    setKeyframeAt(bones[0].id, 'rotate', 500, 35);
    renderPose();
    const from = clientPointOnPart('right_leg');
    gestureDrag(from, { x: from.x + 45, y: from.y - 25 }, { shiftKey: true });
    const kx = keyedValue(group.id, 'tx', 500);
    const ky = keyedValue(group.id, 'ty', 500);

    const P1 = nodeDocPos(pathId, pinnedCmd); // pin=1 → the rigid-equivalent position
    const rigidDrift = dist(P1, { x: bind.x + kx, y: bind.y + ky });
    expectClose(rigidDrift, 0, 0.05,
      `pin=1 sits at the rigid-equivalent under group translate (drift=${rigidDrift.toFixed(3)}px)`);

    // Re-target the SAME node's pin directly (render semantics under test — the UI
    // path is already pinned by PIN1/PIN4): 0 = pure LBS, then 0.5.
    const overrides = limb.skin!.overrides!;
    delete overrides[pathId][String(pinnedCmd)];
    invalidateSkinCache(limb.id);
    renderPose();
    const P0 = nodeDocPos(pathId, pinnedCmd);
    expect(dist(P0, P1), 'bone key articulates: LBS differs from rigid').toBeGreaterThan(2);

    overrides[pathId][String(pinnedCmd)] = { a: null, b: null, t: 0, pin: 0.5 };
    invalidateSkinCache(limb.id);
    renderPose();
    const P05 = nodeDocPos(pathId, pinnedCmd);
    expectClose(P05.x, (P0.x + P1.x) / 2, 0.05, 'pin=0.5 x is the exact midpoint');
    expectClose(P05.y, (P0.y + P1.y) / 2, 0.05, 'pin=0.5 y is the exact midpoint');
  });
});

describe('scenario PIN8 — an EDIT-mode group move carries pinned nodes (the "posing" half)', () => {
  it('dragging the parent group in Edit moves a pin=1 node by exactly the group rest delta', () => {
    setEditorMode('setup');
    skinLimb();
    const pathId = partByLabel(LIMB).paths[0].id;
    const { pinnedCmd } = pinFirstNode(pathId);
    const group = groupLegs();
    const bind = nodeDocPos(pathId, pinnedCmd);

    // Edit-mode body drag on the group's non-skinned member MOVES the group (rest.tx/ty).
    const from = clientPointOnPart('right_leg');
    gestureDrag(from, { x: from.x + 45, y: from.y + 25 });
    const { tx, ty } = group.rest;
    expect(Math.hypot(tx, ty), 'the drag moved the group rest pose').toBeGreaterThan(5);

    const drift = dist(nodeDocPos(pathId, pinnedCmd), { x: bind.x + tx, y: bind.y + ty });
    expectClose(drift, 0, 0.05,
      `pin=1 node rides the Edit-mode group move (drift=${drift.toFixed(3)}px)`);
  });
});

describe('scenario PIN9 — freeze holds pinned nodes on a rest-posed skinned part', () => {
  it('a freeze joint drag after rest-translating the limb leaves the pinned node in place', () => {
    setEditorMode('setup');
    const bones = skinLimb();
    const limb = partByLabel(LIMB);
    const pathId = limb.paths[0].id;
    const { pinnedCmd, controlCmd } = pinFirstNode(pathId);

    // Rest-pose the SKINNED part itself (translate is an allowed pose drag): now the
    // part's own pose is non-identity, the case where a naive fullPose·bindPos target
    // would double-apply after the freeze capture re-bakes geometry at the current look.
    selectByLabel(LIMB);
    const from = clientPointOnPart(LIMB);
    gestureDrag(from, { x: from.x + 35, y: from.y + 20 });
    expect(Math.hypot(limb.rest.tx, limb.rest.ty), 'limb rest-posed').toBeGreaterThan(5);
    renderPose();
    const pinnedBefore = nodeDocPos(pathId, pinnedCmd);
    const controlBefore = nodeDocPos(pathId, controlCmd);

    // Freeze: drag the child bone's origin (the shared joint) — captureFrozenBaseline
    // re-bakes the current look and MUST refresh the pin reference along with the bone
    // binds, so the art (pinned nodes included) holds while the joint moves.
    pressKey('y');
    repaint();
    modelSelectPart(bones[1].id);
    notify();
    repaint();
    const joint = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    gestureDrag(joint, { x: joint.x + 25, y: joint.y + 18 }, { steps: 10 });

    const pinnedDrift = dist(nodeDocPos(pathId, pinnedCmd), pinnedBefore);
    const controlDrift = dist(nodeDocPos(pathId, controlCmd), controlBefore);
    expectClose(pinnedDrift, 0, 0.05,
      `freeze holds the pinned node (drift=${pinnedDrift.toFixed(3)}px)`);
    expectClose(controlDrift, 0, 0.05, 'freeze holds the unpinned art too');
    pressKey('y'); // leave freeze for the afterEach invariant sweep
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
