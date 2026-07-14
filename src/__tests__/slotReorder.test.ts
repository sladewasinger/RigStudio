/**
 * U4 (unified child ordering — the user-visible layer): `core/slotReorder.ts`'s
 * `moveChildSlot` and the slot-aware `moveSelectedInDrawOrder` stepping built on it.
 *
 * The fixture mirrors the shape that motivated U4 (PIP_MASTER's `body`): a container
 * with own paths AND a child part, INTERLEAVED — childOrder [path a, part kid, path b]
 * — so every cross-kind case is reachable: a path slot crossing a part slot, a part
 * slot crossing path slots, and the authority mirrors (paths[] order, doc.parts sibling
 * blocks) that each implies. Every mutation asserts the three standing invariants:
 * isChildOrderCoherent, childOrderAgreesWithCanonicalPartOrder (rule 4), and
 * isCanonicalPartOrder.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  childOrderAgreesWithCanonicalPartOrder, isCanonicalPartOrder, isChildOrderCoherent,
  moveChildSlot, moveSelectedInDrawOrder, canMoveSelectedInDrawOrder, selectPart, state,
} from '../core/model';
import { makeDoc, makePart, makePath, resetState } from './helpers';

/** container(paths a,b + child kid, slots [a, kid, b]) with kid carrying its own
 *  grandchild (so part moves must carry whole subtree blocks), plus a root sibling. */
function interleavedDoc() {
  const container = makePart('container', {
    paths: [makePath('a'), makePath('b')],
    childOrder: [
      { kind: 'path', id: 'a' }, { kind: 'part', id: 'kid' }, { kind: 'path', id: 'b' },
    ],
  });
  const kid = makePart('kid', {
    parentId: 'container', paths: [makePath('kp')],
    childOrder: [{ kind: 'path', id: 'kp' }, { kind: 'part', id: 'grand' }],
  });
  const grand = makePart('grand', { parentId: 'kid', childOrder: [] });
  const other = makePart('other', { childOrder: [] });
  return makeDoc([container, kid, grand, other]);
}

function slots(id: string): string[] {
  const part = state.doc!.parts.find((p) => p.id === id)!;
  return part.childOrder!.map((s) => s.id);
}
function assertInvariants(): void {
  expect(isChildOrderCoherent(state.doc!)).toBe(true);
  expect(childOrderAgreesWithCanonicalPartOrder(state.doc!)).toBe(true);
  expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
}

beforeEach(() => {
  resetState(interleavedDoc());
});

describe('moveChildSlot', () => {
  it('moves a PATH slot across a PART slot (paths[] relative order unchanged)', () => {
    const container = state.doc!.parts[0];
    // [a, kid, b] → move a above kid: post-removal list [kid, b], target index 1 → [kid, a, b]
    expect(moveChildSlot(container, 'a', 1)).toBe(true);
    expect(slots('container')).toEqual(['kid', 'a', 'b']);
    expect(container.paths.map((p) => p.id)).toEqual(['a', 'b']); // path-vs-path untouched
    assertInvariants();
  });

  it('moves a PATH slot past another PATH (paths[] mirrors the new relative order)', () => {
    const container = state.doc!.parts[0];
    // [a, kid, b] → move a to the very top: [kid, b, a]
    expect(moveChildSlot(container, 'a', 2)).toBe(true);
    expect(slots('container')).toEqual(['kid', 'b', 'a']);
    expect(container.paths.map((p) => p.id)).toEqual(['b', 'a']); // authority mirrored
    assertInvariants();
  });

  it('moves a PART slot between PATH slots and re-splices the whole subtree block', () => {
    const container = state.doc!.parts[0];
    // [a, kid, b] → kid topmost: [a, b, kid]
    expect(moveChildSlot(container, 'kid', 2)).toBe(true);
    expect(slots('container')).toEqual(['a', 'b', 'kid']);
    // doc.parts stays canonical with kid's grandchild riding along contiguously.
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['container', 'kid', 'grand', 'other']);
    assertInvariants();
  });

  it('reorders two child PARTS through slot space (doc.parts sibling blocks swap)', () => {
    // Give container a second child so a part-vs-part slot move exists.
    const container = state.doc!.parts[0];
    const kid2 = makePart('kid2', { parentId: 'container', childOrder: [] });
    state.doc!.parts.splice(3, 0, kid2); // canonical: after kid's subtree, before `other`
    container.childOrder!.push({ kind: 'part', id: 'kid2' });
    assertInvariants(); // fixture sanity

    // [a, kid, b, kid2] → kid2 to the bottom: [kid2, a, kid, b]
    expect(moveChildSlot(container, 'kid2', 0)).toBe(true);
    expect(slots('container')).toEqual(['kid2', 'a', 'kid', 'b']);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(
      ['container', 'kid2', 'kid', 'grand', 'other'],
    );
    assertInvariants();
  });

  it('returns false with zero mutation for a no-op / unknown slot / clamped-to-same', () => {
    const container = state.doc!.parts[0];
    const before = JSON.stringify(state.doc);
    expect(moveChildSlot(container, 'a', 0)).toBe(false); // already there
    expect(moveChildSlot(container, 'ghost', 2)).toBe(false); // no such slot
    expect(moveChildSlot(container, 'b', 99)).toBe(false); // clamps to 2 = its own index
    expect(JSON.stringify(state.doc)).toBe(before);
  });

  it('materializes a LAZY (absent) childOrder from the synthesized order, then moves', () => {
    const container = state.doc!.parts[0];
    delete container.childOrder;
    // Synthesized order is paths-first: [a, b, kid] — move kid to the bottom.
    expect(moveChildSlot(container, 'kid', 0)).toBe(true);
    expect(slots('container')).toEqual(['kid', 'a', 'b']);
    assertInvariants();
  });
});

describe('moveSelectedInDrawOrder — slot-aware stepping (PageUp/PageDown, stacking arrows)', () => {
  it('steps an entered PATH across the interleaved PART slot, one row per step', () => {
    selectPart('container');
    state.selectedPathId = 'b';
    // [a, kid, b]: b down one row → [a, b, kid]
    expect(canMoveSelectedInDrawOrder(-1)).toBe(true);
    expect(moveSelectedInDrawOrder(-1)).toBe(true);
    expect(slots('container')).toEqual(['a', 'b', 'kid']);
    // and again → [b, a, kid] (now crossing the other path — paths[] mirrors)
    expect(moveSelectedInDrawOrder(-1)).toBe(true);
    expect(slots('container')).toEqual(['b', 'a', 'kid']);
    expect(state.doc!.parts[0].paths.map((p) => p.id)).toEqual(['b', 'a']);
    expect(canMoveSelectedInDrawOrder(-1)).toBe(false); // bottom of the slot list
    assertInvariants();
  });

  it('steps a parented PART across PATH slots of its parent', () => {
    selectPart('kid');
    // [a, kid, b]: kid up one → [a, b, kid]
    expect(moveSelectedInDrawOrder(1)).toBe(true);
    expect(slots('container')).toEqual(['a', 'b', 'kid']);
    expect(canMoveSelectedInDrawOrder(1)).toBe(false); // topmost slot
    // back down TWO steps to the very bottom
    expect(moveSelectedInDrawOrder(-1)).toBe(true);
    expect(moveSelectedInDrawOrder(-1)).toBe(true);
    expect(slots('container')).toEqual(['kid', 'a', 'b']);
    expect(canMoveSelectedInDrawOrder(-1)).toBe(false);
    assertInvariants();
  });

  it('ROOT parts keep the sibling-block swap (no containing slot list)', () => {
    selectPart('container');
    expect(moveSelectedInDrawOrder(1)).toBe(true); // container's whole block past `other`
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['other', 'container', 'kid', 'grand']);
    expect(canMoveSelectedInDrawOrder(1)).toBe(false);
    assertInvariants();
  });
});
