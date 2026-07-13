/**
 * Tests for the Rive (.riv) binary exporter. Two layers:
 *   1. the binary writer primitives (varuint boundaries, string, float32, ToC packing);
 *   2. structural/semantic assertions built on `rivDecoder.ts`'s standalone ToC-aware
 *      .riv decoder (re-reads the emitted .riv the way the runtime does — fingerprint/
 *      version, ToC-driven value decoding, the artboard component index space, and the
 *      animation object tree) on a Pip-like fixture (object sequence, parentId validity,
 *      node count, one animation per clip, absolute-vs-rest keyframe semantics, custom-
 *      bezier interpolator wiring).
 */

import { describe, expect, it } from 'vitest';
import { exportRiv, __riv } from '../io/riv';
import { Clip, RigDoc, RigPart, RigPath, StateMachine } from '../core/model';
import { decodeRiv, PROP, Reader, TYPE } from './rivDecoder';

const DEG2RAD = Math.PI / 180;

// ---- Fixtures ----

function path(id: string, o: Partial<RigPath> = {}): RigPath {
  return {
    id, label: id, d: 'M 0,0 L 10,0 L 10,10 L 0,10 Z',
    fill: '#3366cc', fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1,
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
 * body (art, at root) + arm (art, parented to body). arm.rotate is keyed with a nonzero
 * rest so the absolute-vs-rest rule is testable; body.tx is keyed (base-offset test);
 * body.ty is deliberately UNKEYED (static-property test). A second clip keys arm.rotate
 * with a custom cubic-bezier (interpolator-wiring test).
 */
function pipDoc(): RigDoc {
  const body = part('p_body', {
    label: 'body', pivot: { x: 50, y: 50 }, paths: [path('body_path')],
  });
  const arm = part('p_arm', {
    label: 'arm', pivot: { x: 70, y: 40 }, parentId: 'p_body',
    rest: { rotate: 15, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    paths: [path('arm_path', { stroke: '#000000', strokeWidth: 2 })],
  });
  const idle: Clip = {
    name: 'idle', duration: 1000,
    tracks: [
      {
        target: 'p_arm', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: 40, easing: 'easeInOut' },
          { time: 1000, value: 0, easing: 'easeOut' },
        ],
      },
      {
        target: 'p_body', channel: 'tx', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 12, easing: 'linear' },
        ],
      },
    ],
  };
  const wave: Clip = {
    name: 'wave', duration: 800,
    tracks: [
      {
        target: 'p_arm', channel: 'rotate', keyframes: [
          { time: 0, value: -20, easing: 'linear' },
          { time: 800, value: 20, easing: 'linear', bezier: [0.2, 0.9, 0.7, 0.1] },
        ],
      },
    ],
  };
  return {
    name: 'pip', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [body, arm], rootPivot: { x: 50, y: 80 }, clips: [idle, wave],
  };
}

// ---- Writer primitive tests ----

describe('riv binary writer primitives', () => {
  const { ByteWriter } = __riv;

  const bytesOf = (fn: (w: InstanceType<typeof ByteWriter>) => void): number[] => {
    const w = new ByteWriter();
    fn(w);
    return w.bytes;
  };

  it('encodes varuint at single/multi-byte boundaries (LEB128)', () => {
    expect(bytesOf((w) => w.varuint(0))).toEqual([0x00]);
    expect(bytesOf((w) => w.varuint(1))).toEqual([0x01]);
    expect(bytesOf((w) => w.varuint(127))).toEqual([0x7f]);
    expect(bytesOf((w) => w.varuint(128))).toEqual([0x80, 0x01]);
    expect(bytesOf((w) => w.varuint(300))).toEqual([0xac, 0x02]);
    expect(bytesOf((w) => w.varuint(16383))).toEqual([0xff, 0x7f]);
    expect(bytesOf((w) => w.varuint(16384))).toEqual([0x80, 0x80, 0x01]);
    expect(bytesOf((w) => w.varuint(2097152))).toEqual([0x80, 0x80, 0x80, 0x01]);
  });

  it('round-trips varuint through the reader', () => {
    for (const n of [0, 1, 63, 64, 127, 128, 255, 256, 16383, 16384, 123456, 9999999]) {
      const w = new ByteWriter();
      w.varuint(n);
      expect(new Reader(Uint8Array.from(w.bytes)).varuint()).toBe(n);
    }
  });

  it('encodes strings as varuint length + UTF-8', () => {
    expect(bytesOf((w) => w.string('AB'))).toEqual([0x02, 0x41, 0x42]);
    expect(bytesOf((w) => w.string(''))).toEqual([0x00]);
    // Multi-byte UTF-8: 'é' = 0xC3 0xA9, so length prefix is 2.
    expect(bytesOf((w) => w.string('é'))).toEqual([0x02, 0xc3, 0xa9]);
  });

  it('encodes float32 little-endian and round-trips', () => {
    expect(bytesOf((w) => w.f32(1))).toEqual([0x00, 0x00, 0x80, 0x3f]);
    for (const v of [0, 1, -1, 0.5, 3.14159, -123.456, 1e6]) {
      const w = new ByteWriter();
      w.f32(v);
      expect(new Reader(Uint8Array.from(w.bytes)).f32()).toBeCloseTo(Math.fround(v), 5);
    }
  });

  it('encodes uint32 (color) little-endian', () => {
    // 0xAARRGGBB packed ARGB.
    expect(bytesOf((w) => w.u32(0xff3366cc))).toEqual([0xcc, 0x66, 0x33, 0xff]);
  });
});

describe('riv argb packing', () => {
  it('packs #rrggbb + opacity into 0xAARRGGBB', () => {
    expect(__riv.argb('#3366cc', 1) >>> 0).toBe(0xff3366cc);
    expect(__riv.argb('#000000', 0.5) >>> 0).toBe(0x80000000);
    expect(__riv.argb('#fff', 1) >>> 0).toBe(0xffffffff); // #rgb shorthand
    expect(__riv.argb('nonsense', 1) >>> 0).toBe(0xff000000); // fallback black
  });

  it('folds Pip-like translucent fill opacities into the exact alpha byte', () => {
    // Pip's shadow paths use these opacities; alpha = Math.round(opacity * 255).
    expect(__riv.argb('#000000', 0.307895) >>> 0).toBe(0x4f000000); // 78.51 -> 0x4F
    expect(__riv.argb('#000000', 0.3) >>> 0).toBe(0x4d000000); // 76.5 -> 0x4D
    expect(__riv.argb('#000000', 0.15) >>> 0).toBe(0x26000000); // 38.25 -> 0x26
  });
});

// ---- ToC bit-packing test ----

describe('riv ToC bit-packing', () => {
  it('packs backing types four keys per uint32 word (matches runtime_header)', () => {
    const bytes = exportRiv(pipDoc());
    const d = decodeRiv(bytes);
    // Keys are ascending; every key used in the body must appear in the ToC exactly.
    expect(d.tocKeys).toEqual([...d.tocKeys].sort((a, b) => a - b));
    expect(new Set(d.tocKeys).size).toBe(d.tocKeys.length); // no duplicates
    // Known backing types decode correctly.
    expect(d.tocTypes.get(PROP.NAME)).toBe(1); // string
    expect(d.tocTypes.get(PROP.PARENT_ID)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.X)).toBe(2); // double
    expect(d.tocTypes.get(PROP.COLOR)).toBe(3); // color
    expect(d.tocTypes.get(PROP.IS_CLOSED)).toBe(0); // bool -> uint slot
    // Byte length of the bit array is exactly ceil(keys/4) words = 4*ceil(n/4) bytes.
    // (Implicitly verified because decoding the object stream succeeded.)
  });
});

// ---- Structural / semantic tests ----

describe('exportRiv structure', () => {
  const bytes = exportRiv(pipDoc());
  const d = decodeRiv(bytes);

  it('starts with a valid header (RIVE, major 7)', () => {
    expect(d.major).toBe(7);
  });

  it('emits Backboard then Artboard first, artboard sized to the viewBox', () => {
    expect(d.objects[0].typeKey).toBe(TYPE.BACKBOARD);
    expect(d.objects[0].index).toBe(-1); // backboard does not consume an index
    expect(d.objects[1].typeKey).toBe(TYPE.ARTBOARD);
    expect(d.objects[1].index).toBe(0);
    expect(d.objects[1].props[PROP.WIDTH]).toBeCloseTo(100, 3);
    expect(d.objects[1].props[PROP.HEIGHT]).toBeCloseTo(100, 3);
    expect(d.objects[1].props[PROP.NAME]).toBe('pip');
  });

  it('every parentId references an earlier component index', () => {
    for (const o of d.objects) {
      if (o.props[PROP.PARENT_ID] !== undefined) {
        expect(o.index).toBeGreaterThan(0);
        expect(Number(o.props[PROP.PARENT_ID])).toBeLessThan(o.index);
      }
    }
  });

  it('has one Node per part plus the root node', () => {
    const nodes = d.objects.filter((o) => o.typeKey === TYPE.NODE);
    expect(nodes.length).toBe(2 + 1); // body, arm, root
    // Root node parents to the artboard (index 0); part nodes parent to a node.
    const root = nodes.find((n) => n.props[PROP.NAME] === 'pip root')!;
    expect(root.props[PROP.PARENT_ID]).toBe(0);
  });

  it('parents the arm node to the body node (bone hierarchy)', () => {
    const body = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'body')!;
    const arm = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm')!;
    expect(arm.props[PROP.PARENT_ID]).toBe(body.index);
  });

  it('emits a Shape + closed PointsPath + vertices + Fill/SolidColor for a filled path', () => {
    const shapes = d.objects.filter((o) => o.typeKey === TYPE.SHAPE);
    expect(shapes.length).toBe(2); // body_path, arm_path
    const paths = d.objects.filter((o) => o.typeKey === TYPE.POINTS_PATH);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.every((p) => p.props[PROP.IS_CLOSED] === 1)).toBe(true); // 'Z' closed
    const verts = d.objects.filter((o) => o.typeKey === TYPE.CUBIC_VERTEX);
    // A 4-corner square (after closing-fold) -> 4 vertices per path.
    expect(verts.length).toBe(8);
    const fills = d.objects.filter((o) => o.typeKey === TYPE.FILL);
    expect(fills.length).toBe(2);
    const colors = d.objects.filter((o) => o.typeKey === TYPE.SOLID_COLOR);
    // Two fills + one stroke (arm) = three solid colors.
    expect(colors.length).toBe(3);
    const fillColor = colors.find((c) => (c.props[PROP.COLOR] as number) >>> 0 === 0xff3366cc);
    expect(fillColor).toBeTruthy();
  });

  it('scales stroke thickness by the baked matrix and packs the stroke color', () => {
    const stroke = d.objects.find((o) => o.typeKey === TYPE.STROKE)!;
    expect(Number(stroke.props[PROP.THICKNESS])).toBeCloseTo(2, 3); // identity transform
  });

  it('emits one LinearAnimation per clip, 60fps, looped, correct frame duration', () => {
    expect(d.animations.length).toBe(2);
    const idle = d.animations.find((a) => a.name === 'idle')!;
    expect(idle.fps).toBe(60);
    expect(idle.duration).toBe(60); // 1000ms @ 60fps
    expect(idle.loop).toBe(1);
    const wave = d.animations.find((a) => a.name === 'wave')!;
    expect(wave.duration).toBe(48); // 800ms @ 60fps
  });

  it('keyframe values are ABSOLUTE (independent of the rest pose)', () => {
    const arm = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm')!;
    // Static Node rotation carries the rest pose (15deg -> radians).
    expect(Number(arm.props[PROP.ROTATION])).toBeCloseTo(15 * DEG2RAD, 5);

    const idle = d.animations.find((a) => a.name === 'idle')!;
    const armRot = idle.objects.find((k) => k.objectId === arm.index)!
      .props.find((p) => p.propertyKey === PROP.ROTATION)!;
    expect(armRot.keyframes.map((k) => k.frame)).toEqual([0, 30, 60]);
    // Values are the raw keys in radians — NOT rest+key.
    expect(armRot.keyframes.map((k) => Math.round(k.value / DEG2RAD))).toEqual([0, 40, 0]);
  });

  it('folds the pivot base-offset into keyed x values (parent-relative node origin)', () => {
    const body = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'body')!;
    const idle = d.animations.find((a) => a.name === 'idle')!;
    const bodyTx = idle.objects.find((k) => k.objectId === body.index)!
      .props.find((p) => p.propertyKey === PROP.X)!;
    // body base_x = pivot.x(50) - rootPivot.x(50) = 0, so keyed x == raw tx keys.
    expect(bodyTx.keyframes.map((k) => Math.round(k.value))).toEqual([0, 12]);
  });

  it('leaves an UNKEYED channel as a static Node property (no animation for it)', () => {
    const body = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'body')!;
    // body.ty was never keyed -> the node carries a static y, and no KeyedProperty
    // targets body's y in any animation.
    expect(body.props[PROP.Y]).toBeDefined();
    for (const anim of d.animations) {
      const bodyKeyed = anim.objects.find((k) => k.objectId === body.index);
      const yProp = bodyKeyed?.props.find((p) => p.propertyKey === PROP.Y);
      expect(yProp).toBeUndefined();
    }
  });

  it('wires a custom cubic-bezier keyframe to a CubicEaseInterpolator', () => {
    const arm = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm')!;
    const wave = d.animations.find((a) => a.name === 'wave')!;
    const armRot = wave.objects.find((k) => k.objectId === arm.index)!
      .props.find((p) => p.propertyKey === PROP.ROTATION)!;
    // Easing lives on the ARRIVING key (index 1); Rive stores it on the LEAVING key
    // (index 0), which must reference a cubic interpolator.
    const leaving = armRot.keyframes[0];
    expect(leaving.interpType).toBe(2); // cubic
    expect(leaving.interpId).toBeGreaterThanOrEqual(0);
    const interp = d.objects.find((o) => o.typeKey === TYPE.CUBIC_INTERP && o.index === leaving.interpId)!;
    expect(interp).toBeTruthy();
    expect(Number(interp.props[PROP.X1])).toBeCloseTo(0.2, 5);
    expect(Number(interp.props[PROP.Y1])).toBeCloseTo(0.9, 5);
    expect(Number(interp.props[PROP.X2])).toBeCloseTo(0.7, 5);
    expect(Number(interp.props[PROP.Y2])).toBeCloseTo(0.1, 5);
    // The final key has no outgoing segment -> linear, no interpolator.
    expect(armRot.keyframes[1].interpType).toBe(1);
    expect(armRot.keyframes[1].interpId).toBe(-1);
    // Interpolators live in the artboard index space, before the animations.
    expect(leaving.interpId).toBeLessThan(d.objects.filter((o) => o.index >= 0).length);
  });

  it('is deterministic (identical input -> identical bytes)', () => {
    const a = exportRiv(pipDoc());
    const b = exportRiv(pipDoc());
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// ---- Artboard (P2c: optional page frame) ----

describe('exportRiv artboard', () => {
  it('a disabled artboard (garbage rect included) exports byte-identical to a doc with no artboard field at all', () => {
    const withoutField = exportRiv(pipDoc());
    const disabledDoc = pipDoc();
    // Nonsense values that would be very visible if they leaked in anywhere.
    disabledDoc.artboard = { enabled: false, x: 999, y: -999, w: 12345, h: 6789 };
    const withDisabled = exportRiv(disabledDoc);
    expect(Array.from(withDisabled)).toEqual(Array.from(withoutField));
  });

  it('an enabled artboard drives the Artboard width/height and shifts the root node origin by -x/-y', () => {
    const baseline = decodeRiv(exportRiv(pipDoc())); // viewBox-derived: origin (0,0)
    const doc = pipDoc();
    doc.artboard = { enabled: true, x: 10, y: -5, w: 300, h: 250 };
    const d = decodeRiv(exportRiv(doc));

    // Artboard sized to the artboard rect, not the (100x100) viewBox.
    expect(d.objects[1].typeKey).toBe(TYPE.ARTBOARD);
    expect(d.objects[1].props[PROP.WIDTH]).toBeCloseTo(300, 3);
    expect(d.objects[1].props[PROP.HEIGHT]).toBeCloseTo(250, 3);

    // Root node position = rootPivot - reference-frame origin. Baseline (viewBox
    // origin 0,0): rootPivot (50,80) unchanged. Artboard origin (10,-5): shifted.
    const baseRoot = baseline.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'pip root')!;
    expect(Number(baseRoot.props[PROP.X])).toBeCloseTo(50, 3);
    expect(Number(baseRoot.props[PROP.Y])).toBeCloseTo(80, 3);
    const root = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'pip root')!;
    expect(Number(root.props[PROP.X])).toBeCloseTo(50 - 10, 3);
    expect(Number(root.props[PROP.Y])).toBeCloseTo(80 - -5, 3);

    // Part-to-part node origins (pivot minus parent pivot/rootPivot, both in raw doc
    // space) are independent of the reference frame — the origin cancels — so they
    // must be untouched by the artboard shift.
    for (const name of ['body', 'arm']) {
      const base = baseline.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === name)!;
      const shifted = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === name)!;
      expect(Number(shifted.props[PROP.X])).toBeCloseTo(Number(base.props[PROP.X]), 3);
      expect(Number(shifted.props[PROP.Y])).toBeCloseTo(Number(base.props[PROP.Y]), 3);
    }
  });
});

// ---- Clip loop -> LinearAnimation loopValue (v2.12: loop moved off SMState onto Clip) ----

describe('exportRiv clip loop', () => {
  it('clip.loop absent or explicit true exports loopValue 1 (loop), byte-identical either way', () => {
    const withoutField = exportRiv(pipDoc());
    const explicitTrue = pipDoc();
    explicitTrue.clips = explicitTrue.clips.map((c) => ({ ...c, loop: true }));
    const withTrue = exportRiv(explicitTrue);
    expect(Array.from(withTrue)).toEqual(Array.from(withoutField));

    const d = decodeRiv(withoutField);
    expect(d.animations.every((a) => a.loop === 1)).toBe(true);
  });

  it('clip.loop === false exports loopValue 0 (oneShot) for that clip only', () => {
    const doc = pipDoc();
    doc.clips[1].loop = false; // 'wave' only — 'idle' stays default/looping
    const d = decodeRiv(exportRiv(doc));
    const idle = d.animations.find((a) => a.name === 'idle')!;
    const wave = d.animations.find((a) => a.name === 'wave')!;
    expect(idle.loop).toBe(1);
    expect(wave.loop).toBe(0);
  });
});

// ---- Draw order ----
//
// Rule pinned from rive-runtime/src/artboard.cpp: m_Drawables fills in file order,
// sortDrawOrder() sets m_FirstDrawable = LAST drawable in file order, and
// drawInternal() walks drawable->prev from there — so the FIRST drawable in the file
// is drawn LAST (topmost), like the Rive editor's layer panel. The studio's paint
// order is the opposite (doc.parts last = topmost; paths array last = topmost), so
// the exporter must emit shape clusters fully REVERSED.

describe('exportRiv draw order', () => {
  /** Pip-like stack: ground shadow (bottom), 3-path mid part, face (topmost). */
  function stackedDoc(): RigDoc {
    const shadow = part('p_shadow', {
      label: 'shadow',
      paths: [path('shadow_p', { fill: '#000000', fillOpacity: 0.307895 })],
    });
    const mid = part('p_mid', {
      label: 'mid',
      // Within-part paint order: m1 under m2 under m3 (app paints array order).
      paths: [path('m1'), path('m2'), path('m3')],
    });
    const face = part('p_face', { label: 'face', paths: [path('face_p')] });
    return {
      name: 'stack', viewBox: { x: 0, y: 0, w: 100, h: 100 },
      parts: [shadow, mid, face], rootPivot: { x: 50, y: 50 },
      clips: [{ name: 'idle', duration: 1000, tracks: [] }],
    };
  }

  const d = decodeRiv(exportRiv(stackedDoc()));
  const shapes = d.objects.filter((o) => o.typeKey === TYPE.SHAPE);
  const nodes = d.objects.filter((o) => o.typeKey === TYPE.NODE);

  it('emits all Nodes before all Shapes (parentIds stay backward-safe)', () => {
    const lastNodeIdx = Math.max(...nodes.map((n) => n.index));
    const firstShapeIdx = Math.min(...shapes.map((s) => s.index));
    expect(lastNodeIdx).toBeLessThan(firstShapeIdx);
  });

  it('emits shape clusters topmost-first: reversed parts, reversed paths per part', () => {
    // App paint order bottom->top: shadow_p, m1, m2, m3, face_p.
    // File order must be the reverse (first drawable in file = drawn topmost).
    expect(shapes.map((s) => s.props[PROP.NAME])).toEqual([
      'face_p', 'm3', 'm2', 'm1', 'shadow_p',
    ]);
    // The ground shadow is the LAST drawable in the file = drawn FIRST = under all.
    expect(shapes[shapes.length - 1].props[PROP.NAME]).toBe('shadow_p');
  });

  it('parents every shape to its own part node despite the reordering', () => {
    const nodeByName = new Map(nodes.map((n) => [n.props[PROP.NAME], n.index]));
    const expectParent = (shapeName: string, nodeName: string) => {
      const s = shapes.find((sh) => sh.props[PROP.NAME] === shapeName)!;
      expect(s.props[PROP.PARENT_ID]).toBe(nodeByName.get(nodeName));
    };
    expectParent('shadow_p', 'shadow');
    expectParent('m1', 'mid');
    expectParent('m2', 'mid');
    expectParent('m3', 'mid');
    expectParent('face_p', 'face');
  });

  it('keeps each shape cluster contiguous (Shape, then its paths/vertices/paints)', () => {
    // Between one Shape and the next, every component must belong to that shape's
    // cluster (PointsPath/vertex/Fill/Stroke/SolidColor parented within it).
    const comps = d.objects.filter((o) => o.index >= 0);
    for (let i = 0; i < comps.length; i++) {
      const o = comps[i];
      if (o.typeKey !== TYPE.SHAPE) continue;
      for (let j = i + 1; j < comps.length && comps[j].typeKey !== TYPE.SHAPE; j++) {
        const child = comps[j];
        if (child.typeKey === TYPE.CUBIC_INTERP) continue; // trailing interpolators
        // Walk parents back to the cluster's Shape.
        let p = Number(child.props[PROP.PARENT_ID]);
        while (p > 0 && comps.find((c) => c.index === p)!.typeKey !== TYPE.SHAPE) {
          p = Number(comps.find((c) => c.index === p)!.props[PROP.PARENT_ID]);
        }
        expect(p).toBe(o.index);
      }
    }
  });
});

// ---- State machines ----
//
// Nesting is by emission order (Rive's import stack is a typeKey-keyed map — each child
// attaches to the most-recent parent of the needed type). Index/enum ground truth pinned
// from rive-runtime dev/defs + src (see the exportRiv.ts header table).

/**
 * A doc with two parts (body + arm), two clips (A rotates the arm to 0, B to 60), and one
 * full state machine: 3 input types with defaults, entry/any/exit + 2 animation states,
 * transitions covering unconditional + a 400ms bool blend + every number op + a trigger
 * condition, and one listener firing two actions off the arm.
 */
function smDoc(): RigDoc {
  const body = part('p_body', { label: 'body', pivot: { x: 50, y: 50 }, paths: [path('body_path')] });
  const arm = part('p_arm', {
    label: 'arm', pivot: { x: 70, y: 40 }, parentId: 'p_body', paths: [path('arm_path')],
  });
  const clipA: Clip = {
    name: 'A', duration: 1000,
    tracks: [{ target: 'p_arm', channel: 'rotate', keyframes: [{ time: 0, value: 0, easing: 'linear' }] }],
  };
  const clipB: Clip = {
    name: 'B', duration: 1000,
    tracks: [{ target: 'p_arm', channel: 'rotate', keyframes: [{ time: 0, value: 60, easing: 'linear' }] }],
  };
  const machine: StateMachine = {
    id: 'sm1', name: 'Machine',
    inputs: [
      { id: 'i_b', name: 'b', type: 'bool', default: true },
      { id: 'i_n', name: 'n', type: 'number', default: 5 },
      { id: 'i_t', name: 't', type: 'trigger' },
    ],
    states: [
      { id: 's_entry', name: 'Entry', kind: 'entry' },
      { id: 's_any', name: 'Any', kind: 'any' },
      { id: 's_a', name: 'A', kind: 'animation', clipName: 'A' },
      { id: 's_b', name: 'B', kind: 'animation', clipName: 'B' },
      { id: 's_exit', name: 'Exit', kind: 'exit' },
    ],
    transitions: [
      // Unconditional entry -> A.
      { id: 't1', fromId: 's_entry', toId: 's_a', durationMs: 0, conditions: [] },
      // A -> B with a 400ms blend, gated on the bool being true.
      { id: 't2', fromId: 's_a', toId: 's_b', durationMs: 400, conditions: [{ inputId: 'i_b', op: '==', value: true }] },
      // B -> exit gated on every number op (ANDed) plus a bool notEqual (reduce test).
      {
        id: 't3', fromId: 's_b', toId: 's_exit', durationMs: 0,
        conditions: [
          { inputId: 'i_n', op: '==', value: 5 },
          { inputId: 'i_n', op: '!=', value: 0 },
          { inputId: 'i_n', op: '<=', value: 10 },
          { inputId: 'i_n', op: '>=', value: 1 },
          { inputId: 'i_n', op: '<', value: 100 },
          { inputId: 'i_n', op: '>', value: 0 },
          { inputId: 'i_b', op: '!=', value: true },
        ],
      },
      // Any -> A on a trigger (bare condition).
      { id: 't4', fromId: 's_any', toId: 's_a', durationMs: 0, conditions: [{ inputId: 'i_t' }] },
    ],
    listeners: [
      {
        id: 'l1', targetPartId: 'p_arm', event: 'down',
        actions: [
          { inputId: 'i_b', type: 'setBool', value: true },
          { inputId: 'i_t', type: 'fireTrigger' },
        ],
      },
    ],
  };
  return {
    name: 'sm', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [body, arm], rootPivot: { x: 50, y: 80 }, clips: [clipA, clipB],
    stateMachines: [machine],
  };
}

describe('exportRiv state machines', () => {
  const d = decodeRiv(exportRiv(smDoc()));
  const sm = d.stateMachines[0];

  it('emits exactly one named StateMachine', () => {
    expect(d.stateMachines.length).toBe(1);
    expect(sm.name).toBe('Machine');
  });

  it('does not consume artboard component indices for SM objects', () => {
    const smTypes = new Set([
      TYPE.STATE_MACHINE, TYPE.SM_LAYER, TYPE.SM_BOOL, TYPE.SM_NUMBER, TYPE.SM_TRIGGER,
      TYPE.ENTRY_STATE, TYPE.ANY_STATE, TYPE.EXIT_STATE, TYPE.ANIMATION_STATE,
      TYPE.STATE_TRANSITION, TYPE.TRANS_TRIGGER_COND, TYPE.TRANS_NUMBER_COND, TYPE.TRANS_BOOL_COND,
      TYPE.SM_LISTENER, TYPE.LISTENER_TRIGGER_CHANGE, TYPE.LISTENER_BOOL_CHANGE, TYPE.LISTENER_NUMBER_CHANGE,
    ]);
    for (const o of d.objects) {
      if (smTypes.has(o.typeKey)) expect(o.index).toBe(-1);
    }
  });

  it('emits the whole machine after all animations (component tree untouched)', () => {
    const firstSMPos = d.objects.findIndex((o) => o.typeKey === TYPE.STATE_MACHINE);
    const lastAnimPos = d.objects.map((o) => o.typeKey).lastIndexOf(TYPE.LINEAR_ANIM);
    expect(firstSMPos).toBeGreaterThan(lastAnimPos);
  });

  it('emits inputs in order with the right types and defaults', () => {
    expect(sm.inputs.map((i) => i.name)).toEqual(['b', 'n', 't']);
    expect(sm.inputs[0].typeKey).toBe(TYPE.SM_BOOL);
    expect(sm.inputs[0].value).toBe(1); // default true
    expect(sm.inputs[1].typeKey).toBe(TYPE.SM_NUMBER);
    expect(sm.inputs[1].value).toBeCloseTo(5, 5); // default 5
    expect(sm.inputs[2].typeKey).toBe(TYPE.SM_TRIGGER);
    expect(sm.inputs[2].value).toBeUndefined(); // triggers carry no value
  });

  it('emits entry/any/exit + 2 animation states in order', () => {
    expect(sm.states.map((s) => s.typeKey)).toEqual([
      TYPE.ENTRY_STATE, TYPE.ANY_STATE, TYPE.ANIMATION_STATE, TYPE.ANIMATION_STATE, TYPE.EXIT_STATE,
    ]);
  });

  it('resolves animationId to the right LinearAnimation (clip order)', () => {
    const sA = sm.states[2]; // plays clip 'A'
    const sB = sm.states[3]; // plays clip 'B'
    expect(sA.animationId).toBe(0);
    expect(sB.animationId).toBe(1);
    expect(d.animations[sA.animationId!].name).toBe('A');
    expect(d.animations[sB.animationId!].name).toBe('B');
    // Non-animation states carry no animationId.
    expect(sm.states[0].animationId).toBeUndefined();
    expect(sm.states[1].animationId).toBeUndefined();
    expect(sm.states[4].animationId).toBeUndefined();
  });

  it('nests each transition under its FROM state and targets the right state index', () => {
    const [entry, any, sA, sB, exit] = sm.states;
    // stateToId indices: entry0 any1 A2 B3 exit4.
    expect(entry.transitions.map((t) => t.stateToId)).toEqual([2]); // -> A
    expect(any.transitions.map((t) => t.stateToId)).toEqual([2]); // -> A
    expect(sA.transitions.map((t) => t.stateToId)).toEqual([3]); // -> B
    expect(sB.transitions.map((t) => t.stateToId)).toEqual([4]); // -> exit
    expect(exit.transitions.length).toBe(0);
  });

  it('emits duration in milliseconds with no percentage flag', () => {
    const aToB = sm.states[2].transitions[0];
    expect(aToB.duration).toBe(400); // literal ms, not a frame count or percentage
    // flags is never emitted (default 0 => DurationIsPercentage clear, exit-time off).
    for (const o of d.objects) {
      if (o.typeKey === TYPE.STATE_TRANSITION) expect(o.props[PROP.TRANS_FLAGS]).toBeUndefined();
    }
    // Unconditional / instant transitions omit duration entirely (default 0).
    expect(sm.states[0].transitions[0].duration).toBe(0);
  });

  it('emits an unconditional entry transition (no conditions)', () => {
    expect(sm.states[0].transitions[0].conditions).toEqual([]);
  });

  it('maps a bool == condition to the equal opValue via the expected-boolean reduce', () => {
    const cond = sm.states[2].transitions[0].conditions[0]; // b == true
    expect(cond.typeKey).toBe(TYPE.TRANS_BOOL_COND);
    expect(cond.inputId).toBe(0); // 'b' is input index 0
    expect(cond.op).toBe(0); // equal => expect true
    expect(cond.value).toBeUndefined(); // bool conditions store no compared value
  });

  it('maps every number op to its TransitionConditionOp enum value', () => {
    const conds = sm.states[3].transitions[0].conditions; // B -> exit
    const numberConds = conds.filter((c) => c.typeKey === TYPE.TRANS_NUMBER_COND);
    // Order: ==,!=,<=,>=,<,> => 0,1,2,3,4,5.
    expect(numberConds.map((c) => c.op)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(numberConds.every((c) => c.inputId === 1)).toBe(true); // 'n' is index 1
    expect(numberConds.map((c) => c.value)).toEqual([5, 0, 10, 1, 100, 0]);
    // The trailing bool `!= true` reduces to notEqual (expect false) => opValue 1.
    const boolCond = conds.find((c) => c.typeKey === TYPE.TRANS_BOOL_COND)!;
    expect(boolCond.op).toBe(1);
  });

  it('emits a bare trigger condition (inputId only)', () => {
    const cond = sm.states[1].transitions[0].conditions[0]; // any -> A on trigger t
    expect(cond.typeKey).toBe(TYPE.TRANS_TRIGGER_COND);
    expect(cond.inputId).toBe(2); // 't' is input index 2
    expect(cond.op).toBeUndefined();
    expect(cond.value).toBeUndefined();
  });

  it('exposes the op/listener enum maps the exporter uses', () => {
    expect(__riv.COND_OP).toEqual({ '==': 0, '!=': 1, '<=': 2, '>=': 3, '<': 4, '>': 5 });
    expect(__riv.LISTENER_TYPE).toEqual({ enter: 0, exit: 1, down: 2, up: 3 });
  });

  it('targets the listener at the part Node index and encodes the event type', () => {
    expect(sm.listeners.length).toBe(1);
    const listener = sm.listeners[0];
    const armNode = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm')!;
    expect(listener.targetId).toBe(armNode.index); // targetId = arm's Node component index
    expect(listener.listenerType).toBe(2); // 'down'
  });

  it('emits listener actions (setBool + fireTrigger) referencing inputs by index', () => {
    const actions = sm.listeners[0].actions;
    expect(actions.length).toBe(2);
    expect(actions[0].typeKey).toBe(TYPE.LISTENER_BOOL_CHANGE);
    expect(actions[0].inputId).toBe(0); // 'b'
    expect(actions[0].value).toBe(1); // set true
    expect(actions[1].typeKey).toBe(TYPE.LISTENER_TRIGGER_CHANGE);
    expect(actions[1].inputId).toBe(2); // 't'
    expect(actions[1].value).toBeUndefined();
  });

  it('every new SM property key is present in the ToC with the right backing type', () => {
    // A missing key would have made decoding throw; assert the backing types too.
    expect(d.tocTypes.get(PROP.SM_NAME)).toBe(1); // string
    expect(d.tocTypes.get(PROP.SM_BOOL_VALUE)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.SM_NUMBER_VALUE)).toBe(2); // double
    expect(d.tocTypes.get(PROP.ANIMATION_ID)).toBe(0);
    expect(d.tocTypes.get(PROP.STATE_TO_ID)).toBe(0);
    expect(d.tocTypes.get(PROP.COND_OP)).toBe(0);
    expect(d.tocTypes.get(PROP.COND_VALUE)).toBe(2);
    expect(d.tocTypes.get(PROP.TRANS_DURATION)).toBe(0);
    expect(d.tocTypes.get(PROP.LISTENER_TARGET_ID)).toBe(0);
    expect(d.tocTypes.get(PROP.LISTENER_TYPE)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.LISTENER_INPUT_ID)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.LISTENER_BOOL_VALUE)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.COND_INPUT_ID)).toBe(0); // uint
  });

  it('is deterministic (identical input -> identical bytes)', () => {
    expect(Array.from(exportRiv(smDoc()))).toEqual(Array.from(exportRiv(smDoc())));
  });
});

describe('exportRiv state machines: edge cases', () => {
  it('drops animation states with a dangling clipName and any transition touching them', () => {
    const base = smDoc();
    // Repoint state B at a clip that no longer exists.
    const machine = base.stateMachines![0];
    machine.states[3].clipName = 'GHOST';
    const d = decodeRiv(exportRiv(base));
    const sm = d.stateMachines[0];
    // Only entry/any/A/exit survive; the ghost B state is gone.
    expect(sm.states.map((s) => s.typeKey)).toEqual([
      TYPE.ENTRY_STATE, TYPE.ANY_STATE, TYPE.ANIMATION_STATE, TYPE.EXIT_STATE,
    ]);
    // A -> B (t2) is dropped because its target vanished; A has no outgoing transitions.
    expect(sm.states[2].transitions.length).toBe(0);
    // exit is now state index 3, and entry -> A still points at index 2.
    expect(sm.states[0].transitions[0].stateToId).toBe(2);
  });

  it('produces byte-identical output whether stateMachines is [] or absent', () => {
    const withEmpty = pipDoc();
    withEmpty.stateMachines = [];
    const withAbsent = pipDoc();
    delete withAbsent.stateMachines;
    expect(Array.from(exportRiv(withEmpty))).toEqual(Array.from(exportRiv(withAbsent)));
    // ...and identical to the canonical pipDoc() (which never sets the field).
    expect(Array.from(exportRiv(withEmpty))).toEqual(Array.from(exportRiv(pipDoc())));
  });

  it('skips a listener whose target part does not exist', () => {
    const base = smDoc();
    base.stateMachines![0].listeners[0].targetPartId = 'p_missing';
    const d = decodeRiv(exportRiv(base));
    expect(d.stateMachines[0].listeners.length).toBe(0);
  });
});

// ---- Exit time ----
//
// exitFraction (0..1 of the FROM clip) maps to Rive's percentage exit time: flags =
// EnableExitTime(4) | ExitTimeIsPercentage(8) = 12, exitTime = round(fraction*100).
// Pinned from rive-runtime dev/defs animation/state_transition.json (exitTime = key 160,
// flags = key 152) + include/rive/animation/state_transition_flags.hpp (bit values).

describe('exportRiv exit time', () => {
  /** smDoc() but with an exitFraction on the A→B transition (which leaves animation state A). */
  function exitDoc(frac: number | null): RigDoc {
    const base = smDoc();
    base.stateMachines![0].transitions.find((t) => t.id === 't2')!.exitFraction = frac;
    return base;
  }

  it('emits flags 12 (EnableExitTime|ExitTimeIsPercentage) and a percentage exitTime', () => {
    const d = decodeRiv(exportRiv(exitDoc(1)));
    const aToB = d.stateMachines[0].states[2].transitions[0]; // A's outgoing transition
    expect(aToB.flags).toBe(4 | 8); // 12
    expect(aToB.exitTime).toBe(100); // fraction 1.0 → 100%
    expect(aToB.duration).toBe(400); // the blend/mix ms is unaffected
  });

  it('rounds a partial exit fraction to a percentage', () => {
    const d = decodeRiv(exportRiv(exitDoc(0.5)));
    const aToB = d.stateMachines[0].states[2].transitions[0];
    expect(aToB.flags).toBe(12);
    expect(aToB.exitTime).toBe(50);
  });

  it('emits neither key without an exitFraction, and stays byte-identical to the pre-exit-time doc', () => {
    const d = decodeRiv(exportRiv(smDoc()));
    for (const o of d.objects) {
      if (o.typeKey === TYPE.STATE_TRANSITION) {
        expect(o.props[PROP.TRANS_FLAGS]).toBeUndefined();
        expect(o.props[PROP.TRANS_EXIT_TIME]).toBeUndefined();
      }
    }
    // An explicit null exitFraction emits nothing, so bytes match a doc that never set it.
    expect(Array.from(exportRiv(exitDoc(null)))).toEqual(Array.from(exportRiv(smDoc())));
  });

  it('ignores an exitFraction on a non-animation from-state (entry/any never emit exit time)', () => {
    const base = smDoc();
    // Force exit time onto the entry→A transition; the exporter must skip it.
    base.stateMachines![0].transitions.find((t) => t.id === 't1')!.exitFraction = 1;
    const d = decodeRiv(exportRiv(base));
    const entryTr = d.stateMachines[0].states[0].transitions[0];
    expect(entryTr.flags).toBeUndefined();
    expect(entryTr.exitTime).toBeUndefined();
  });

  it('is deterministic with exit time set', () => {
    expect(Array.from(exportRiv(exitDoc(1)))).toEqual(Array.from(exportRiv(exitDoc(1))));
  });

  it('registers exitTime/flags in the ToC as uint backing types', () => {
    const d = decodeRiv(exportRiv(exitDoc(1)));
    expect(d.tocTypes.get(PROP.TRANS_FLAGS)).toBe(0); // uint
    expect(d.tocTypes.get(PROP.TRANS_EXIT_TIME)).toBe(0); // uint
  });
});

// ---- Unified Skeleton (Phase 1): cross-chain bone attachment ----
//
// A bone exports as a plain Node in the parentId hierarchy either way — `attachedRoot`
// is purely an EDITOR-side chain-resolution boundary (auto-bind targeting, the no-gap
// invariant); the exporter has no concept of it and needs no change. This just confirms
// a doc carrying the flag still exports cleanly and the attached bone's Node parents to
// the bone it was dropped onto, exactly like any other bone-to-bone parentId link.
describe('exportRiv Unified Skeleton attachment (Phase 1)', () => {
  function attachedDoc(): RigDoc {
    const spine = part('p_spine', {
      kind: 'bone', label: 'spine', pivot: { x: 50, y: 20 }, boneTip: { x: 50, y: 40 },
    });
    const armRoot = part('p_arm_root', {
      kind: 'bone', label: 'arm_root', pivot: { x: 70, y: 40 }, boneTip: { x: 90, y: 40 },
      parentId: 'p_spine', attachedRoot: true,
      // A loose offset — NOT sitting at the spine bone's tip (50,40) — is the whole
      // point of the flag; the exporter must not care either way.
      rest: { rotate: 4, tx: 6, ty: 2, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    });
    return {
      name: 'attach_test', viewBox: { x: 0, y: 0, w: 100, h: 100 },
      parts: [spine, armRoot], rootPivot: { x: 50, y: 80 },
      clips: [{ name: 'idle', duration: 1000, tracks: [] }],
    };
  }

  it('exports without error', () => {
    expect(() => exportRiv(attachedDoc())).not.toThrow();
  });

  it("parents the attached bone's Node to the bone it was cross-chain attached onto", () => {
    const d = decodeRiv(exportRiv(attachedDoc()));
    const spineNode = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'spine')!;
    const armNode = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'arm_root')!;
    expect(spineNode).toBeTruthy();
    expect(armNode).toBeTruthy();
    expect(armNode.props[PROP.PARENT_ID]).toBe(spineNode.index);
  });
});

// ---- Export-completions wave (2026-07-13): hidden-part exclusion, opacity keys, z draw order ----

describe('exportRiv hidden-part exclusion (Layers eye, FULL — completes the shapes-only skip)', () => {
  function hiddenDoc(): RigDoc {
    const body = part('p_body', { label: 'body', paths: [path('body_path')] });
    const shadow = part('p_shadow', { label: 'shadow', hidden: true, paths: [path('shadow_path')] });
    // A child of a HIDDEN part is itself effectively hidden (cascades) even though its own
    // `hidden` flag is unset — must ALSO be fully excluded.
    const shadowChild = part('p_shadow_child', {
      label: 'shadow_child', parentId: 'p_shadow', paths: [path('shadow_child_path')],
    });
    const clip: Clip = {
      name: 'idle', duration: 1000,
      tracks: [
        { target: 'p_shadow', channel: 'rotate', keyframes: [{ time: 0, value: 10, easing: 'linear' }] },
        { target: 'p_shadow_child', channel: 'tx', keyframes: [{ time: 0, value: 5, easing: 'linear' }] },
        { target: 'p_body', channel: 'tx', keyframes: [{ time: 0, value: 3, easing: 'linear' }] },
      ],
    };
    return {
      name: 'hid', viewBox: { x: 0, y: 0, w: 100, h: 100 },
      parts: [body, shadow, shadowChild], rootPivot: { x: 50, y: 50 }, clips: [clip],
      stateMachines: [{
        id: 'sm1', name: 'M', inputs: [],
        states: [
          { id: 's_entry', name: 'Entry', kind: 'entry' },
          { id: 's_any', name: 'Any', kind: 'any' },
          { id: 's_exit', name: 'Exit', kind: 'exit' },
        ],
        transitions: [],
        listeners: [{ id: 'l1', targetPartId: 'p_shadow', event: 'down', actions: [] }],
      }],
    };
  }

  const d = decodeRiv(exportRiv(hiddenDoc()));

  it('emits no Node for a hidden part or its (effectively hidden) descendants', () => {
    const names = d.objects.filter((o) => o.typeKey === TYPE.NODE).map((o) => o.props[PROP.NAME]);
    expect(names).toContain('body');
    expect(names).not.toContain('shadow');
    expect(names).not.toContain('shadow_child');
  });

  it('emits no Shape for a hidden part or its descendants (the pre-existing skip, still correct)', () => {
    const shapes = d.objects.filter((o) => o.typeKey === TYPE.SHAPE);
    expect(shapes.length).toBe(1);
    expect(shapes[0].props[PROP.NAME]).toBe('body_path');
  });

  it('drops every keyed track targeting an excluded part — only body.tx survives', () => {
    const validIds = new Set(d.objects.filter((o) => o.index >= 0).map((o) => o.index));
    const allProps = d.animations.flatMap((a) => a.objects.flatMap((ko) => {
      expect(validIds.has(ko.objectId)).toBe(true); // no KeyedObject dangles on a dropped Node
      return ko.props;
    }));
    expect(allProps.length).toBe(1);
    expect(allProps[0].propertyKey).toBe(PROP.X); // body's keyed tx
  });

  it('drops a state-machine listener targeting a hidden part', () => {
    expect(d.stateMachines[0].listeners.length).toBe(0);
  });

  it('exports cleanly and deterministically', () => {
    expect(() => exportRiv(hiddenDoc())).not.toThrow();
    expect(Array.from(exportRiv(hiddenDoc()))).toEqual(Array.from(exportRiv(hiddenDoc())));
  });
});

describe('exportRiv opacity keys (part-level, non-cascading)', () => {
  function opacityDoc(restOpacity: number, keyed: boolean): RigDoc {
    const body = part('p_body', {
      label: 'body',
      rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: restOpacity },
      paths: [path('body_path', { stroke: '#000000', strokeWidth: 2, strokeOpacity: 0.8 })],
    });
    const clip: Clip = {
      name: 'idle', duration: 1000,
      tracks: keyed
        ? [{
          target: 'p_body', channel: 'opacity',
          keyframes: [
            { time: 0, value: 1, easing: 'linear' },
            { time: 500, value: 0, easing: 'linear' },
          ],
        }]
        : [],
    };
    return {
      name: 'op', viewBox: { x: 0, y: 0, w: 100, h: 100 },
      parts: [body], rootPivot: { x: 50, y: 50 }, clips: [clip],
    };
  }

  it('folds an UNKEYED rest opacity multiplicatively into the static Fill/Stroke alpha', () => {
    const d = decodeRiv(exportRiv(opacityDoc(0.5, false)));
    const colors = d.objects.filter((o) => o.typeKey === TYPE.SOLID_COLOR);
    const alphas = colors.map((c) => (c.props[PROP.COLOR] as number) >>> 24);
    expect(alphas).toContain(Math.round(1 * 0.5 * 255)); // fill: fillOpacity(1) * restOpacity(0.5)
    expect(alphas).toContain(Math.round(0.8 * 0.5 * 255)); // stroke: strokeOpacity(0.8) * restOpacity(0.5)
  });

  it('rest.opacity=1 (the default) reproduces the exact pre-wave alpha — no regression', () => {
    const d = decodeRiv(exportRiv(opacityDoc(1, false)));
    const fillColor = d.objects.find(
      (o) => o.typeKey === TYPE.SOLID_COLOR && (o.props[PROP.COLOR] as number) >>> 0 === (__riv.argb('#3366cc', 1) >>> 0),
    );
    expect(fillColor).toBeTruthy();
  });

  it('a KEYED opacity channel animates each SolidColor via KeyFrameColor — never Node.opacity', () => {
    const d = decodeRiv(exportRiv(opacityDoc(1, true)));
    const body = d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'body')!;
    const idle = d.animations[0];
    expect(idle.objects.map((o) => o.objectId)).not.toContain(body.index);

    const colors = d.objects.filter((o) => o.typeKey === TYPE.SOLID_COLOR);
    expect(colors.length).toBe(2); // fill (base opacity 1) + stroke (base opacity 0.8)
    const baseOpacities = [1, 0.8]; // emission order: Fill's SolidColor, then Stroke's
    colors.forEach((c, i) => {
      const keyed = idle.objects.find((o) => o.objectId === c.index)!;
      expect(keyed).toBeTruthy();
      const prop = keyed.props.find((p) => p.propertyKey === PROP.COLOR)!;
      expect(prop.keyframes.map((k) => k.frame)).toEqual([0, 30]); // 0ms, 500ms@60fps
      // frame 0: part opacity 1 -> alpha = base * 1. frame 30: part opacity 0 -> alpha 0.
      expect(prop.keyframes[0].value >>> 24).toBe(Math.round(baseOpacities[i] * 255));
      expect(prop.keyframes[1].value >>> 24).toBe(0);
    });
  });

  it('a clip that never keys opacity leaves the SolidColor unkeyed (rest fold stands)', () => {
    const doc = opacityDoc(1, true);
    doc.clips.push({ name: 'still', duration: 500, tracks: [] });
    const d = decodeRiv(exportRiv(doc));
    const stillAnim = d.animations.find((a) => a.name === 'still')!;
    expect(stillAnim.objects.length).toBe(0);
  });

  it('is deterministic', () => {
    expect(Array.from(exportRiv(opacityDoc(0.5, true)))).toEqual(Array.from(exportRiv(opacityDoc(0.5, true))));
  });
});

describe('exportRiv keyed draw order (z via DrawRules/DrawTarget)', () => {
  /** doc.parts order A,B,C -> default paint order A(back) B C(front/topmost). */
  function zDoc(): RigDoc {
    const a = part('p_a', { label: 'A', paths: [path('a_p')] });
    const b = part('p_b', { label: 'B', paths: [path('b_p')] });
    const c = part('p_c', { label: 'C', paths: [path('c_p')] });
    const clip: Clip = {
      name: 'reorder', duration: 1000,
      tracks: [{
        target: 'p_b', channel: 'z',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: 100, easing: 'linear' },
        ],
      }],
    };
    return {
      name: 'zdoc', viewBox: { x: 0, y: 0, w: 100, h: 100 },
      parts: [a, b, c], rootPivot: { x: 50, y: 50 }, clips: [clip],
    };
  }

  const d = decodeRiv(exportRiv(zDoc()));
  const nodeByName = (n: string) => d.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === n)!;
  const shapeByName = (n: string) => d.objects.find((o) => o.typeKey === TYPE.SHAPE && o.props[PROP.NAME] === n)!;

  it("emits exactly one DrawRules, parented to the z-keyed part's own Node", () => {
    const rules = d.objects.filter((o) => o.typeKey === TYPE.DRAW_RULES);
    expect(rules.length).toBe(1);
    expect(rules[0].props[PROP.PARENT_ID]).toBe(nodeByName('B').index);
  });

  it('emits two DrawTargets (one per resolved instant), both anchored on C, opposite placements', () => {
    const rulesIdx = d.objects.find((o) => o.typeKey === TYPE.DRAW_RULES)!.index;
    const targets = d.objects.filter((o) => o.typeKey === TYPE.DRAW_TARGET);
    expect(targets.length).toBe(2);
    for (const t of targets) {
      expect(t.props[PROP.PARENT_ID]).toBe(rulesIdx);
      expect(t.props[PROP.DRAWABLE_ID]).toBe(shapeByName('c_p').index);
    }
    expect(targets.map((t) => t.props[PROP.PLACEMENT_VALUE]).sort()).toEqual([0, 1]);
  });

  it('keys drawTargetId with a KeyFrameId per instant, switching to the right anchor placement', () => {
    const rulesIdx = d.objects.find((o) => o.typeKey === TYPE.DRAW_RULES)!.index;
    const anim = d.animations.find((a) => a.name === 'reorder')!;
    const keyed = anim.objects.find((o) => o.objectId === rulesIdx)!;
    const prop = keyed.props.find((p) => p.propertyKey === PROP.DRAW_TARGET_ID)!;
    expect(prop.keyframes.map((k) => k.frame)).toEqual([0, 30]);

    const targets = d.objects.filter((o) => o.typeKey === TYPE.DRAW_TARGET);
    const afterTarget = targets.find((t) => t.props[PROP.PLACEMENT_VALUE] === 1)!; // behind C
    const beforeTarget = targets.find((t) => t.props[PROP.PLACEMENT_VALUE] === 0)!; // in front of C

    // t=0: z=0 ties the unkeyed default (order stays [A,B,C]) -> B's front neighbor C is
    // static -> anchors AFTER C, i.e. exactly its original spot (byte-stable-looking rest).
    expect(prop.keyframes[0].value).toBe(afterTarget.index);
    // t=500ms(frame30): B jumps to z=100 (topmost) -> back neighbor C is static -> anchors
    // BEFORE C (B now renders in front of C).
    expect(prop.keyframes[1].value).toBe(beforeTarget.index);
  });

  it('emits none of the draw-order machinery for a doc with no z keyframes (zero overhead)', () => {
    const clean = decodeRiv(exportRiv(pipDoc()));
    const drawTypes = new Set([TYPE.DRAW_RULES, TYPE.DRAW_TARGET, TYPE.KEYFRAME_ID]);
    expect(clean.objects.some((o) => drawTypes.has(o.typeKey))).toBe(false);
  });

  it('skips machinery for a z-keyed part with an unguarded shape-owning descendant (documented limit)', () => {
    const doc = zDoc();
    // A non-z-keyed child with its own Shape would otherwise leak into B's reordering
    // (Rive's ancestor walk has nothing closer to stop at) — the exporter skips instead.
    doc.parts.push(part('p_b_child', { label: 'B_child', parentId: 'p_b', paths: [path('bc_p')] }));
    const dd = decodeRiv(exportRiv(doc));
    expect(dd.objects.some((o) => o.typeKey === TYPE.DRAW_RULES)).toBe(false);
    // The doc still exports cleanly; the child renders normally, parented under B.
    const child = dd.objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === 'B_child');
    expect(child).toBeTruthy();
  });

  it('is deterministic', () => {
    expect(Array.from(exportRiv(zDoc()))).toEqual(Array.from(exportRiv(zDoc())));
  });
});
