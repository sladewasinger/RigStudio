/**
 * U3 (unified child ordering — exporters): the .riv GLOBAL drawable order is the
 * childOrder slot flatten (`core/paintOrder.ts`) reversed into Rive's first-in-file =
 * topmost convention (`io/riv/drawableOrder.ts`). Three pinned behaviors:
 *
 *  1. SYNTHESIZED-order docs (childOrder absent, or the paths-first shape normalizeDoc
 *     synthesizes) export BYTE-IDENTICALLY to the pre-U3 exporter — PRE_U3_SHA256 below
 *     was captured from the exporter BEFORE drawableOrder.ts existed (2026-07-14, the
 *     U3 wave's own baseline; the two goldenRiv.test.ts pins are the same guarantee on
 *     bigger docs).
 *  2. An INTERLEAVED childOrder (a path run stacked above a child part — a MULTI-RUN
 *     part) exports with the flatten's stacking, shapes still parent to their own part
 *     Node, and animation KeyedObject wiring (recorded node indices) survives the
 *     drawable reordering.
 *  3. A SKINNED multi-run part keeps its Skin object tree intact through the
 *     reordering: one Skin per PointsPath, Tendons in skin.bones order under each, a
 *     CubicWeight on every vertex, and the PIN-TO-REST anchor RootBone emitted exactly
 *     ONCE (per part, not per run) with its 1-based tendon slot still resolving.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { exportRiv } from '../io/riv';
import { normalizeDoc, RigDoc, RigPart, RigPath, SkinBone } from '../core/model';
import { decodeRiv, DecodedObject, PROP, TYPE } from './rivDecoder';

/** Captured from the PRE-U3 exporter (reversed two-bucket emission) for
 *  synthesizedOrderDoc() below — see the file header. Do NOT re-pin. */
const PRE_U3_SHA256 = 'f1f2bd030deaab732e2e2053a0d8beae21ceb5d064a1d5ace13edeb3ad5e7ef7';

function path(id: string, o: Partial<RigPath> = {}): RigPath {
  return {
    id, label: id, d: 'M 10,45 L 90,45 L 90,55 L 10,55 Z',
    fill: '#cc3366', fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1,
    transform: '', ...o,
  };
}
function part(id: string, o: Partial<RigPart> = {}): RigPart {
  return {
    id, label: id, kind: 'art', transform: '', pivot: { x: 0, y: 0 }, pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 }, parentId: null,
    paths: [], ...o,
  };
}

/**
 * The baseline fixture: a nested hierarchy (multi-path torso carrying an arm and a
 * partless head group with a face), a standalone shadow, a hidden part, one keyed
 * channel — and NO childOrder anywhere (the synthesized/legacy shape).
 */
function synthesizedOrderDoc(): RigDoc {
  const shadow = part('p_shadow', { label: 'shadow', paths: [path('s1')] });
  const torso = part('p_torso', {
    label: 'torso', pivot: { x: 50, y: 50 }, paths: [path('t1'), path('t2'), path('t3')],
  });
  const arm = part('p_arm', {
    label: 'arm', parentId: 'p_torso', pivot: { x: 30, y: 30 }, paths: [path('a1'), path('a2')],
  });
  const head = part('p_head', { label: 'head', kind: 'group', parentId: 'p_torso', pivot: { x: 50, y: 20 } });
  const face = part('p_face', { label: 'face', parentId: 'p_head', pivot: { x: 50, y: 15 }, paths: [path('f1')] });
  const hidden = part('p_hidden', { label: 'hid', hidden: true, paths: [path('h1')] });
  return {
    name: 'order', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [shadow, torso, arm, head, face, hidden], rootPivot: { x: 50, y: 50 },
    clips: [{
      name: 'c', duration: 1000,
      tracks: [{
        target: 'p_arm', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 45, easing: 'easeIn' },
        ],
      }],
    }],
  } as RigDoc;
}

/** The same doc, hand-INTERLEAVED: torso's slot list runs [t1] · arm · [t2,t3] · head —
 *  the arm sandwiched between two of the torso's own path runs. */
function interleavedOrderDoc(): RigDoc {
  const doc = synthesizedOrderDoc();
  doc.parts.find((p) => p.id === 'p_torso')!.childOrder = [
    { kind: 'path', id: 't1' },
    { kind: 'part', id: 'p_arm' },
    { kind: 'path', id: 't2' },
    { kind: 'path', id: 't3' },
    { kind: 'part', id: 'p_head' },
  ];
  return doc;
}

const shapeNames = (d: ReturnType<typeof decodeRiv>): (string | number)[] =>
  d.objects.filter((o) => o.typeKey === TYPE.SHAPE).map((o) => o.props[PROP.NAME]);

describe('exportRiv drawable order (U3): synthesized docs are byte-identical to pre-U3', () => {
  it('exports the raw (childOrder-absent) fixture to the exact pre-U3 bytes', () => {
    const sha = createHash('sha256').update(exportRiv(synthesizedOrderDoc())).digest('hex');
    expect(sha).toBe(PRE_U3_SHA256);
  });

  it('exports the normalized (childOrder synthesized paths-first) fixture to the same bytes', () => {
    const sha = createHash('sha256').update(exportRiv(normalizeDoc(synthesizedOrderDoc()))).digest('hex');
    expect(sha).toBe(PRE_U3_SHA256);
  });

  it('emits the pre-U3 sequence: reversed parts, reversed paths per part, hidden excluded', () => {
    const d = decodeRiv(exportRiv(synthesizedOrderDoc()));
    expect(shapeNames(d)).toEqual(['f1', 'a2', 'a1', 't3', 't2', 't1', 's1']);
  });
});

describe('exportRiv drawable order (U3): interleaved childOrder', () => {
  const d = decodeRiv(exportRiv(interleavedOrderDoc()));

  it('emits the reversed slot flatten: the arm sandwiched between the torso\'s runs', () => {
    // Paint order (bottom→top) per flattenPaintOrder: s1 · t1 · a1 a2 · t2 t3 · f1
    // (hidden h1 excluded); the file is that fully reversed.
    expect(shapeNames(d)).toEqual(['f1', 't3', 't2', 'a2', 'a1', 't1', 's1']);
  });

  it('still parents every shape to its own part Node despite the multi-run split', () => {
    const nodes = d.objects.filter((o) => o.typeKey === TYPE.NODE);
    const nodeIndex = new Map(nodes.map((n) => [n.props[PROP.NAME], n.index]));
    const shapes = d.objects.filter((o) => o.typeKey === TYPE.SHAPE);
    const parentOf = (name: string) =>
      shapes.find((s) => s.props[PROP.NAME] === name)!.props[PROP.PARENT_ID];
    for (const t of ['t1', 't2', 't3']) expect(parentOf(t)).toBe(nodeIndex.get('torso'));
    for (const a of ['a1', 'a2']) expect(parentOf(a)).toBe(nodeIndex.get('arm'));
    expect(parentOf('f1')).toBe(nodeIndex.get('face'));
    expect(parentOf('s1')).toBe(nodeIndex.get('shadow'));
  });

  it('keeps KeyedObject.objectId aimed at the part Node through the reordering', () => {
    const armNode = d.objects.find(
      (o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm',
    )!;
    const keyed = d.animations[0].objects;
    expect(keyed.length).toBe(1);
    expect(keyed[0].objectId).toBe(armNode.index);
    expect(keyed[0].props[0].propertyKey).toBe(PROP.ROTATION);
    expect(keyed[0].props[0].keyframes[1].value).toBeCloseTo(Math.PI / 4, 5);
  });

  it('exports deterministically (two runs, identical bytes)', () => {
    const a = exportRiv(interleavedOrderDoc());
    const b = exportRiv(interleavedOrderDoc());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

// ---- Skinned multi-run part ----

function skinBone(id: string, px: number, py: number, qx: number, qy: number): SkinBone {
  return {
    id, restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bindSeg: { p: { x: px, y: py }, q: { x: qx, y: qy } },
  };
}

/**
 * A two-path skinned limb whose OWN bone chain sits interleaved between its paths
 * (childOrder [lp1 · b1 · lp2] — the limb is a MULTI-RUN part), bones parented under
 * the art per the bone-system convention. `withPin` adds a pin=1 override on lp1's
 * node 1 so the PIN-TO-REST anchor machinery runs through the split emission.
 */
function interleavedSkinnedDoc(withPin: boolean): RigDoc {
  const b1 = part('p_b1', {
    kind: 'bone', label: 'b1', pivot: { x: 10, y: 50 }, boneTip: { x: 50, y: 50 },
    parentId: 'p_limb',
  });
  const b2 = part('p_b2', {
    kind: 'bone', label: 'b2', pivot: { x: 50, y: 50 }, boneTip: { x: 90, y: 50 },
    parentId: 'p_b1',
  });
  const limb = part('p_limb', {
    label: 'limb', pivot: { x: 50, y: 50 },
    paths: [
      path('lp1', { d: 'M 10,45 L 50,45 L 50,55 L 10,55 Z' }),
      path('lp2', { d: 'M 50,45 L 90,45 L 90,55 L 50,55 Z' }),
    ],
    skin: {
      bones: [skinBone('p_b1', 10, 50, 50, 50), skinBone('p_b2', 50, 50, 90, 50)],
      ...(withPin ? { overrides: { lp1: { '1': { a: 'p_b2', b: null, t: 0, pin: 1 } } } } : {}),
    },
    childOrder: [
      { kind: 'path', id: 'lp1' },
      { kind: 'part', id: 'p_b1' },
      { kind: 'path', id: 'lp2' },
    ],
  });
  return {
    name: 'skin_order', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [limb, b1, b2], rootPivot: { x: 50, y: 50 },
    clips: [{
      name: 'bend', duration: 1000,
      tracks: [{
        target: 'p_b2', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 90, easing: 'linear' },
        ],
      }],
    }],
  } as RigDoc;
}

/** The Shape (by name) a component ultimately hangs under, via PointsPath.parentId. */
function shapeOfPointsPath(d: ReturnType<typeof decodeRiv>, pointsPath: DecodedObject): string {
  const shape = d.objects.find(
    (o) => o.typeKey === TYPE.SHAPE && o.index === pointsPath.props[PROP.PARENT_ID],
  )!;
  return String(shape.props[PROP.NAME]);
}

describe('exportRiv drawable order (U3): skinned multi-run part keeps its Skin tree intact', () => {
  const d = decodeRiv(exportRiv(interleavedSkinnedDoc(false)));

  it('emits the limb\'s runs at their flatten positions (lp2 above the bones above lp1)', () => {
    expect(shapeNames(d)).toEqual(['lp2', 'lp1']);
  });

  it('each PointsPath keeps its own Skin child, tendons in skin.bones order beneath it', () => {
    const pointsPaths = d.objects.filter((o) => o.typeKey === TYPE.POINTS_PATH);
    const skins = d.objects.filter((o) => o.typeKey === TYPE.SKIN);
    expect(pointsPaths.length).toBe(2);
    expect(skins.length).toBe(2);
    const b1 = d.objects.find((o) => o.typeKey === TYPE.ROOT_BONE && o.props[PROP.NAME] === 'b1')!;
    const b2 = d.objects.find((o) => o.typeKey === TYPE.ROOT_BONE && o.props[PROP.NAME] === 'b2')!;
    const skinShapes: string[] = [];
    for (const skin of skins) {
      const pp = pointsPaths.find((o) => o.index === skin.props[PROP.PARENT_ID])!;
      expect(pp).toBeTruthy();
      skinShapes.push(shapeOfPointsPath(d, pp));
      const tendons = d.objects.filter(
        (o) => o.typeKey === TYPE.TENDON && o.props[PROP.PARENT_ID] === skin.index,
      );
      expect(tendons.length).toBe(2);
      expect(tendons[0].props[PROP.TENDON_BONE_ID]).toBe(b1.index);
      expect(tendons[1].props[PROP.TENDON_BONE_ID]).toBe(b2.index);
    }
    // One Skin per path, each under its OWN shape (emitted lp2 first, then lp1).
    expect(skinShapes.sort()).toEqual(['lp1', 'lp2']);
  });

  it('every vertex of both runs carries a CubicWeight parented to it', () => {
    const verts = d.objects.filter((o) => o.typeKey === TYPE.CUBIC_VERTEX);
    const weights = d.objects.filter((o) => o.typeKey === TYPE.CUBIC_WEIGHT);
    expect(verts.length).toBe(8); // 4 per path
    expect(weights.length).toBe(8);
    const vertIndexes = new Set(verts.map((v) => v.index));
    for (const w of weights) expect(vertIndexes.has(Number(w.props[PROP.PARENT_ID]))).toBe(true);
  });

  it('emits the PIN anchor RootBone exactly ONCE for the whole part, not once per run', () => {
    const dp = decodeRiv(exportRiv(interleavedSkinnedDoc(true)));
    const anchors = dp.objects.filter(
      (o) => o.typeKey === TYPE.ROOT_BONE && o.props[PROP.NAME] === 'limb anchor',
    );
    expect(anchors.length).toBe(1);
    // Both paths' Skins gain the anchor tendon (3 each), referencing the ONE anchor.
    const tendons = dp.objects.filter((o) => o.typeKey === TYPE.TENDON);
    expect(tendons.length).toBe(6);
    expect(tendons.filter((t) => t.props[PROP.TENDON_BONE_ID] === anchors[0].index).length).toBe(2);
  });

  it('the pinned node still resolves to the anchor tendon slot through the split emission', () => {
    const dp = decodeRiv(exportRiv(interleavedSkinnedDoc(true)));
    // lp1's node 1 = 'L 50,45' → local (0,-5). lp2's node 0 shares that position, so
    // scope the lookup to vertices whose PointsPath hangs under shape lp1.
    const pointsPaths = dp.objects.filter((o) => o.typeKey === TYPE.POINTS_PATH);
    const lp1Path = pointsPaths.find((pp) => shapeOfPointsPath(dp, pp) === 'lp1')!;
    const vert = dp.objects.find(
      (o) => o.typeKey === TYPE.CUBIC_VERTEX &&
        o.props[PROP.PARENT_ID] === lp1Path.index &&
        Math.abs(Number(o.props[PROP.VERT_X]) - 0) < 1e-4 &&
        Math.abs(Number(o.props[PROP.VERT_Y]) - -5) < 1e-4,
    )!;
    expect(vert).toBeTruthy();
    const weight = dp.objects.find(
      (o) => o.typeKey === TYPE.CUBIC_WEIGHT && o.props[PROP.PARENT_ID] === vert.index,
    )!;
    // pin=1 → the whole row on the anchor: 2 real bones → slots 1,2; anchor → slot 3.
    expect(Number(weight.props[PROP.WEIGHT_VALUES])).toBe(255);
    expect(Number(weight.props[PROP.WEIGHT_INDICES])).toBe(3);
  });
});
