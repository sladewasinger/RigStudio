/**
 * core/paintOrder.ts (U2) — the pure childOrder → paint-sequence flatten shared by the
 * live canvas and headless composePose. Covers: the degenerate (legacy/synthesized doc)
 * case is exactly today's per-part, single-run, doc.parts-order shape; run-splitting for
 * genuinely interleaved childOrder (paths as document-ordered runs around a child's whole
 * subtree); the partless-part anchor run; sibling-scoped z-sort (part slots resort, path
 * slots hold position) at both the root level and within one parent's own children; a
 * constant zOf (Edit-mode/structural-build simulation) reproduces the unsorted order
 * exactly, including tie-breaking by original relative order (drawOrder's own stability).
 */
import { describe, expect, it } from 'vitest';
import { RigPart, flattenPaintOrder, normalizeDoc, partOwnRuns } from '../core/model';
import { makeDoc, makePart, makePath } from './helpers';

const REST = () => 0;

describe('flattenPaintOrder — degenerate (legacy/synthesized) docs render exactly today\'s shape', () => {
  it('one run per part, doc.parts order, own paths in paths[] order — a nested fixture', () => {
    const doc = makeDoc([
      makePart('root1', { paths: [makePath('root1_p1')] }),
      makePart('mid', { parentId: 'root1', paths: [makePath('mid_p1'), makePath('mid_p2')] }),
      makePart('leaf1', { parentId: 'mid', paths: [makePath('leaf1_p1')] }),
      makePart('leaf2', { parentId: 'mid', paths: [makePath('leaf2_p1')] }),
      makePart('root2', { paths: [makePath('root2_p1')] }),
    ]);
    const runs = flattenPaintOrder(doc, REST);
    expect(runs).toEqual([
      { partId: 'root1', pathIds: ['root1_p1'], runIndex: 0, totalRuns: 1 },
      { partId: 'mid', pathIds: ['mid_p1', 'mid_p2'], runIndex: 0, totalRuns: 1 },
      { partId: 'leaf1', pathIds: ['leaf1_p1'], runIndex: 0, totalRuns: 1 },
      { partId: 'leaf2', pathIds: ['leaf2_p1'], runIndex: 0, totalRuns: 1 },
      { partId: 'root2', pathIds: ['root2_p1'], runIndex: 0, totalRuns: 1 },
    ]);
    // Part order alone (ignoring pathIds) equals doc.parts order exactly.
    expect(runs.map((r) => r.partId)).toEqual(doc.parts.map((p) => p.id));
  });

  it('normalizeDoc-synthesized childOrder produces the identical flatten as a childOrder-less doc', () => {
    const raw = makeDoc([
      makePart('a', { paths: [makePath('a_p1')] }),
      makePart('b', { parentId: 'a', paths: [makePath('b_p1')] }),
    ]);
    const withOrder = normalizeDoc(raw);
    const rawFlatten = flattenPaintOrder(raw, REST); // childOrder absent — effectiveChildOrder synthesizes on the fly
    const normalizedFlatten = flattenPaintOrder(withOrder, REST);
    expect(normalizedFlatten).toEqual(rawFlatten);
  });

  it('a partless part (bone/group) contributes exactly one empty anchor run', () => {
    const doc = makeDoc([makePart('bone', { kind: 'bone' })]);
    expect(flattenPaintOrder(doc, REST)).toEqual([
      { partId: 'bone', pathIds: [], runIndex: 0, totalRuns: 1 },
    ]);
  });

  it('an empty document flattens to an empty list', () => {
    expect(flattenPaintOrder(makeDoc([]), REST)).toEqual([]);
  });

  it('a partless part WITH children (a group) still emits its own anchor BEFORE its children\'s subtree', () => {
    // doc.parts DFS pre-order lists a group before its children — today's DOM matches
    // that (the group's own empty <g> precedes its children's). The anchor run must
    // land in the same relative spot, not trail after the recursed children.
    const doc = makeDoc([
      makePart('grp', { kind: 'group' }),
      makePart('c1', { parentId: 'grp', paths: [makePath('c1_p1')] }),
      makePart('c2', { parentId: 'grp', paths: [makePath('c2_p1')] }),
    ]);
    const runs = flattenPaintOrder(doc, REST);
    expect(runs.map((r) => r.partId)).toEqual(['grp', 'c1', 'c2']);
    expect(runs[0]).toEqual({ partId: 'grp', pathIds: [], runIndex: 0, totalRuns: 1 });
  });
});

describe('flattenPaintOrder — genuine interleaving (hand-authored childOrder)', () => {
  it('a part\'s own paths split into document-ordered runs around a child\'s whole subtree', () => {
    const doc = makeDoc([
      makePart('body', {
        paths: [makePath('shadow_under'), makePath('shadow_over')],
        childOrder: [
          { kind: 'path', id: 'shadow_under' },
          { kind: 'part', id: 'inner' },
          { kind: 'path', id: 'shadow_over' },
        ],
      }),
      makePart('inner', { parentId: 'body', paths: [makePath('inner_p1')] }),
    ]);
    const runs = flattenPaintOrder(doc, REST);
    expect(runs).toEqual([
      { partId: 'body', pathIds: ['shadow_under'], runIndex: 0, totalRuns: 2 },
      { partId: 'inner', pathIds: ['inner_p1'], runIndex: 0, totalRuns: 1 },
      { partId: 'body', pathIds: ['shadow_over'], runIndex: 1, totalRuns: 2 },
    ]);
  });

  it('deep interleaving: three runs around two different children', () => {
    const doc = makeDoc([
      makePart('p', {
        paths: [makePath('p1'), makePath('p2'), makePath('p3')],
        childOrder: [
          { kind: 'path', id: 'p1' },
          { kind: 'part', id: 'x' },
          { kind: 'path', id: 'p2' },
          { kind: 'part', id: 'y' },
          { kind: 'path', id: 'p3' },
        ],
      }),
      makePart('x', { parentId: 'p' }),
      makePart('y', { parentId: 'p' }),
    ]);
    const runs = flattenPaintOrder(doc, REST);
    expect(runs.map((r) => `${r.partId}:${r.runIndex}`)).toEqual([
      'p:0', 'x:0', 'p:1', 'y:0', 'p:2',
    ]);
    expect(runs.filter((r) => r.partId === 'p').map((r) => r.pathIds)).toEqual([['p1'], ['p2'], ['p3']]);
    expect(runs.every((r) => r.partId !== 'p' || r.totalRuns === 3)).toBe(true);
  });
});

describe('flattenPaintOrder — Animate-mode keyed z (sibling-scoped stable sort)', () => {
  it('re-sorts a part\'s own PART-slot children by z, stable on ties, path slots untouched', () => {
    const doc = makeDoc([
      makePart('body', {
        paths: [makePath('pA'), makePath('pB')],
        childOrder: [
          { kind: 'path', id: 'pA' },
          { kind: 'part', id: 'x' },
          { kind: 'part', id: 'y' },
          { kind: 'path', id: 'pB' },
        ],
      }),
      makePart('x', { parentId: 'body' }),
      makePart('y', { parentId: 'body' }),
    ]);
    const z = new Map([['x', 5], ['y', 0]]);
    const zOf = (p: RigPart) => z.get(p.id) ?? 0;
    const runs = flattenPaintOrder(doc, zOf);
    // y (z=0) now sorts before x (z=5) — but pA/pB never move from their own positions.
    expect(runs.map((r) => `${r.partId}:${r.runIndex}`)).toEqual([
      'body:0', 'y:0', 'x:0', 'body:1',
    ]);
    expect(runs[0].pathIds).toEqual(['pA']);
    expect(runs[3].pathIds).toEqual(['pB']);
  });

  it('ties preserve ORIGINAL relative order (stable sort)', () => {
    const doc = makeDoc([
      makePart('root'),
      makePart('a', { parentId: 'root', paths: [makePath('a1')] }),
      makePart('b', { parentId: 'root', paths: [makePath('b1')] }),
      makePart('c', { parentId: 'root', paths: [makePath('c1')] }),
    ]);
    const z = new Map([['a', 5], ['b', 0], ['c', 0]]);
    const zOf = (p: RigPart) => z.get(p.id) ?? 0;
    const runs = flattenPaintOrder(doc, zOf);
    // b and c tie at z=0 — original relative order (b before c) survives; a (z=5) moves last.
    expect(runs.map((r) => r.partId)).toEqual(['root', 'b', 'c', 'a']);
  });

  it('root-level siblings (no shared parent) also z-sort, scoped to the whole-doc root list', () => {
    const doc = makeDoc([
      makePart('r1', { paths: [makePath('r1p')] }),
      makePart('r2', { paths: [makePath('r2p')] }),
    ]);
    const z = new Map([['r1', 10], ['r2', 0]]);
    const zOf = (p: RigPart) => z.get(p.id) ?? 0;
    expect(flattenPaintOrder(doc, zOf).map((r) => r.partId)).toEqual(['r2', 'r1']);
  });

  it('partOwnRuns (view/partDom.ts\'s DOM-rebuild helper) agrees with flattenPaintOrder\'s own-run split for every part', () => {
    const doc = makeDoc([
      makePart('p', {
        paths: [makePath('p1'), makePath('p2'), makePath('p3')],
        childOrder: [
          { kind: 'path', id: 'p1' },
          { kind: 'part', id: 'x' },
          { kind: 'path', id: 'p2' },
          { kind: 'part', id: 'y' },
          { kind: 'path', id: 'p3' },
        ],
      }),
      makePart('x', { parentId: 'p' }),
      makePart('y', { parentId: 'p' }),
    ]);
    const runs = flattenPaintOrder(doc, REST);
    for (const part of doc.parts) {
      const fromFlatten = runs.filter((r) => r.partId === part.id).map((r) => r.pathIds);
      expect(partOwnRuns(part, doc.parts), `part ${part.id}`).toEqual(fromFlatten);
    }
  });

  it('a constant zOf (Edit mode / structural build) reproduces the REST order exactly', () => {
    const doc = makeDoc([
      makePart('body', {
        paths: [makePath('pA'), makePath('pB')],
        childOrder: [
          { kind: 'path', id: 'pA' },
          { kind: 'part', id: 'x' },
          { kind: 'part', id: 'y' },
          { kind: 'path', id: 'pB' },
        ],
      }),
      makePart('x', { parentId: 'body' }),
      makePart('y', { parentId: 'body' }),
    ]);
    expect(flattenPaintOrder(doc, REST).map((r) => `${r.partId}:${r.runIndex}`)).toEqual([
      'body:0', 'x:0', 'y:0', 'body:1',
    ]);
  });
});
