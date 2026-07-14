/**
 * Skeletal-deformation (.riv Skin/Tendon/CubicWeight) exporter tests — the skinned-part
 * export wave, 2026-07-13. Structural assertions via rivDecoder.ts on a hand-authored
 * two-bone limb: RootBone emission (bones are REAL Rive bones now, not plain Nodes),
 * Skin/Tendon bind matrices (including a rotated-bind case that would catch a
 * transposed xy/yx property mapping), per-vertex CubicWeights (byte sums, dominance,
 * override pinning), the rigid fallback for hidden/dangling bones, keyed bone channels
 * targeting RootBone x/y, and determinism. The doc-space frame math being encoded is
 * derived in io/riv/skin.ts's header.
 */

import { describe, expect, it } from 'vitest';
import { exportRiv, __riv } from '../io/riv';
import { Clip, RigDoc, RigPart, RigPath, SkinBone } from '../core/model';
import { matrixOfTransform, invertMat, multiply, Mat } from '../geometry/transforms';
import { decodeRiv, DecodedObject, PROP, TYPE } from './rivDecoder';

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

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
function skinBone(id: string, px: number, py: number, qx: number, qy: number, restWorldInv: Mat = IDENTITY): SkinBone {
  return { id, restWorldInv, bindSeg: { p: { x: px, y: py }, q: { x: qx, y: qy } } };
}

/**
 * A horizontal bar (10,45)-(90,55) skinned to a 2-bone chain along its spine:
 * b1 (10,50)->(50,50), b2 (50,50)->(90,50) parented to b1 — bones at rest, identity
 * restWorldInv (the normal bind state). The clip keys b2.rotate 0->90 (the bend) and
 * b2.tx (only to pin the RootBone-x key mapping; not an editor-reachable channel).
 */
function skinnedDoc(): RigDoc {
  const b1 = part('p_b1', {
    kind: 'bone', label: 'b1', pivot: { x: 10, y: 50 }, boneTip: { x: 50, y: 50 },
  });
  const b2 = part('p_b2', {
    kind: 'bone', label: 'b2', pivot: { x: 50, y: 50 }, boneTip: { x: 90, y: 50 },
    parentId: 'p_b1',
  });
  const limb = part('p_limb', {
    label: 'limb', pivot: { x: 50, y: 50 }, paths: [path('limb_path')],
    skin: { bones: [skinBone('p_b1', 10, 50, 50, 50), skinBone('p_b2', 50, 50, 90, 50)] },
  });
  const bend: Clip = {
    name: 'bend', duration: 1000,
    tracks: [
      {
        target: 'p_b2', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 90, easing: 'linear' },
        ],
      },
      {
        target: 'p_b2', channel: 'tx', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 5, easing: 'linear' },
        ],
      },
    ],
  };
  return {
    name: 'skin_test', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [b1, b2, limb], rootPivot: { x: 50, y: 50 }, clips: [bend],
  } as RigDoc;
}

// ---- Decode helpers ----

const byLabel = (d: ReturnType<typeof decodeRiv>, typeKey: number, label: string) =>
  d.objects.find((o) => o.typeKey === typeKey && o.props[PROP.NAME] === label);

/** The 4 packed bytes of a weight uint, low byte first (weight.cpp's byte-per-slot). */
const bytes4 = (v: number): number[] =>
  [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** The CubicWeight immediately following the vertex at LOCAL (x, y) (doc − pivot). */
function weightOfVertexAt(d: ReturnType<typeof decodeRiv>, x: number, y: number): DecodedObject {
  const vi = d.objects.findIndex(
    (o) => o.typeKey === TYPE.CUBIC_VERTEX &&
      Math.abs(Number(o.props[PROP.VERT_X]) - x) < 1e-4 &&
      Math.abs(Number(o.props[PROP.VERT_Y]) - y) < 1e-4,
  );
  expect(vi, `vertex at (${x},${y})`).toBeGreaterThanOrEqual(0);
  const w = d.objects[vi + 1];
  expect(w.typeKey).toBe(TYPE.CUBIC_WEIGHT);
  expect(w.props[PROP.PARENT_ID]).toBe(d.objects[vi].index);
  return w;
}

describe('exportRiv skeletal deformation: bones as RootBone', () => {
  const d = decodeRiv(exportRiv(skinnedDoc()));

  it('emits every bone part as a RootBone (never a plain Node or Bone)', () => {
    const b1 = byLabel(d, TYPE.ROOT_BONE, 'b1')!;
    const b2 = byLabel(d, TYPE.ROOT_BONE, 'b2')!;
    expect(b1).toBeTruthy();
    expect(b2).toBeTruthy();
    expect(byLabel(d, TYPE.NODE, 'b1')).toBeUndefined();
    expect(d.objects.some((o) => o.typeKey === TYPE.BONE)).toBe(false);
    expect(b2.props[PROP.PARENT_ID]).toBe(b1.index);
  });

  it('positions RootBones with their OWN x/y keys (90/91), pivot-relative like Nodes', () => {
    const b1 = byLabel(d, TYPE.ROOT_BONE, 'b1')!;
    const b2 = byLabel(d, TYPE.ROOT_BONE, 'b2')!;
    // b1 parents to root (rootPivot 50,50): base = (10-50, 50-50).
    expect(b1.props[PROP.ROOT_BONE_X]).toBeCloseTo(-40, 4);
    expect(b1.props[PROP.ROOT_BONE_Y]).toBeCloseTo(0, 4);
    // b2 parents to b1: base = (50-10, 50-50).
    expect(b2.props[PROP.ROOT_BONE_X]).toBeCloseTo(40, 4);
    expect(b2.props[PROP.ROOT_BONE_Y]).toBeCloseTo(0, 4);
    expect(b1.props[PROP.X]).toBeUndefined(); // Node.x(13) must NOT appear on a bone
    expect(b1.props[PROP.BONE_LENGTH]).toBeCloseTo(40, 4);
    expect(b2.props[PROP.BONE_LENGTH]).toBeCloseTo(40, 4);
  });

  it('keys bone rotate on rotation(15) and bone tx on RootBone.x(90), not Node.x(13)', () => {
    const b2 = byLabel(d, TYPE.ROOT_BONE, 'b2')!;
    // One KeyedObject per channel (the emitter's shape) — collect every one for b2.
    const props = d.animations[0].objects
      .filter((o) => o.objectId === b2.index)
      .flatMap((o) => o.props);
    const propKeys = props.map((p) => p.propertyKey).sort((a, b) => a - b);
    expect(propKeys).toEqual([PROP.ROTATION, PROP.ROOT_BONE_X]);
    const rot = props.find((p) => p.propertyKey === PROP.ROTATION)!;
    expect(rot.keyframes[1].value).toBeCloseTo(Math.PI / 2, 5); // 90deg absolute, radians
    const tx = props.find((p) => p.propertyKey === PROP.ROOT_BONE_X)!;
    expect(tx.keyframes[1].value).toBeCloseTo(40 + 5, 4); // base + keyed value
  });
});

describe('exportRiv skeletal deformation: Skin/Tendon/CubicWeight', () => {
  const d = decodeRiv(exportRiv(skinnedDoc()));

  it('gives the skinned PointsPath a Skin child whose bind matrix is T(pivot - frame origin)', () => {
    const skins = d.objects.filter((o) => o.typeKey === TYPE.SKIN);
    expect(skins.length).toBe(1); // one subpath in the fixture
    const pathObj = d.objects.find((o) => o.typeKey === TYPE.POINTS_PATH)!;
    expect(skins[0].props[PROP.PARENT_ID]).toBe(pathObj.index);
    expect(skins[0].props[PROP.SKIN_XX]).toBeCloseTo(1, 6);
    expect(skins[0].props[PROP.SKIN_YX]).toBeCloseTo(0, 6);
    expect(skins[0].props[PROP.SKIN_XY]).toBeCloseTo(0, 6);
    expect(skins[0].props[PROP.SKIN_YY]).toBeCloseTo(1, 6);
    expect(skins[0].props[PROP.SKIN_TX]).toBeCloseTo(50, 4); // pivot.x - viewBox.x
    expect(skins[0].props[PROP.SKIN_TY]).toBeCloseTo(50, 4);
  });

  it('emits one Tendon per skin bone, in order, wired to the bone components', () => {
    const skin = d.objects.find((o) => o.typeKey === TYPE.SKIN)!;
    const tendons = d.objects.filter((o) => o.typeKey === TYPE.TENDON);
    expect(tendons.length).toBe(2);
    const b1 = byLabel(d, TYPE.ROOT_BONE, 'b1')!;
    const b2 = byLabel(d, TYPE.ROOT_BONE, 'b2')!;
    expect(tendons[0].props[PROP.PARENT_ID]).toBe(skin.index);
    expect(tendons[1].props[PROP.PARENT_ID]).toBe(skin.index);
    expect(tendons[0].props[PROP.TENDON_BONE_ID]).toBe(b1.index);
    expect(tendons[1].props[PROP.TENDON_BONE_ID]).toBe(b2.index);
    // Identity restWorldInv => tendon bind = T(bone.pivot) in artboard coords.
    expect(tendons[0].props[PROP.TENDON_XX]).toBeCloseTo(1, 6);
    expect(tendons[0].props[PROP.TENDON_YY]).toBeCloseTo(1, 6);
    expect(tendons[0].props[PROP.TENDON_TX]).toBeCloseTo(10, 4);
    expect(tendons[0].props[PROP.TENDON_TY]).toBeCloseTo(50, 4);
    expect(tendons[1].props[PROP.TENDON_TX]).toBeCloseTo(50, 4);
    expect(tendons[1].props[PROP.TENDON_TY]).toBeCloseTo(50, 4);
  });

  it('writes a rotated bind matrix in the xx,yx,xy,yy property-key order (transpose trap)', () => {
    // Give b1 a rotated bind: restWorldInv = invert(R(30deg about b1's pivot)). The
    // tendon bind must come back out as R(30deg about (10,50)) * T(pivot) with SVG
    // b (sin) on the XY key (98) and SVG c (-sin) on the YX key (97) — a transposed
    // mapping would swap their signs.
    const doc = skinnedDoc();
    const limb = doc.parts.find((p) => p.id === 'p_limb')!;
    const W = matrixOfTransform('rotate(30,10,50)');
    limb.skin!.bones[0] = { ...limb.skin!.bones[0], restWorldInv: invertMat(W) };
    const dd = decodeRiv(exportRiv(doc));
    const tendon = dd.objects.filter((o) => o.typeKey === TYPE.TENDON)[0];
    const expected = multiply(W, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 50 });
    expect(tendon.props[PROP.TENDON_XX]).toBeCloseTo(expected.a, 5);
    expect(tendon.props[PROP.TENDON_XY]).toBeCloseTo(expected.b, 5);
    expect(tendon.props[PROP.TENDON_YX]).toBeCloseTo(expected.c, 5);
    expect(tendon.props[PROP.TENDON_YY]).toBeCloseTo(expected.d, 5);
    expect(tendon.props[PROP.TENDON_TX]).toBeCloseTo(expected.e, 4);
    expect(tendon.props[PROP.TENDON_TY]).toBeCloseTo(expected.f, 4);
    expect(expected.b).toBeCloseTo(0.5, 5); // sin(30) — the two keys are NOT symmetric
    expect(expected.c).toBeCloseTo(-0.5, 5);
  });

  it('gives EVERY vertex of the skinned path a CubicWeight whose byte groups sum to 255', () => {
    const verts = d.objects.filter((o) => o.typeKey === TYPE.CUBIC_VERTEX);
    const weights = d.objects.filter((o) => o.typeKey === TYPE.CUBIC_WEIGHT);
    expect(verts.length).toBe(4);
    expect(weights.length).toBe(4);
    for (const w of weights) {
      for (const key of [PROP.WEIGHT_VALUES, PROP.WEIGHT_IN_VALUES, PROP.WEIGHT_OUT_VALUES]) {
        const sum = bytes4(Number(w.props[key])).reduce((a, b) => a + b, 0);
        expect(sum).toBe(255);
      }
    }
  });

  it('weights localize on the nearest bone (1-based tendon slots)', () => {
    // Vertex (10,45) -> local (-40,-5): on b1's origin — tendon slot 1 dominates.
    const near1 = weightOfVertexAt(d, -40, -5);
    const v1 = bytes4(Number(near1.props[PROP.WEIGHT_VALUES]));
    const i1 = bytes4(Number(near1.props[PROP.WEIGHT_INDICES]));
    const slotOf = (values: number[], indices: number[]) => indices[values.indexOf(Math.max(...values))];
    expect(slotOf(v1, i1)).toBe(1);
    expect(Math.max(...v1)).toBeGreaterThan(200); // power-4 falloff localizes hard
    // Vertex (90,55) -> local (40,5): on b2's tip — tendon slot 2 dominates.
    const near2 = weightOfVertexAt(d, 40, 5);
    const v2 = bytes4(Number(near2.props[PROP.WEIGHT_VALUES]));
    const i2 = bytes4(Number(near2.props[PROP.WEIGHT_INDICES]));
    expect(slotOf(v2, i2)).toBe(2);
    expect(Math.max(...v2)).toBeGreaterThan(200);
  });

  it('a per-node override pins its vertex to the chosen bone exactly', () => {
    const doc = skinnedDoc();
    const limb = doc.parts.find((p) => p.id === 'p_limb')!;
    // Node/command index 1 = 'L 90,45' — pin it 100% to b2 (t=0, b=null => all a).
    limb.skin! = { ...limb.skin!, overrides: { limb_path: { '1': { a: 'p_b2', b: null, t: 0 } } } };
    const dd = decodeRiv(exportRiv(doc));
    const w = weightOfVertexAt(dd, 40, -5); // (90,45) - pivot
    expect(Number(w.props[PROP.WEIGHT_VALUES])).toBe(255);
    expect(Number(w.props[PROP.WEIGHT_INDICES])).toBe(2); // single influence, slot 2 (b2)
  });

  it('pins the ToC backing types for the new keys', () => {
    expect(d.tocTypes.get(PROP.WEIGHT_VALUES)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.WEIGHT_IN_INDICES)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.TENDON_BONE_ID)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.TENDON_XX)).toBe(2); // double
    expect(d.tocTypes.get(PROP.SKIN_TX)).toBe(2); // double
    expect(d.tocTypes.get(PROP.ROOT_BONE_X)).toBe(2); // double
    expect(d.tocTypes.get(PROP.BONE_LENGTH)).toBe(2); // double
  });

  it('export is deterministic (two runs, identical bytes)', () => {
    const a = exportRiv(skinnedDoc());
    const b = exportRiv(skinnedDoc());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('exportRiv skeletal deformation: PIN-TO-REST synthetic anchor bone', () => {
  it('a plan with zero pinned nodes emits no anchor bone or extra tendon (no-op path)', () => {
    const d = decodeRiv(exportRiv(skinnedDoc()));
    expect(d.objects.some((o) => o.props[PROP.NAME] === 'limb anchor')).toBe(false);
    expect(d.objects.filter((o) => o.typeKey === TYPE.TENDON).length).toBe(2); // the 2 real bones only
    expect(d.objects.filter((o) => o.typeKey === TYPE.ROOT_BONE).length).toBe(2); // b1, b2 only
  });

  it('a pinned node gets one extra anchor RootBone + Tendon, static and never keyed', () => {
    const doc = skinnedDoc();
    const limb = doc.parts.find((p) => p.id === 'p_limb')!;
    limb.skin!.overrides = { limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 1 } } };
    const d = decodeRiv(exportRiv(doc));
    const anchor = byLabel(d, TYPE.ROOT_BONE, 'limb anchor')!;
    expect(anchor).toBeTruthy();
    expect(anchor.props[PROP.PARENT_ID]).toBe(byLabel(d, TYPE.NODE, 'limb')!.index);
    expect(anchor.props[PROP.ROOT_BONE_X]).toBeCloseTo(0, 6);
    expect(anchor.props[PROP.ROOT_BONE_Y]).toBeCloseTo(0, 6);
    // Never animated: no KeyedObject in the 'bend' animation targets it, even though
    // the SAME clip keys b2's rotate/tx.
    const targetsAnchor = d.animations[0].objects.some((o) => o.objectId === anchor.index);
    expect(targetsAnchor).toBe(false);
    const tendons = d.objects.filter((o) => o.typeKey === TYPE.TENDON);
    expect(tendons.length).toBe(3); // 2 real bones + 1 anchor, appended last
    expect(tendons[2].props[PROP.TENDON_BONE_ID]).toBe(anchor.index);
    // limb sits at the top level with zero rest rotation and no rotated ancestor, so the
    // anchor's STATIC bind equals the Skin's own bind matrix exactly (T(pivot -
    // frameOrigin), identity rotation) — see io/riv/skin.ts's header derivation.
    expect(tendons[2].props[PROP.TENDON_XX]).toBeCloseTo(1, 6);
    expect(tendons[2].props[PROP.TENDON_YY]).toBeCloseTo(1, 6);
    expect(tendons[2].props[PROP.TENDON_XY]).toBeCloseTo(0, 6);
    expect(tendons[2].props[PROP.TENDON_YX]).toBeCloseTo(0, 6);
    expect(tendons[2].props[PROP.TENDON_TX]).toBeCloseTo(50, 4);
    expect(tendons[2].props[PROP.TENDON_TY]).toBeCloseTo(50, 4);
  });

  it('folds pin proportionally into the weight row: pin=1 -> single anchor influence (slot 3)', () => {
    const doc = skinnedDoc();
    doc.parts.find((p) => p.id === 'p_limb')!.skin!.overrides = {
      limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 1 } },
    };
    const d = decodeRiv(exportRiv(doc));
    const w = weightOfVertexAt(d, 40, -5); // (90,45) - pivot(50,50), the overridden node
    expect(Number(w.props[PROP.WEIGHT_VALUES])).toBe(255);
    // 2 real bones -> tendons 1,2; the anchor is appended third -> 1-based slot 3.
    expect(Number(w.props[PROP.WEIGHT_INDICES])).toBe(3);
  });

  it('pin=0.5 splits the row ~evenly between the carried bone and the anchor', () => {
    const doc = skinnedDoc();
    doc.parts.find((p) => p.id === 'p_limb')!.skin!.overrides = {
      limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 0.5 } },
    };
    const d = decodeRiv(exportRiv(doc));
    const w = weightOfVertexAt(d, 40, -5);
    const values = bytes4(Number(w.props[PROP.WEIGHT_VALUES]));
    const indices = bytes4(Number(w.props[PROP.WEIGHT_INDICES]));
    expect(values.reduce((a, b) => a + b, 0)).toBe(255); // still sums exactly to 255
    const slotOf = (slot: number) => values[indices.indexOf(slot)] ?? 0;
    expect(slotOf(2)).toBeGreaterThan(100); // bone b2 (slot 2), ~50%
    expect(slotOf(2)).toBeLessThan(155);
    expect(slotOf(3)).toBeGreaterThan(100); // the anchor (slot 3), ~50%
    expect(slotOf(3)).toBeLessThan(155);
  });

  it("an unpinned node in the same skinned part is unaffected by another node's pin", () => {
    const pinnedDoc = skinnedDoc();
    pinnedDoc.parts.find((p) => p.id === 'p_limb')!.skin!.overrides = {
      limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 1 } },
    };
    const pinned = decodeRiv(exportRiv(pinnedDoc));
    const plain = decodeRiv(exportRiv(skinnedDoc()));
    // Vertex near b1's origin (node 0, untouched by the override on node 1) — identical
    // weights whether or not some OTHER node on the same part is pinned.
    const wPinned = weightOfVertexAt(pinned, -40, -5);
    const wPlain = weightOfVertexAt(plain, -40, -5);
    expect(wPinned.props[PROP.WEIGHT_VALUES]).toBe(wPlain.props[PROP.WEIGHT_VALUES]);
    expect(wPinned.props[PROP.WEIGHT_INDICES]).toBe(wPlain.props[PROP.WEIGHT_INDICES]);
  });

  it('falls back rigidly (no anchor either) when a skin bone is hidden, even with a pin set', () => {
    const doc = skinnedDoc();
    const limb = doc.parts.find((p) => p.id === 'p_limb')!;
    limb.skin!.overrides = { limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 1 } } };
    doc.parts.find((p) => p.id === 'p_b2')!.hidden = true;
    const d = decodeRiv(exportRiv(doc));
    expect(d.objects.some((o) => o.typeKey === TYPE.SKIN)).toBe(false);
    expect(d.objects.some((o) => o.props[PROP.NAME] === 'limb anchor')).toBe(false);
  });

  it('export stays deterministic with pins present (two runs, identical bytes)', () => {
    const build = () => {
      const doc = skinnedDoc();
      doc.parts.find((p) => p.id === 'p_limb')!.skin!.overrides = {
        limb_path: { '1': { a: 'p_b2', b: null, t: 0, pin: 0.5 } },
      };
      return exportRiv(doc);
    };
    expect(Buffer.from(build()).equals(Buffer.from(build()))).toBe(true);
  });

  // 4-INFLUENCE EVICTION (whitebox unit test of packRow's mustKeepIndex rule, exposed
  // via the __riv test-only bag — see io/riv/index.ts): 5 equal-weight candidates,
  // index 4 standing in for the pin/anchor slot. Without eviction support, the plain
  // top-4-by-weight cut drops index 4 (ties resolve toward the LOWEST index, so index 4
  // loses every tie); with `mustKeepIndex`, it always survives by evicting the weakest
  // (here, tied) currently-picked entry, and the row still sums to exactly 255.
  it('packRow evicts the weakest influence to admit a must-keep pin when already at the 4-cap', () => {
    const row = [0.2, 0.2, 0.2, 0.2, 0.2];
    const toIndices = (packed: { indices: number }) => {
      const b = [packed.indices & 0xff, (packed.indices >>> 8) & 0xff,
        (packed.indices >>> 16) & 0xff, (packed.indices >>> 24) & 0xff];
      return b.filter((x) => x !== 0).map((x) => x - 1); // back to 0-based row indices
    };
    const sumBytes = (packed: { values: number }) =>
      [packed.values & 0xff, (packed.values >>> 8) & 0xff,
        (packed.values >>> 16) & 0xff, (packed.values >>> 24) & 0xff]
        .reduce((a, b) => a + b, 0);

    const withoutMustKeep = __riv.packRow(row);
    expect(toIndices(withoutMustKeep)).not.toContain(4);
    expect(toIndices(withoutMustKeep).length).toBe(4);

    const withMustKeep = __riv.packRow(row, 4);
    expect(toIndices(withMustKeep)).toContain(4);
    expect(toIndices(withMustKeep).length).toBe(4); // still exactly 4, one evicted to make room
    expect(sumBytes(withMustKeep)).toBe(255);
  });

  it('packRow is a no-op passthrough for a row that already contains the must-keep index', () => {
    const row = [0.4, 0.3, 0.3]; // only 3 candidates — the top-4 slice keeps all of them
    expect(__riv.packRow(row, 0)).toEqual(__riv.packRow(row));
  });

  it('packRow is a no-op when the must-keep index itself is zero (nothing to protect)', () => {
    const row = [0, 0.5, 0.3, 0.2]; // 3 real candidates, none at index 0
    expect(__riv.packRow(row, 0)).toEqual(__riv.packRow(row));
  });
});

describe('exportRiv skeletal deformation: rigid fallback', () => {
  it('falls back to the rigid emission when a skin bone is hidden (no component)', () => {
    const doc = skinnedDoc();
    doc.parts.find((p) => p.id === 'p_b2')!.hidden = true;
    const d = decodeRiv(exportRiv(doc));
    expect(d.objects.some((o) => o.typeKey === TYPE.SKIN)).toBe(false);
    expect(d.objects.some((o) => o.typeKey === TYPE.TENDON)).toBe(false);
    expect(d.objects.some((o) => o.typeKey === TYPE.CUBIC_WEIGHT)).toBe(false);
    // The limb itself still exports (rigid, exactly the pre-wave shape emission).
    expect(byLabel(d, TYPE.SHAPE, 'limb_path')).toBeTruthy();
    expect(d.objects.filter((o) => o.typeKey === TYPE.CUBIC_VERTEX).length).toBe(4);
  });

  it('falls back when a skin bone reference dangles or points at a non-bone', () => {
    const dangling = skinnedDoc();
    dangling.parts.find((p) => p.id === 'p_limb')!.skin!.bones[1].id = 'p_gone';
    expect(decodeRiv(exportRiv(dangling)).objects.some((o) => o.typeKey === TYPE.SKIN)).toBe(false);

    const nonBone = skinnedDoc();
    nonBone.parts.find((p) => p.id === 'p_limb')!.skin!.bones[1].id = 'p_limb';
    expect(decodeRiv(exportRiv(nonBone)).objects.some((o) => o.typeKey === TYPE.SKIN)).toBe(false);
  });

  it('an empty bone list emits rigidly too', () => {
    const doc = skinnedDoc();
    doc.parts.find((p) => p.id === 'p_limb')!.skin = { bones: [] };
    const d = decodeRiv(exportRiv(doc));
    expect(d.objects.some((o) => o.typeKey === TYPE.SKIN)).toBe(false);
    expect(byLabel(d, TYPE.SHAPE, 'limb_path')).toBeTruthy();
  });
});
