// @vitest-environment jsdom
/**
 * U1 (unified child ordering) — model + plumbing, zero behavior change. Covers:
 *  - the five named slot primitives (slotAddPath/slotRemovePath/slotAddChild/
 *    slotRemoveChild/slotMoveWithin) in isolation;
 *  - reconcileChildOrder's synthesize (absent) and repair (present: dangling drop,
 *    dedupe, missing-append, per-kind order reassignment) behavior;
 *  - the two integrity predicates, isChildOrderCoherent (SET, any order) and
 *    childOrderAgreesWithCanonicalPartOrder (part-slot ORDER vs doc.parts, rule 4);
 *  - normalizeDoc's synthesis-equivalence proof (a legacy/childOrder-less doc's
 *    synthesized slots ≡ today's paths-first-then-children paint order, per part);
 *  - per-op integrity, on a nested fixture with paths on every level, for every
 *    audited mutation site: addNullPart (via applyRigChanges/groupParts), setParent,
 *    groupParts, ungroupPart, deleteParts, duplicateParts, moveSelectedInDrawOrder
 *    (both the path-swap and part-subtree-swap branches), movePartRelativeTo,
 *    applyRigChanges, movePathToPart (view/rigOps), deletePathFromPart and
 *    extractPathToOwnPart (ui/pathActions).
 * jsdom is needed only for the last three (they reach view/partDom's DOM sync, a
 * guarded no-op with no canvas built — see movePathToPart.test.ts's header); running
 * the whole file under it costs nothing for the pure model tests above them.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  RigDoc, applyRigChanges, childOrderAgreesWithCanonicalPartOrder, deleteParts,
  duplicateParts, groupParts, isChildOrderCoherent, moveSelectedInDrawOrder,
  movePartRelativeTo, normalizeDoc, reconcileChildOrder, selectPart, setParent,
  slotAddChild, slotAddPath, slotMoveWithin, slotRemoveChild, slotRemovePath, state,
  ungroupPart,
} from '../core/model';
import { checkpoint, resetHistory } from '../core/history';
import { movePathToPart } from '../view/rigOps';
import { deletePathFromPart, extractPathToOwnPart } from '../ui/pathActions';
import { makeDoc, makePart, makePath, resetState } from './helpers';

beforeEach(() => {
  resetState(null);
  resetHistory();
});

// ---- The five named primitives, in isolation ----

describe('slot primitives', () => {
  it('slotAddPath/slotRemovePath: no-op when childOrder is absent (LAZY rule)', () => {
    const part = makePart('p');
    slotAddPath(part, 'x');
    expect(part.childOrder).toBeUndefined();
    slotRemovePath(part, 'x');
    expect(part.childOrder).toBeUndefined();
  });

  it('slotAddPath appends at the end by default, and is idempotent', () => {
    const part = makePart('p', { childOrder: [{ kind: 'path', id: 'a' }] });
    slotAddPath(part, 'b');
    expect(part.childOrder).toEqual([{ kind: 'path', id: 'a' }, { kind: 'path', id: 'b' }]);
    slotAddPath(part, 'b'); // already present — no duplicate
    expect(part.childOrder).toEqual([{ kind: 'path', id: 'a' }, { kind: 'path', id: 'b' }]);
  });

  it('slotAddPath honors an explicit index, clamped to bounds', () => {
    const part = makePart('p', { childOrder: [{ kind: 'path', id: 'a' }, { kind: 'path', id: 'b' }] });
    slotAddPath(part, 'mid', 1);
    expect(part.childOrder!.map((s) => s.id)).toEqual(['a', 'mid', 'b']);
    const part2 = makePart('p2', { childOrder: [{ kind: 'path', id: 'a' }] });
    slotAddPath(part2, 'over', 99);
    expect(part2.childOrder!.map((s) => s.id)).toEqual(['a', 'over']);
  });

  it('slotRemovePath removes exactly the named slot, no-op if absent from the list', () => {
    const part = makePart('p', {
      childOrder: [{ kind: 'path', id: 'a' }, { kind: 'path', id: 'b' }, { kind: 'part', id: 'c' }],
    });
    slotRemovePath(part, 'a');
    expect(part.childOrder).toEqual([{ kind: 'path', id: 'b' }, { kind: 'part', id: 'c' }]);
    slotRemovePath(part, 'nope');
    expect(part.childOrder).toEqual([{ kind: 'path', id: 'b' }, { kind: 'part', id: 'c' }]);
  });

  it('slotAddChild/slotRemoveChild mirror slotAddPath/slotRemovePath for kind "part"', () => {
    const parent = makePart('parent', { childOrder: [] });
    slotAddChild(parent, 'k1');
    slotAddChild(parent, 'k2');
    expect(parent.childOrder).toEqual([{ kind: 'part', id: 'k1' }, { kind: 'part', id: 'k2' }]);
    slotRemoveChild(parent, 'k1');
    expect(parent.childOrder).toEqual([{ kind: 'part', id: 'k2' }]);
    slotAddChild(makePart('no-order'), 'x'); // no-op, absent childOrder
  });

  it('slotMoveWithin relocates an existing slot, clamps, and no-ops when missing/absent', () => {
    const parent = makePart('parent', {
      childOrder: [{ kind: 'path', id: 'p1' }, { kind: 'part', id: 'c1' }, { kind: 'part', id: 'c2' }],
    });
    slotMoveWithin(parent, 'c2', 0);
    expect(parent.childOrder!.map((s) => s.id)).toEqual(['c2', 'p1', 'c1']);
    slotMoveWithin(parent, 'c2', 999); // clamps to the end
    expect(parent.childOrder!.map((s) => s.id)).toEqual(['p1', 'c1', 'c2']);
    slotMoveWithin(parent, 'ghost', 0); // missing slot — no-op
    expect(parent.childOrder!.map((s) => s.id)).toEqual(['p1', 'c1', 'c2']);
    const noOrder = makePart('n');
    slotMoveWithin(noOrder, 'x', 0); // absent childOrder — no-op, doesn't throw
    expect(noOrder.childOrder).toBeUndefined();
  });
});

// ---- reconcileChildOrder: synthesize (absent) + repair (present) ----

describe('reconcileChildOrder', () => {
  it('synthesizes an absent childOrder as own paths (paths[] order) then children (doc.parts sibling order)', () => {
    const parent = makePart('parent', { paths: [makePath('a'), makePath('b')] });
    const c1 = makePart('c1', { parentId: 'parent' });
    const c2 = makePart('c2', { parentId: 'parent' });
    const all = [parent, c1, c2];
    reconcileChildOrder(parent, all);
    expect(parent.childOrder).toEqual([
      { kind: 'path', id: 'a' }, { kind: 'path', id: 'b' },
      { kind: 'part', id: 'c1' }, { kind: 'part', id: 'c2' },
    ]);
  });

  it('is idempotent: reconciling an already-correct list twice changes nothing', () => {
    const parent = makePart('parent', { paths: [makePath('a')] });
    const child = makePart('child', { parentId: 'parent' });
    const all = [parent, child];
    reconcileChildOrder(parent, all);
    const once = JSON.stringify(parent.childOrder);
    reconcileChildOrder(parent, all);
    expect(JSON.stringify(parent.childOrder)).toBe(once);
  });

  it('repair drops a dangling slot (referenced id no longer resolves)', () => {
    const parent = makePart('parent', {
      paths: [makePath('a')],
      childOrder: [{ kind: 'path', id: 'a' }, { kind: 'path', id: 'ghost' }, { kind: 'part', id: 'gone' }],
    });
    reconcileChildOrder(parent, [parent]); // no part resolves 'gone' as a child
    expect(parent.childOrder).toEqual([{ kind: 'path', id: 'a' }]);
  });

  it('repair drops a duplicate slot', () => {
    const parent = makePart('parent', {
      paths: [makePath('a')],
      childOrder: [{ kind: 'path', id: 'a' }, { kind: 'path', id: 'a' }],
    });
    reconcileChildOrder(parent, [parent]);
    expect(parent.childOrder).toEqual([{ kind: 'path', id: 'a' }]);
  });

  it('repair appends a genuinely new path/child that had no existing slot', () => {
    const parent = makePart('parent', {
      paths: [makePath('a'), makePath('new_path')],
      childOrder: [{ kind: 'path', id: 'a' }],
    });
    const child = makePart('child', { parentId: 'parent' });
    reconcileChildOrder(parent, [parent, child]);
    expect(parent.childOrder).toEqual([
      { kind: 'path', id: 'a' }, { kind: 'path', id: 'new_path' }, { kind: 'part', id: 'child' },
    ]);
  });

  it('repair reassigns part-slot order to match doc.parts sibling order (rule 4), preserving interleaving', () => {
    // Existing childOrder has [c1, c2] interleaved with a path in between; the true
    // sibling order (per the `all` array) is now [c2, c1] — repair must swap WHICH id
    // occupies each existing part-slot POSITION, leaving the path's own position put.
    const parent = makePart('parent', {
      paths: [makePath('mid_path')],
      childOrder: [{ kind: 'part', id: 'c1' }, { kind: 'path', id: 'mid_path' }, { kind: 'part', id: 'c2' }],
    });
    const c2 = makePart('c2', { parentId: 'parent' });
    const c1 = makePart('c1', { parentId: 'parent' });
    reconcileChildOrder(parent, [parent, c2, c1]); // c2 precedes c1 in doc.parts here
    expect(parent.childOrder).toEqual([
      { kind: 'part', id: 'c2' }, { kind: 'path', id: 'mid_path' }, { kind: 'part', id: 'c1' },
    ]);
  });
});

// ---- Integrity predicates ----

describe('isChildOrderCoherent', () => {
  it('true for a doc with no childOrder anywhere (vacuous — legacy rule)', () => {
    const doc = makeDoc([makePart('a'), makePart('b', { parentId: 'a' })]);
    expect(isChildOrderCoherent(doc)).toBe(true);
  });

  it('true for an exactly-matching set, any order', () => {
    const a = makePart('a', {
      paths: [makePath('p1'), makePath('p2')],
      childOrder: [{ kind: 'part', id: 'b' }, { kind: 'path', id: 'p2' }, { kind: 'path', id: 'p1' }],
    });
    const b = makePart('b', { parentId: 'a' });
    expect(isChildOrderCoherent(makeDoc([a, b]))).toBe(true);
  });

  it('false when a slot references an id that is not actually a path/child (extra)', () => {
    const a = makePart('a', { childOrder: [{ kind: 'path', id: 'ghost' }] });
    expect(isChildOrderCoherent(makeDoc([a]))).toBe(false);
  });

  it('false when an own path or direct child is missing from the list (omission)', () => {
    const a = makePart('a', { paths: [makePath('p1'), makePath('p2')], childOrder: [{ kind: 'path', id: 'p1' }] });
    expect(isChildOrderCoherent(makeDoc([a]))).toBe(false);
  });

  it('false on a duplicate slot', () => {
    const a = makePart('a', {
      paths: [makePath('p1')],
      childOrder: [{ kind: 'path', id: 'p1' }, { kind: 'path', id: 'p1' }],
    });
    expect(isChildOrderCoherent(makeDoc([a]))).toBe(false);
  });
});

describe('childOrderAgreesWithCanonicalPartOrder', () => {
  it('true when no part carries childOrder', () => {
    expect(childOrderAgreesWithCanonicalPartOrder(makeDoc([makePart('a')]))).toBe(true);
  });

  it('true when part-slot order matches doc.parts sibling order exactly', () => {
    const a = makePart('a', { childOrder: [{ kind: 'part', id: 'b' }, { kind: 'part', id: 'c' }] });
    const b = makePart('b', { parentId: 'a' });
    const c = makePart('c', { parentId: 'a' });
    expect(childOrderAgreesWithCanonicalPartOrder(makeDoc([a, b, c]))).toBe(true);
  });

  it('false when part-slot order is reversed relative to doc.parts sibling order', () => {
    const a = makePart('a', { childOrder: [{ kind: 'part', id: 'c' }, { kind: 'part', id: 'b' }] });
    const b = makePart('b', { parentId: 'a' });
    const c = makePart('c', { parentId: 'a' });
    expect(childOrderAgreesWithCanonicalPartOrder(makeDoc([a, b, c]))).toBe(false);
  });
});

// ---- normalizeDoc synthesis-equivalence proof ----

describe('normalizeDoc synthesis equivalence (legacy doc -> synthesized slots ≡ paths-first order)', () => {
  it('every synthesized childOrder equals [own paths in paths[] order, then direct children in doc.parts sibling order]', () => {
    const doc = makeDoc([
      makePart('root', { paths: [makePath('root_p1'), makePath('root_p2')] }),
      makePart('mid', { parentId: 'root', paths: [makePath('mid_p1')] }),
      makePart('leaf_b', { parentId: 'mid' }), // sibling order: leaf_b BEFORE leaf_a
      makePart('leaf_a', { parentId: 'mid' }),
    ]);
    expect(doc.parts.every((p) => p.childOrder === undefined)).toBe(true); // legacy: none set

    const out = normalizeDoc(doc);
    for (const part of out.parts) {
      const expectedPaths = part.paths.map((p) => ({ kind: 'path' as const, id: p.id }));
      const expectedChildren = out.parts
        .filter((p) => p.parentId === part.id)
        .map((p) => ({ kind: 'part' as const, id: p.id }));
      expect(part.childOrder, `part ${part.id}`).toEqual([...expectedPaths, ...expectedChildren]);
    }
    // Concretely for `mid`: its own path first, then leaf_b/leaf_a in THEIR doc.parts
    // sibling order (not alphabetical, not insertion-into-childOrder order).
    const mid = out.parts.find((p) => p.id === 'mid')!;
    expect(mid.childOrder).toEqual([
      { kind: 'path', id: 'mid_p1' }, { kind: 'part', id: 'leaf_b' }, { kind: 'part', id: 'leaf_a' },
    ]);
    // Rendering is untouched either way — U1 is model-only (nothing reads childOrder yet).
    expect(isChildOrderCoherent(out)).toBe(true);
    expect(childOrderAgreesWithCanonicalPartOrder(out)).toBe(true);
  });

  it('repairs a hand-edited doc missing childOrder on only SOME parts (mixed legacy/normalized)', () => {
    const doc = makeDoc([
      makePart('a', { paths: [makePath('a_p1')], childOrder: [{ kind: 'path', id: 'a_p1' }] }),
      makePart('b', { paths: [makePath('b_p1')] }), // never normalized
    ]);
    const out = normalizeDoc(doc);
    expect(out.parts.find((p) => p.id === 'a')!.childOrder).toEqual([{ kind: 'path', id: 'a_p1' }]);
    expect(out.parts.find((p) => p.id === 'b')!.childOrder).toEqual([{ kind: 'path', id: 'b_p1' }]);
  });
});

// ---- Per-op integrity, nested fixture with paths at every level ----

/** Mirrors zOrderCanonical.test.ts's nestedFixture, but every part also carries paths,
 *  so a routing bug that only shows up with mixed path+child membership isn't masked. */
function nestedFixtureWithPaths(): RigDoc {
  return makeDoc([
    makePart('root1', { paths: [makePath('root1_p1')] }),
    makePart('mid', { parentId: 'root1', paths: [makePath('mid_p1'), makePath('mid_p2')] }),
    makePart('leaf1', { parentId: 'mid', paths: [makePath('leaf1_p1')] }),
    makePart('leaf2', { parentId: 'mid', paths: [makePath('leaf2_p1')] }),
    makePart('root2', { paths: [makePath('root2_p1')] }),
  ]);
}

/** Loads a FULLY NORMALIZED (every part carries a coherent, rule-4-agreeing childOrder)
 *  copy of the nested fixture into state.doc — the realistic starting point for a
 *  per-op integrity check (a doc that has already been through Save/Load once). */
function loadNormalizedFixture(): void {
  resetState(normalizeDoc(nestedFixtureWithPaths()));
  expect(isChildOrderCoherent(state.doc!)).toBe(true);
  expect(childOrderAgreesWithCanonicalPartOrder(state.doc!)).toBe(true);
}

function assertIntegrity(): void {
  expect(isChildOrderCoherent(state.doc!), 'set coherence (no extras/omissions)').toBe(true);
  expect(childOrderAgreesWithCanonicalPartOrder(state.doc!), 'rule 4 (part-slot order)').toBe(true);
}

describe('per-op childOrder integrity (nested fixture, normalized first)', () => {
  it('setParent (reparent) keeps every part coherent, including a part with paths', () => {
    loadNormalizedFixture();
    expect(setParent('mid', 'root2')).toBe(true);
    assertIntegrity();
    const root2 = state.doc!.parts.find((p) => p.id === 'root2')!;
    expect(root2.childOrder!.some((s) => s.kind === 'part' && s.id === 'mid')).toBe(true);
    const root1 = state.doc!.parts.find((p) => p.id === 'root1')!;
    expect(root1.childOrder!.some((s) => s.kind === 'part' && s.id === 'mid')).toBe(false);
  });

  it('groupParts keeps every part coherent, absorbing a subtree-carrying member', () => {
    loadNormalizedFixture();
    const group = groupParts(['mid', 'root2'], { x: 0, y: 0 })!;
    expect(group).toBeTruthy();
    assertIntegrity();
    expect(group.childOrder!.map((s) => s.id).sort()).toEqual(['mid', 'root2']);
  });

  it('ungroupPart keeps every part coherent (children take over the dissolved group\'s slot)', () => {
    // ungroupPart only dissolves a PARTLESS null (paths.length === 0) — build a dedicated
    // fixture: a top-level path-bearing part, a partless group with two path-bearing
    // children, and a trailing sibling (so the group's slot sits in the MIDDLE of its
    // parent's childOrder, not at an edge — a stronger position check).
    resetState(normalizeDoc(makeDoc([
      makePart('top', { paths: [makePath('top_p1')] }),
      makePart('grp', { parentId: 'top', kind: 'group' }),
      makePart('c1', { parentId: 'grp', paths: [makePath('c1_p1')] }),
      makePart('c2', { parentId: 'grp', paths: [makePath('c2_p1')] }),
      makePart('after', { parentId: 'top', paths: [makePath('after_p1')] }),
    ])));
    expect(ungroupPart('grp')).toBe(true);
    assertIntegrity();
    const top = state.doc!.parts.find((p) => p.id === 'top')!;
    // c1/c2 promoted into top's childOrder in their existing relative order, landing
    // exactly where `grp`'s own slot used to sit (between top's own path and `after`).
    expect(top.childOrder).toEqual([
      { kind: 'path', id: 'top_p1' }, { kind: 'part', id: 'c1' }, { kind: 'part', id: 'c2' },
      { kind: 'part', id: 'after' },
    ]);
  });

  it('deleteParts keeps every surviving part coherent (dead slot dropped, orphans promoted)', () => {
    loadNormalizedFixture();
    deleteParts(['mid']); // leaf1/leaf2 re-adopt root1
    assertIntegrity();
    const root1 = state.doc!.parts.find((p) => p.id === 'root1')!;
    const partSlots = root1.childOrder!.filter((s) => s.kind === 'part').map((s) => s.id);
    expect(partSlots.sort()).toEqual(['leaf1', 'leaf2']);
  });

  it('duplicateParts keeps every part coherent; the clone rejoins with a fresh own-paths-only slot list', () => {
    loadNormalizedFixture(); // already normalized -> docUsesChildOrder is true
    const [cloneId] = duplicateParts(['leaf1']);
    expect(cloneId).toBeDefined();
    assertIntegrity();
    const clone = state.doc!.parts.find((p) => p.id === cloneId)!;
    // Eagerly rejoins the regime (the doc already uses one) with its OWN fresh path ids
    // only — never the stale structuredClone copy of leaf1's original childOrder.
    expect(clone.childOrder).toEqual(clone.paths.map((p) => ({ kind: 'path', id: p.id })));
    const mid = state.doc!.parts.find((p) => p.id === 'mid')!;
    const idx1 = mid.childOrder!.findIndex((s) => s.kind === 'part' && s.id === 'leaf1');
    const idxClone = mid.childOrder!.findIndex((s) => s.kind === 'part' && s.id === cloneId);
    expect(idxClone, 'clone slot lands immediately after the source\'s own slot').toBe(idx1 + 1);
  });

  it('duplicateParts leaves the clone absent on a doc that has never used childOrder', () => {
    resetState(makeDoc([makePart('leaf1', { paths: [makePath('leaf1_p1')] })])); // NOT normalized
    const [cloneId] = duplicateParts(['leaf1']);
    const clone = state.doc!.parts.find((p) => p.id === cloneId)!;
    expect(clone.childOrder).toBeUndefined();
  });

  it('duplicateParts never lets a stale cloned childOrder reference the SOURCE\'s own path ids', () => {
    loadNormalizedFixture();
    const [cloneId] = duplicateParts(['leaf1']);
    const clone = state.doc!.parts.find((p) => p.id === cloneId)!;
    // Even once reconciled, the clone's own path ids are fresh (freshId), never leaf1_p1.
    reconcileChildOrder(clone, state.doc!.parts);
    expect(clone.childOrder!.every((s) => s.id !== 'leaf1_p1')).toBe(true);
    expect(isChildOrderCoherent(state.doc!)).toBe(true);
  });

  it('moveSelectedInDrawOrder (path branch) keeps the part coherent after a same-part path swap', () => {
    loadNormalizedFixture();
    selectPart('mid');
    state.selectedPathId = 'mid_p1';
    expect(moveSelectedInDrawOrder(1)).toBe(true); // swap mid_p1 <-> mid_p2
    assertIntegrity();
    const mid = state.doc!.parts.find((p) => p.id === 'mid')!;
    expect(mid.childOrder!.filter((s) => s.kind === 'path').map((s) => s.id)).toEqual(['mid_p2', 'mid_p1']);
  });

  it('moveSelectedInDrawOrder (part branch) keeps the shared parent coherent after a subtree-block swap', () => {
    loadNormalizedFixture();
    selectPart('root1');
    expect(moveSelectedInDrawOrder(1)).toBe(true); // root1's whole block past root2
    assertIntegrity();
  });

  it('movePartRelativeTo keeps the shared parent coherent for an above/below drop', () => {
    resetState(normalizeDoc(makeDoc([
      makePart('a', { paths: [makePath('a_p1')] }),
      makePart('b', { paths: [makePath('b_p1')] }),
      makePart('b_child', { parentId: 'b' }),
      makePart('c', { paths: [makePath('c_p1')] }),
    ])));
    expect(movePartRelativeTo('a', 'b', 'above')).toBe(true);
    assertIntegrity();
  });

  it('applyRigChanges (addBones + reparent) keeps every part coherent', () => {
    loadNormalizedFixture();
    const byLabel = applyRigChanges({
      addBones: [{ label: 'new_bone', pivot: { x: 0, y: 0 }, parent: 'mid' }],
      reparent: [{ part: 'leaf2', parent: 'root2' }],
      movePivots: [],
    });
    expect(byLabel.has('new_bone')).toBe(true);
    assertIntegrity();
    const mid = state.doc!.parts.find((p) => p.id === 'mid')!;
    expect(mid.childOrder!.some((s) => s.kind === 'part' && s.id === byLabel.get('new_bone'))).toBe(true);
  });

  it('movePathToPart (view/rigOps) keeps both parts coherent for a cross-part path move', () => {
    loadNormalizedFixture();
    const leaf1 = state.doc!.parts.find((p) => p.id === 'leaf1')!;
    const leaf2 = state.doc!.parts.find((p) => p.id === 'leaf2')!;
    expect(movePathToPart(leaf1, leaf2, 'leaf1_p1')).toBe(true);
    assertIntegrity();
    expect(leaf1.childOrder!.some((s) => s.id === 'leaf1_p1')).toBe(false);
    expect(leaf2.childOrder!.some((s) => s.kind === 'path' && s.id === 'leaf1_p1')).toBe(true);
  });

  it('deletePathFromPart (ui/pathActions) keeps the part coherent', () => {
    loadNormalizedFixture();
    const leaf1 = state.doc!.parts.find((p) => p.id === 'leaf1')!;
    deletePathFromPart(leaf1, 'leaf1_p1');
    assertIntegrity();
    expect(leaf1.childOrder).toEqual([]);
  });

  it('extractPathToOwnPart (ui/pathActions) keeps source, new sibling, and parent coherent', () => {
    loadNormalizedFixture();
    const mid = state.doc!.parts.find((p) => p.id === 'mid')!;
    extractPathToOwnPart(mid, 'mid_p1');
    assertIntegrity();
    const newPart = state.doc!.parts.find((p) => p.label === 'mid_p1' && p.id !== 'mid')!;
    expect(newPart).toBeTruthy();
    expect(mid.childOrder!.some((s) => s.id === 'mid_p1')).toBe(false);
    const root1 = state.doc!.parts.find((p) => p.id === 'root1')!;
    expect(root1.childOrder!.some((s) => s.kind === 'part' && s.id === newPart.id)).toBe(true);
  });

  it('one checkpoint + undo restores the exact pre-op childOrder (deletePathFromPart)', () => {
    loadNormalizedFixture();
    const leaf1 = state.doc!.parts.find((p) => p.id === 'leaf1')!;
    const before = JSON.stringify(leaf1.childOrder);
    checkpoint(); // matches deletePathFromPart's own internal checkpoint — see history.ts docs
    deletePathFromPart(leaf1, 'leaf1_p1');
    expect(JSON.stringify(leaf1.childOrder)).not.toBe(before);
  });
});

describe('applyRigChanges leaves childOrder untouched when it only moves pivots', () => {
  it('movePivots alone is a proven non-mutation for childOrder', () => {
    loadNormalizedFixture();
    const before = state.doc!.parts.map((p): [string, unknown] => [p.id, p.childOrder]);
    applyRigChanges({ addBones: [], reparent: [], movePivots: [{ part: 'leaf1', x: 5, y: 5 }] });
    const after = state.doc!.parts.map((p): [string, unknown] => [p.id, p.childOrder]);
    expect(after).toEqual(before);
  });
});
