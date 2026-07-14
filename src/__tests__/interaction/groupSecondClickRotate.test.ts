/**
 * Interaction tests for the "can't rotate the selected group" bug (user report
 * 2026-07-14, verbatim: "Why can't I rotate the 'Girl' group? I can only translate?
 * Trying to click again just selects the child Body, it doesn't give me rotation
 * handles."). Reproduced on the user's exact save file (group `Girl` → art `Body` +
 * skinned art `RightArm`): picking a CHILD via a Layers row calls `enterGroupsFor`,
 * which opens the group as an editing context; picking the GROUP's own row afterwards
 * selected it but left it "entered" — `repairEnteredGroups`' old keep-rule
 * (`sp.id === id`) deliberately preserved an entered id that equals a selected part.
 * In that contradictory state (open-to-work-inside AND selected-as-a-whole) the
 * artwork pipeline's group substitution is suppressed by the entry, so every canvas
 * click stole the selection down to the child under the cursor and the second-click
 * rotate corners were unreachable.
 *
 * Fix (view/focus.ts): the repair keeps an entered id only when it is a STRICT
 * ancestor of a selected part — selecting the whole group (any site: Layers row,
 * context menu, canvas substitution; the repair is the one chokepoint they all render
 * through) closes its own entry. The deliberate "dive in, select nothing" dblclick
 * state is untouched (repair still early-returns with no selection).
 *
 * Scenarios: the user's exact recipe in Edit AND Animate (a), the rotate-corner drag
 * writing the group's OWN rest.rotate / keyed rotate about the group's PIVOT — with
 * the pivot moved far away like the user's file, so the orbit is visible (b + the
 * pivot-semantics check), dblclick drill-in still selecting children afterwards (c),
 * and undo restoring the drags (d). Real gestures throughout (elementFromPoint hit
 * targets, full pointer sequences, numeric + DOM assertions) per the harness rules.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { selectPart } from '../../core/model';
import { enterGroupsFor, partRootBoxes } from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  fullDblClick, pressKey, overlayEl, overlayCount, expectClose, docToClient,
  clientCenterOf, count, repaint, setEditorMode, clipTrack, notify,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Ctrl+G left_arm + right_arm into a fresh `kind:'group'` via the real gesture —
 *  the user's file's shape (a group whose only clickable artwork is its children). */
function makeGroup() {
  let p = clientPointOnPart('left_arm');
  click(p.x, p.y);
  p = clientPointOnPart('right_arm');
  click(p.x, p.y, { shiftKey: true });
  groupAction();
  const group = state.doc!.parts.find((pt) => pt.kind === 'group')!;
  expect(group, 'groupAction produced a group part').toBeTruthy();
  expect(state.selectedPartId).toBe(group.id);
  return group;
}

/**
 * The user's exact recipe up to the failing click, driven the way the Layers rows
 * drive it (layers.ts row.onclick = selectPart + enterGroupsFor + notify/render —
 * the documented mirror driver, groupLikeArt.test.ts GL1 precedent): pick a CHILD
 * row (opens the group as context — the dimming proves it), then pick the GROUP row.
 */
function layersPickChildThenGroup(group: ReturnType<typeof makeGroup>) {
  const leftArm = partByLabel('left_arm');
  selectPart(leftArm.id);
  enterGroupsFor(leftArm.id);
  notify();
  repaint();
  expect(count('.dimmed'), 'picking the child opened the group as an entered context').toBeGreaterThan(0);

  selectPart(group.id);
  enterGroupsFor(group.id);
  notify();
  repaint();
  // THE FIX, DOM-visible: selecting the group as a whole closes its own entry, so
  // nothing stays dimmed. Pre-fix the entry survived (the old `sp.id === id` keep-
  // rule) and the dim persisted here.
  expect(count('.dimmed'), 'selecting the group itself closes its entered context').toBe(0);
}

describe('scenario GR1 — the user\'s recipe (Edit): Layers child pick, Layers group pick, canvas clicks toggle the group\'s handle sets', () => {
  it('canvas click keeps the GROUP selected (pre-fix: stole the child) and toggles translate-box -> rotate corners -> back', () => {
    const group = makeGroup();
    const leftArm = partByLabel('left_arm');
    layersPickChildThenGroup(group);

    // The reported click: on the child's artwork, with the group already primary.
    // Pre-fix this selected left_arm (the "just selects the child Body" symptom).
    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'the group stays selected — never hijacked to the child').toBe(group.id);
    expect(state.selectedPartId).not.toBe(leftArm.id);
    // The group was already primary, so that click IS the second click: rotate set.
    expect(overlayCount('.rotate-handle'), '4 rotate corners appear').toBe(4);
    expect(overlayCount('.scale-handle'), 'scale set gone').toBe(0);
    expect(overlayCount('.skew-handle'), 'groups get no skew sides').toBe(0);

    // Third click: swaps back to the scale/translate set.
    p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(group.id);
    expect(overlayCount('.scale-handle'), 'back to the 8-handle scale set').toBe(8);
    expect(overlayCount('.rotate-handle')).toBe(0);
  });

  it('fresh pure-canvas ladder still holds: click selects group, second click rotate corners, third back', () => {
    const group = makeGroup();
    pressKey('Escape'); // deselect so the ladder starts from nothing selected
    expect(state.selectedPartId).toBeNull();

    let p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'click 1 substitutes up to the closed group').toBe(group.id);
    expect(overlayCount('.scale-handle')).toBe(8);

    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'click 2 keeps the group').toBe(group.id);
    expect(overlayCount('.rotate-handle')).toBe(4);
    expect(overlayCount('.scale-handle')).toBe(0);

    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'click 3 keeps the group').toBe(group.id);
    expect(overlayCount('.scale-handle')).toBe(8);
    expect(overlayCount('.rotate-handle')).toBe(0);
  });
});

describe('scenario GR2 — the user\'s recipe (Animate): same toggle, the rotate drag KEYS the group\'s rotate', () => {
  it('canvas click keeps the group and shows rotate corners; a corner drag writes a rotate key; undo removes it', () => {
    const group = makeGroup();
    setEditorMode('animate');
    layersPickChildThenGroup(group);

    const p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'Animate parity: group stays selected').toBe(group.id);
    expect(overlayCount('.rotate-handle'), 'Animate second click shows the rotate corners').toBe(4);

    const pivotC = docToClient(group.pivot);
    const handles = Array.from(overlayEl().querySelectorAll('[data-role="rotate-handle"]'));
    const start = handles
      .map((h) => { const c = clientCenterOf(h); return { c, d: Math.hypot(c.x - pivotC.x, c.y - pivotC.y) }; })
      .sort((a, b) => b.d - a.d)[0].c;
    const th = (20 * Math.PI) / 180;
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    gestureDrag(start, {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    });

    const track = clipTrack(group.id, 'rotate');
    expect(track, 'the drag keyed the GROUP\'s own rotate channel').toBeTruthy();
    expect(track!.keyframes.length).toBe(1);
    expectClose(Math.cos(((track!.keyframes[0].value - 20) * Math.PI) / 180), 1, 1e-2, 'keyed value ~20°');
    expect(clipTrack(partByLabel('left_arm').id, 'rotate'), 'children get no keys of their own').toBeUndefined();

    expect(canUndo()).toBe(true);
    undo();
    expect(clipTrack(group.id, 'rotate')?.keyframes.length ?? 0, 'undo removes the key').toBe(0);
  });
});

describe('scenario GR3 — the rotate drag rotates about the group\'s PIVOT (far-away pivot orbits, like the user\'s file), Edit mode', () => {
  it('writes the group\'s OWN rest.rotate ~20° measured about the moved pivot; the child visibly orbits; one undo restores', () => {
    const group = makeGroup();
    const leftArm = partByLabel('left_arm');
    layersPickChildThenGroup(group);

    // The user's Girl has its pivot at (-0.5, 0), hundreds of units from the artwork —
    // rotation legitimately ORBITS the art (pivot is user-editable in freeze mode; this
    // is correct semantics, not part of the bug). Recreate that shape: park the pivot
    // 200 doc units left of where Ctrl+G put it (selection-bbox center). A partless
    // group at identity rest renders nothing differently, so no compensation needed.
    group.pivot = { x: group.pivot.x - 200, y: group.pivot.y };
    repaint();

    let p = clientPointOnPart('left_arm');
    click(p.x, p.y); // second click (group already primary) -> rotate corners
    expect(overlayCount('.rotate-handle')).toBe(4);

    const pivotC = docToClient(group.pivot);
    const handles = Array.from(overlayEl().querySelectorAll('[data-role="rotate-handle"]'));
    const start = handles
      .map((h) => { const c = clientCenterOf(h); return { c, d: Math.hypot(c.x - pivotC.x, c.y - pivotC.y) }; })
      .sort((a, b) => b.d - a.d)[0].c;
    const boxBefore = partRootBoxes([leftArm.id]).get(leftArm.id)!;

    // Construct the drag as an exact 20° arc ABOUT THE PIVOT. If the rotate pipeline
    // measured its angle about anything else (e.g. the union-box center, 200 units
    // away), the same chord would subtend a very different angle — the tight tolerance
    // below is the pivot-semantics assertion.
    const th = (20 * Math.PI) / 180;
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    gestureDrag(start, {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    });

    const group2 = state.doc!.parts.find((pt) => pt.id === group.id)!;
    expectClose(Math.cos(((group2.rest.rotate - 20) * Math.PI) / 180), 1, 1e-2, 'rest.rotate advanced ~20° about the pivot');
    expect(partByLabel('left_arm').rest.rotate, 'the child\'s OWN rotate is untouched — it rides the group pose').toBe(0);

    // Far-away pivot => the child ORBITS: its rendered box center moves substantially
    // (~2·R·sin(10°) ≈ 69 doc units at R≈200; an in-place rotation would barely move it).
    const boxAfter = partRootBoxes([leftArm.id]).get(leftArm.id)!;
    const centerShift = Math.hypot(
      (boxAfter.x + boxAfter.w / 2) - (boxBefore.x + boxBefore.w / 2),
      (boxAfter.y + boxAfter.h / 2) - (boxBefore.y + boxBefore.h / 2),
    );
    expect(centerShift, 'the child orbits the far-away pivot').toBeGreaterThan(30);

    expect(canUndo()).toBe(true);
    undo();
    const groupR = state.doc!.parts.find((pt) => pt.id === group.id)!;
    expect(groupR.rest.rotate, 'undo restores the group\'s rest.rotate exactly').toBe(0);
  });
});

describe('scenario GR4 — dblclick drill-in is untouched: dive still selects nothing, later clicks select children', () => {
  it('the strict-ancestor repair never disturbs the select-nothing dive, and child manipulation inside the dive still works', () => {
    const group = makeGroup();
    const leftArm = partByLabel('left_arm');

    // Dive in (dblclick on a child): selects NOTHING, group entered — the deliberate
    // state the repair must keep leaving alone (it early-returns with no selection).
    let p = clientPointOnPart('left_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBeNull();
    repaint();
    expect(count('.dimmed'), 'the dive context survives renders (nothing selected)').toBeGreaterThan(0);

    // Single click inside the dive selects the child directly (the DESIGNED place for
    // child selection), and a second click toggles the CHILD's handle set.
    p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'click inside the entered group selects the child').toBe(leftArm.id);
    expect(count('.dimmed'), 'the entry survives while a CHILD is selected (strict ancestor)').toBeGreaterThan(0);
    p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(leftArm.id);
    expect(overlayCount('.rotate-handle'), 'second click toggles the child\'s own rotate set').toBe(4);

    // Escape ladder back out: deselect, pop the group; a fresh click substitutes again.
    pressKey('Escape');
    expect(state.selectedPartId).toBeNull();
    pressKey('Escape');
    p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'after popping, clicks substitute up to the group again').toBe(group.id);
  });

  it('Layers child pick (context-aware movement) still manipulates the child directly on canvas', () => {
    const group = makeGroup();
    const leftArm = partByLabel('left_arm');
    // The Layers row driver on the CHILD: selection + entered group context.
    selectPart(leftArm.id);
    enterGroupsFor(leftArm.id);
    notify();
    repaint();
    // A canvas click on the already-selected child keeps IT selected (never hijacked
    // back to the group) — the context-aware movement rule, unchanged by the fix.
    const p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(leftArm.id);
    expect(state.selectedPartId).not.toBe(group.id);
    void group;
  });
});
