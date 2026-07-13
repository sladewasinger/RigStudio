/**
 * Tests for "Layer order IS z-order" (ROADMAP.md / CLAUDE.md): doc.parts must always be
 * in CANONICAL paint order — every part's own array index precedes its whole, contiguous
 * descendant block — so the layers panel's nested (depth-first) display really is a direct
 * read of the paint order, and reordering a subtree in the panel moves its whole paint
 * block. Covers the pure checker/canonicalizer (structuralOps.ts), normalizeDoc's legacy
 * repair, per-op preservation across every structural mutation that could break the
 * invariant, and the acceptance scenario (reorder in the panel → both exporters follow;
 * keyed z re-sorts the canvas only).
 */

import { describe, expect, it } from 'vitest';
import {
  RigDoc, canonicalizePartOrder, channelValue, deleteParts, drawOrder,
  duplicateParts, groupParts, isCanonicalPartOrder, movePartRelativeTo,
  moveSelectedInDrawOrder, normalizeDoc, selectPart, setKeyframeAt, setParent, state,
  ungroupPart,
} from '../core/model';
import { exportLottie } from '../io/exportLottie';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP, TYPE } from './rivDecoder';
import { makeDoc, makePart, makePath, resetState } from './helpers';

// ---- isCanonicalPartOrder truth table ----

describe('isCanonicalPartOrder', () => {
  it('accepts a flat, all-root doc', () => {
    expect(isCanonicalPartOrder([makePart('a'), makePart('b'), makePart('c')])).toBe(true);
  });

  it('accepts a parent immediately followed by its contiguous descendant block', () => {
    const parts = [
      makePart('gp'),
      makePart('p', { parentId: 'gp' }),
      makePart('c1', { parentId: 'p' }),
      makePart('c2', { parentId: 'p' }),
      makePart('sibling'), // a second, unrelated root after the whole gp block
    ];
    expect(isCanonicalPartOrder(parts)).toBe(true);
  });

  it('rejects a child positioned BEFORE its parent', () => {
    const parts = [makePart('c', { parentId: 'p' }), makePart('p')];
    expect(isCanonicalPartOrder(parts)).toBe(false);
  });

  it('rejects a SPLIT block (foreign content interleaved inside a parent\'s span)', () => {
    // p's children are c1 and c2, but `other` (not p's descendant) sits between them.
    const parts = [
      makePart('p'),
      makePart('c1', { parentId: 'p' }),
      makePart('other'),
      makePart('c2', { parentId: 'p' }),
    ];
    expect(isCanonicalPartOrder(parts)).toBe(false);
  });

  it('rejects a parent separated from its child by an unrelated sibling', () => {
    const parts = [makePart('p'), makePart('other'), makePart('c', { parentId: 'p' })];
    expect(isCanonicalPartOrder(parts)).toBe(false);
  });

  it('treats a dangling parentId as a root (repaired separately by normalizeDoc)', () => {
    const parts = [makePart('a', { parentId: 'ghost' }), makePart('b')];
    expect(isCanonicalPartOrder(parts)).toBe(true);
  });

  it('reports false rather than looping forever on a hand-made parentId cycle', () => {
    const a = makePart('a', { parentId: 'b' });
    const b = makePart('b', { parentId: 'a' });
    expect(isCanonicalPartOrder([a, b])).toBe(false);
  });

  it('accepts the empty document', () => {
    expect(isCanonicalPartOrder([])).toBe(true);
  });
});

// ---- canonicalizePartOrder: stability + idempotence ----

describe('canonicalizePartOrder', () => {
  it('is a no-op (same order) on an already-canonical doc', () => {
    const parts = [
      makePart('gp'),
      makePart('p', { parentId: 'gp' }),
      makePart('c1', { parentId: 'p' }),
      makePart('c2', { parentId: 'p' }),
      makePart('root2'),
    ];
    expect(canonicalizePartOrder(parts).map((p) => p.id)).toEqual(parts.map((p) => p.id));
  });

  it('moves a child-before-parent part after its parent, preserving every other relation', () => {
    const parts = [makePart('c', { parentId: 'p' }), makePart('p'), makePart('z')];
    const out = canonicalizePartOrder(parts);
    expect(out.map((p) => p.id)).toEqual(['p', 'c', 'z']);
    expect(isCanonicalPartOrder(out)).toBe(true);
  });

  it('heals a split block by pulling every descendant contiguous with its parent', () => {
    const parts = [
      makePart('p'),
      makePart('c1', { parentId: 'p' }),
      makePart('other'),
      makePart('c2', { parentId: 'p' }),
    ];
    const out = canonicalizePartOrder(parts);
    // Stable: root order-of-appearance is [p, other]; p's children order-of-appearance is
    // [c1, c2] (both already correctly attributed to p via the parentId field, regardless
    // of `other` sitting between them in the input array).
    expect(out.map((p) => p.id)).toEqual(['p', 'c1', 'c2', 'other']);
    expect(isCanonicalPartOrder(out)).toBe(true);
  });

  it('is STABLE: preserves relative sibling order and each subtree\'s internal order', () => {
    const parts = [
      makePart('root2'),
      makePart('root1'),
      makePart('root1_c2', { parentId: 'root1' }),
      makePart('root1_c1', { parentId: 'root1' }),
    ];
    const out = canonicalizePartOrder(parts);
    // Roots keep their original relative order (root2 before root1); root1's own children
    // keep THEIR original relative order (root1_c2 before root1_c1) even though that's not
    // the order they'd be discovered walking root1 forward — it's array-order-of-mention.
    expect(out.map((p) => p.id)).toEqual(['root2', 'root1', 'root1_c2', 'root1_c1']);
  });

  it('is IDEMPOTENT: canonicalizing twice equals canonicalizing once', () => {
    const parts = [
      makePart('c2', { parentId: 'p' }),
      makePart('other'),
      makePart('c1', { parentId: 'p' }),
      makePart('p'),
    ];
    const once = canonicalizePartOrder(parts);
    const twice = canonicalizePartOrder(once);
    expect(twice.map((p) => p.id)).toEqual(once.map((p) => p.id));
  });

  it('never drops a part, even a pure parentId cycle unreachable from any root', () => {
    const a = makePart('a', { parentId: 'b' });
    const b = makePart('b', { parentId: 'a' });
    const out = canonicalizePartOrder([a, b, makePart('root')]);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(['a', 'b', 'root']));
  });

  it('treats a dangling parentId as a root without dropping the part', () => {
    const parts = [makePart('a', { parentId: 'ghost' }), makePart('b')];
    const out = canonicalizePartOrder(parts);
    expect(out.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(isCanonicalPartOrder(out)).toBe(true);
  });
});

// ---- normalizeDoc repairs a fabricated legacy doc ----

describe('normalizeDoc canonicalizes doc.parts (legacy-file repair)', () => {
  it('reorders a hand-edited, child-before-parent legacy doc into canonical order', () => {
    const doc = makeDoc([
      makePart('child', { parentId: 'parent' }),
      makePart('parent'),
      makePart('unrelated'),
    ]);
    expect(isCanonicalPartOrder(doc.parts)).toBe(false); // the fabricated legacy shape
    const out = normalizeDoc(doc);
    expect(isCanonicalPartOrder(out.parts)).toBe(true);
    expect(out.parts.map((p) => p.id)).toEqual(['parent', 'child', 'unrelated']);
    // No part data was altered by the repair, only array position.
    expect(out.parts.find((p) => p.id === 'child')!.parentId).toBe('parent');
  });

  it('is a no-op on an already-canonical doc (byte-stable field content)', () => {
    const doc = makeDoc([makePart('a'), makePart('b', { parentId: 'a' })]);
    const before = doc.parts.map((p) => p.id);
    const out = normalizeDoc(doc);
    expect(out.parts.map((p) => p.id)).toEqual(before);
  });
});

// ---- Per-op canonical-order preservation, on nested fixtures ----

/** A 3-level nested fixture: root1 → mid → leaf1, leaf2 (siblings under mid), plus a
 *  second unrelated root — big enough to expose a "split block" or "leaves children
 *  behind" bug that a flat 2-3 part fixture wouldn't. */
function nestedFixture(): RigDoc {
  return makeDoc([
    makePart('root1'),
    makePart('mid', { parentId: 'root1' }),
    makePart('leaf1', { parentId: 'mid' }),
    makePart('leaf2', { parentId: 'mid' }),
    makePart('root2'),
  ]);
}

describe('per-op canonical-order preservation (nested fixture)', () => {
  it('groupParts keeps the result canonical (grouping a subtree-carrying part)', () => {
    resetState(nestedFixture());
    const group = groupParts(['mid', 'root2'], { x: 0, y: 0 })!;
    expect(group).toBeTruthy();
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    // mid's own children (leaf1, leaf2) travel with it into the new group.
    const leaf1 = state.doc!.parts.find((p) => p.id === 'leaf1')!;
    expect(leaf1.parentId).toBe('mid');
  });

  it('ungroupPart keeps the result canonical', () => {
    resetState(nestedFixture());
    expect(ungroupPart('mid')).toBe(true);
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    // leaf1/leaf2 promoted to root1's direct children.
    expect(state.doc!.parts.find((p) => p.id === 'leaf1')!.parentId).toBe('root1');
  });

  it('duplicateParts keeps the result canonical when duplicating a part WITH children', () => {
    resetState(nestedFixture());
    const [cloneId] = duplicateParts(['mid']);
    expect(cloneId).toBeDefined();
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    // The clone is a sibling of `mid` (same parent), never spliced into mid's own block.
    const clone = state.doc!.parts.find((p) => p.id === cloneId)!;
    expect(clone.parentId).toBe('root1');
    const leaf1 = state.doc!.parts.find((p) => p.id === 'leaf1')!;
    expect(leaf1.parentId).toBe('mid'); // untouched — only `mid` itself was cloned
  });

  it('setParent (reparent) keeps the result canonical, including reparenting a part with children', () => {
    resetState(nestedFixture());
    expect(setParent('mid', 'root2')).toBe(true); // moves mid + its whole subtree
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    expect(state.doc!.parts.find((p) => p.id === 'leaf2')!.parentId).toBe('mid'); // untouched
  });

  it('deleteParts keeps the result canonical when deleting an interior node', () => {
    resetState(nestedFixture());
    deleteParts(['mid']); // leaf1/leaf2 re-adopt root1
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    expect(state.doc!.parts.find((p) => p.id === 'leaf1')!.parentId).toBe('root1');
  });

  it('moveSelectedInDrawOrder (PageUp) on a part WITH CHILDREN moves the whole subtree block', () => {
    resetState(nestedFixture());
    selectPart('root1'); // root1's whole subtree (root1, mid, leaf1, leaf2) vs root2
    expect(moveSelectedInDrawOrder(1)).toBe(true); // bring forward past root2
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    const ids = state.doc!.parts.map((p) => p.id);
    // root2 now sits BEFORE root1's whole (still-contiguous) block.
    expect(ids.indexOf('root2')).toBeLessThan(ids.indexOf('root1'));
    expect(ids.slice(ids.indexOf('root1'))).toEqual(['root1', 'mid', 'leaf1', 'leaf2']);
  });

  it('moveSelectedInDrawOrder is sibling-scoped: a leaf can\'t be paged past its parent\'s own siblings', () => {
    resetState(nestedFixture());
    selectPart('leaf1'); // leaf1's siblings are only [leaf1, leaf2] under `mid`
    selectPart('leaf2');
    // leaf2 is already the topmost sibling under mid — can't move further, even though
    // root2 (a totally different parent's territory) sits later in the flat array.
    expect(moveSelectedInDrawOrder(1)).toBe(false);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['root1', 'mid', 'leaf1', 'leaf2', 'root2']);
  });

  it('movePartRelativeTo moves a dragged part\'s whole subtree above/below a REF that itself has children', () => {
    resetState(makeDoc([
      makePart('a'),
      makePart('b'),
      makePart('b_child', { parentId: 'b' }),
      makePart('c'),
    ]));
    // Drop `a` (a leaf) ABOVE `b` (which has a child) — `a` must land entirely outside
    // b's block (after b's whole subtree, not spliced between b and b_child).
    expect(movePartRelativeTo('a', 'b', 'above')).toBe(true);
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    const ids = state.doc!.parts.map((p) => p.id);
    expect(ids).toEqual(['b', 'b_child', 'a', 'c']);
  });

  it('movePartRelativeTo moving a part WITH children takes the whole block along', () => {
    resetState(nestedFixture());
    expect(movePartRelativeTo('mid', 'root2', 'below')).toBe(true);
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    const ids = state.doc!.parts.map((p) => p.id);
    expect(ids).toEqual(['root1', 'mid', 'leaf1', 'leaf2', 'root2']);
    expect(state.doc!.parts.find((p) => p.id === 'mid')!.parentId).toBeNull(); // adopted root2's parent
  });
});

// ---- Acceptance: reorder in the panel → canvas + both exporters follow; keyed z is canvas-only ----

function pipLikeDoc(): RigDoc {
  return makeDoc([
    makePart('p_body', { label: 'body', paths: [makePath('body_path')] }),
    makePart('p_arm', {
      label: 'right_arm', paths: [makePath('arm_path')],
    }),
  ], [{ name: 'idle', duration: 1000, tracks: [] }]);
}

describe('acceptance — reorder right_arm above body', () => {
  it('exportRiv emits right_arm\'s shape topmost (reversed emission) after the reorder', () => {
    resetState(pipLikeDoc());
    // Before: body then right_arm in doc.parts (right_arm topmost/last already) — reorder
    // explicitly via the panel drag equivalent so the test doesn't depend on fixture order.
    expect(movePartRelativeTo('p_arm', 'p_body', 'below')).toBe(true); // arm now UNDER body
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p_arm', 'p_body']);

    const decoded = decodeRiv(exportRiv(state.doc!));
    const shapes = decoded.objects.filter((o) => o.typeKey === TYPE.SHAPE);
    // doc.parts = [arm, body] → body is topmost (last) → file order is REVERSED → body's
    // shape emits FIRST (drawn topmost by the runtime).
    expect(shapes.map((s) => s.props[PROP.NAME])).toEqual(['body_path', 'arm_path']);
  });

  it('exportLottie layer order follows the reordered doc.parts (first layer = topmost)', () => {
    resetState(pipLikeDoc());
    expect(movePartRelativeTo('p_arm', 'p_body', 'below')).toBe(true);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p_arm', 'p_body']);

    const anim = JSON.parse(exportLottie(state.doc!, 0)) as { layers: { nm: string }[] };
    const partLayerNames = anim.layers.map((l) => l.nm).filter((nm) => nm !== 'test root');
    // doc.parts = [arm, body] (body topmost/last) → Lottie's first-layer-on-top convention
    // means body's layer comes first.
    expect(partLayerNames).toEqual(['body', 'right_arm']);
  });

  it('a keyed z offset flips the arm behind at the keyed time on canvas, WITHOUT touching doc.parts', () => {
    resetState(pipLikeDoc());
    const authoredOrder = state.doc!.parts.map((p) => p.id); // [body, arm] — arm topmost
    setKeyframeAt('p_arm', 'z', 500, -5, 'linear'); // lift the arm BEHIND everything at t=500

    // Edit mode (t=null): z keys are ignored entirely — pure rest/authored order.
    const editSorted = drawOrder(state.doc!.parts, (p) => channelValue(p, 'z', null));
    expect(editSorted.map((p) => p.id)).toEqual(authoredOrder);

    // Animate mode at the keyed time: the EFFECTIVE canvas order re-sorts...
    const animSorted = drawOrder(state.doc!.parts, (p) => channelValue(p, 'z', 500));
    expect(animSorted.map((p) => p.id)).toEqual(['p_arm', 'p_body']); // arm now behind
    // ...but doc.parts (the panel's own order) is completely untouched by keying z.
    expect(state.doc!.parts.map((p) => p.id)).toEqual(authoredOrder);
  });
});
