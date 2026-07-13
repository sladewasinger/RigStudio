/**
 * Interaction tests for "Ctrl+G leaves the canvas dimmed" (ROADMAP.md live bug queue,
 * user-reported 2026-07-12: "pip semi-transparent until refresh"). Root cause:
 * `ctx.enteredGroups` (view/context.ts) is view-layer editing-SESSION state that
 * survives structural mutations untouched — none of group/ungroup/delete/reparent know
 * it exists. `focusContext()` (view/focus.ts) dims everything outside the entered
 * subtree; once a structural op leaves an entered id stale relative to the doc or the
 * current selection, the dim never clears until a full reload resets app state.
 *
 * Fix: `repairEnteredGroups()`, run as the first thing `focusContext()` does on every
 * call — a self-healing chokepoint, not a fix bolted onto each structural-op call site.
 * It drops entered ids whose part no longer exists, and (only when something IS
 * selected, so the deliberate dive-in/select-nothing state is never disturbed) drops
 * entered ids that are not an ancestor of any selected part.
 *
 * Both scenarios below are written to FAIL against the pre-fix behavior (reproduction),
 * then pass once `repairEnteredGroups` is wired in — see the task report for the manual
 * mutation-check (temporarily removing the `repairEnteredGroups()` call re-fails both).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { groupAction } from '../../panels';
import { deleteSelectedParts } from '../../ui/actions';
import { enterGroupsFor } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, click, fullDblClick,
  count, selectByLabel,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Build a fresh group G = {left_arm, right_arm} and dive INTO it (dblclick on
 *  right_arm), landing exactly on the "entered, nothing selected" dive-in state. */
function makeGroupAndDiveIn() {
  let p = clientPointOnPart('left_arm');
  click(p.x, p.y);
  p = clientPointOnPart('right_arm');
  click(p.x, p.y, { shiftKey: true });
  groupAction();
  const g = state.doc!.parts.find((pt) => pt.kind === 'group')!;
  expect(g, 'groupAction produced a group').toBeTruthy();

  p = clientPointOnPart('right_arm');
  click(p.x, p.y);
  expect(state.selectedPartId).toBe(g.id);
  p = clientPointOnPart('right_arm');
  fullDblClick(p.x, p.y);
  expect(state.selectedPartId, 'dblclick dives in, selecting nothing').toBeNull();

  return g;
}

describe('scenario EG1 — Ctrl+G on a selection OUTSIDE an entered group no longer strands dimming', () => {
  it('reproduces the stuck dim, then confirms it clears: grouping shadow while still "inside" the earlier group', () => {
    const g = makeGroupAndDiveIn();

    // Sanity: right now we ARE legitimately inside g with nothing selected — that state
    // dims everything outside g (a real, intentional editing-context narrowing), not a
    // bug on its own.
    expect(count('.dimmed'), 'entering a group legitimately dims everything outside it').toBeGreaterThan(0);

    // A Layers-panel pick of a part OUTSIDE g: selectPart + enterGroupsFor, exactly what
    // a real Layers row click drives (layers.ts). shadow has no group ancestors of its
    // own, so enterGroupsFor adds nothing new — ctx.enteredGroups still holds the now-
    // irrelevant `g`.
    const shadow = partByLabel('shadow');
    selectByLabel('shadow');
    enterGroupsFor(shadow.id);
    expect(state.selectedPartId).toBe(shadow.id);

    // Ctrl+G wraps the (single-part) selection into a NEW group, OUTSIDE g's subtree.
    groupAction();
    const newGroup = state.doc!.parts.find((pt) => pt.kind === 'group' && pt.id !== g.id);
    expect(newGroup, 'a second group was created from the outside selection').toBeTruthy();
    expect(state.selectedPartId).toBe(newGroup!.id);

    // THE BUG, fixed: nothing should stay dimmed — the new selection (and everything
    // else) has moved entirely outside the stale-entered `g`, so `g`'s entry must have
    // been repaired away. Before the fix this assertion fails (most of doc.parts still
    // dimmed, since ctx.enteredGroups still == {g} and neither newGroup nor shadow nor
    // any of the other top-level parts descend from it).
    expect(count('.dimmed'), 'no stale dimming survives the group op').toBe(0);
  });
});

describe('scenario EG2 — deleting the entered group itself prunes it (existence-based repair)', () => {
  it('Delete on the entered group, via the real Delete-key gesture, clears the stuck dim', () => {
    const g = makeGroupAndDiveIn();
    expect(count('.dimmed')).toBeGreaterThan(0);

    // Select the entered group itself (e.g. via Layers) and delete it — its two
    // children re-adopt root per deleteParts' normal rules.
    selectByLabel(g.label);
    expect(state.selectedPartId).toBe(g.id);
    deleteSelectedParts();

    expect(state.doc!.parts.some((p) => p.id === g.id), 'the group is gone').toBe(false);
    // THE BUG, fixed: ctx.enteredGroups still held g's id after the delete (nobody
    // told it to forget); focusContext's descendant-of-nothing-that-exists loop then
    // dims every surviving part. Before the fix this assertion fails.
    expect(count('.dimmed'), 'deleting the entered group must not strand the dim').toBe(0);
  });
});

describe('scenario EG3 — grouping members that stay INSIDE the entered group keeps the dive intact', () => {
  it('is the least-surprising counter-case: entry is naturally preserved, nothing dims that should stay visible', () => {
    // A DIFFERENT dive: enter a group and then Ctrl+G two of ITS OWN (still-open)
    // members — the resulting nested group sits inside the entered one, so its entry
    // must NOT be pruned (this is the "grouping while inside a group keeps you inside
    // the enclosing group" case, here with the enclosing group being the entered one
    // itself since the new group nests directly under it).
    const g = makeGroupAndDiveIn();

    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(state.selectedPartId, 'left_arm is directly selectable now that g is entered').toBe(partByLabel('left_arm').id);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    groupAction();

    const nested = state.doc!.parts.find((pt) => pt.kind === 'group' && pt.id !== g.id);
    expect(nested, 'a nested group was created inside g').toBeTruthy();
    expect(nested!.parentId).toBe(g.id);
    expect(state.selectedPartId).toBe(nested!.id);

    // Nothing should be dimmed that belongs to g's subtree — the entered context
    // survived because the new group nests inside it (still an ancestor of the
    // selection), unlike EG1's outside-selection case.
    expect(document.querySelector(`[data-part-id="${nested!.id}"]`)?.classList.contains('dimmed'), 'the new nested group is not dimmed').toBe(false);
    expect(document.querySelector(`[data-part-id="${partByLabel('left_arm').id}"]`)?.classList.contains('dimmed'), 'left_arm (inside g) is not dimmed').toBe(false);
  });
});
