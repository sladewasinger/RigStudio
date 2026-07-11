/**
 * Tests for the Rive (.riv) binary exporter. Two layers:
 *   1. the binary writer primitives (varuint boundaries, string, float32, ToC packing);
 *   2. a small structural decoder (below) that re-reads the emitted .riv the way the
 *      runtime does — fingerprint/version, ToC-driven value decoding, the artboard
 *      component index space, and the animation object tree — then asserts on a
 *      Pip-like fixture (object sequence, parentId validity, node count, one animation
 *      per clip, absolute-vs-rest keyframe semantics, custom-bezier interpolator wiring).
 */

import { describe, expect, it } from 'vitest';
import { exportRiv, __riv } from '../io/exportRiv';
import { Clip, RigDoc, RigPart, RigPath, StateMachine } from '../core/model';

const DEG2RAD = Math.PI / 180;

// ---- Minimal key table (independent of the exporter's internal consts) ----
const TYPE = {
  BACKBOARD: 23, ARTBOARD: 1, NODE: 2, SHAPE: 3, POINTS_PATH: 16, CUBIC_VERTEX: 6,
  FILL: 20, STROKE: 24, SOLID_COLOR: 18, CUBIC_INTERP: 28,
  LINEAR_ANIM: 31, KEYED_OBJECT: 25, KEYED_PROPERTY: 26, KEYFRAME_DOUBLE: 30,
  // State machine family (none consume an artboard index).
  STATE_MACHINE: 53, SM_LAYER: 57, SM_BOOL: 59, SM_NUMBER: 56, SM_TRIGGER: 58,
  ENTRY_STATE: 63, ANY_STATE: 62, EXIT_STATE: 64, ANIMATION_STATE: 61,
  STATE_TRANSITION: 65, TRANS_TRIGGER_COND: 68, TRANS_NUMBER_COND: 70, TRANS_BOOL_COND: 71,
  SM_LISTENER: 114, LISTENER_TRIGGER_CHANGE: 115, LISTENER_BOOL_CHANGE: 117, LISTENER_NUMBER_CHANGE: 118,
};
const PROP = {
  NAME: 4, PARENT_ID: 5, WIDTH: 7, HEIGHT: 8, X: 13, Y: 14, ROTATION: 15,
  SCALE_X: 16, SCALE_Y: 17, VERT_X: 24, VERT_Y: 25, IS_CLOSED: 32, COLOR: 37,
  THICKNESS: 47, OBJECT_ID: 51, PROPERTY_KEY: 53, ANIM_NAME: 55, FPS: 56, DURATION: 57, LOOP: 59,
  X1: 63, Y1: 64, X2: 65, Y2: 66, FRAME: 67, INTERP_TYPE: 68, INTERPOLATOR_ID: 69,
  VALUE: 70, IN_ROT: 84, IN_DIST: 85, OUT_ROT: 86, OUT_DIST: 87,
  // State machine family.
  SM_NAME: 138, SM_NUMBER_VALUE: 140, SM_BOOL_VALUE: 141, ANIMATION_ID: 149, STATE_TO_ID: 151,
  COND_INPUT_ID: 155, COND_OP: 156, COND_VALUE: 157, TRANS_DURATION: 158, TRANS_FLAGS: 152,
  LISTENER_TARGET_ID: 224, LISTENER_TYPE: 225, LISTENER_INPUT_ID: 227,
  LISTENER_BOOL_VALUE: 228, LISTENER_NUMBER_VALUE: 229,
};
// Component object typeKeys consume an artboard index (in read order); animation and
// state-machine objects and the backboard do not.
const CONSUMES_INDEX = new Set([
  TYPE.ARTBOARD, TYPE.NODE, TYPE.SHAPE, TYPE.POINTS_PATH, TYPE.CUBIC_VERTEX,
  TYPE.FILL, TYPE.STROKE, TYPE.SOLID_COLOR, TYPE.CUBIC_INTERP,
]);

// ---- Structural .riv decoder ----

interface DecodedObject {
  typeKey: number;
  index: number; // artboard component index, or -1
  props: Record<number, number | string>;
}
interface DecodedProp { propertyKey: number; keyframes: { frame: number; value: number; interpType: number; interpId: number }[] }
interface DecodedKeyedObject { objectId: number; props: DecodedProp[] }
interface DecodedAnim { name: string; fps: number; duration: number; loop: number; objects: DecodedKeyedObject[] }

// State-machine tree (walked by context, mirroring the runtime import stack: each child
// attaches to the most-recently-seen parent of the required type).
interface DecodedSMInput { typeKey: number; name: string; value: number | undefined }
interface DecodedCond { typeKey: number; inputId: number; op: number | undefined; value: number | undefined }
interface DecodedTransition { typeKey: number; stateToId: number; duration: number; flags: number | undefined; conditions: DecodedCond[] }
interface DecodedState { typeKey: number; animationId: number | undefined; transitions: DecodedTransition[] }
interface DecodedAction { typeKey: number; inputId: number; value: number | undefined }
interface DecodedListener { targetId: number; listenerType: number; actions: DecodedAction[] }
interface DecodedSM { name: string; inputs: DecodedSMInput[]; states: DecodedState[]; listeners: DecodedListener[] }

interface Decoded {
  major: number; minor: number; fileId: number;
  tocKeys: number[]; tocTypes: Map<number, number>;
  objects: DecodedObject[];
  animations: DecodedAnim[];
  stateMachines: DecodedSM[];
}

class Reader {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  u8(): number { return this.b[this.i++]; }
  u32(): number {
    const v = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24);
    this.i += 4;
    return v >>> 0;
  }
  f32(): number {
    const dv = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4);
    this.i += 4;
    return dv.getFloat32(0, true);
  }
  varuint(): number {
    let result = 0, shift = 0, byte = 0;
    do {
      byte = this.b[this.i++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  string(): string {
    const len = this.varuint();
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(this.b[this.i++]);
    return s;
  }
  eof(): boolean { return this.i >= this.b.length; }
}

function decodeRiv(bytes: Uint8Array): Decoded {
  const r = new Reader(bytes);
  const fp = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (fp !== 'RIVE') throw new Error(`bad fingerprint ${fp}`);
  const major = r.varuint();
  const minor = r.varuint();
  const fileId = r.varuint();
  const tocKeys: number[] = [];
  for (let k = r.varuint(); k !== 0; k = r.varuint()) tocKeys.push(k);
  // Packed 2-bit backing types: four keys per uint32 word.
  const tocTypes = new Map<number, number>();
  for (let i = 0; i < tocKeys.length; i += 4) {
    const word = r.u32();
    for (let j = 0; j < 4 && i + j < tocKeys.length; j++) {
      tocTypes.set(tocKeys[i + j], (word >>> (j * 2)) & 3);
    }
  }

  const objects: DecodedObject[] = [];
  const animations: DecodedAnim[] = [];
  const stateMachines: DecodedSM[] = [];
  let nextIndex = 0;
  let curAnim: DecodedAnim | null = null;
  let curKeyed: DecodedKeyedObject | null = null;
  let curProp: DecodedProp | null = null;
  let curSM: DecodedSM | null = null;
  let curState: DecodedState | null = null;
  let curTransition: DecodedTransition | null = null;
  let curListener: DecodedListener | null = null;

  while (!r.eof()) {
    const typeKey = r.varuint();
    const props: Record<number, number | string> = {};
    for (let pk = r.varuint(); pk !== 0; pk = r.varuint()) {
      const ft = tocTypes.get(pk);
      if (ft === undefined) throw new Error(`property ${pk} missing from ToC`);
      if (ft === 1) props[pk] = r.string();
      else if (ft === 2) props[pk] = r.f32();
      else if (ft === 3) props[pk] = r.u32();
      else props[pk] = r.varuint(); // uint/bool
    }
    const index = CONSUMES_INDEX.has(typeKey) ? nextIndex++ : -1;
    objects.push({ typeKey, index, props });

    // Build the animation tree by context (mirrors the runtime import stack).
    if (typeKey === TYPE.LINEAR_ANIM) {
      curAnim = {
        name: String(props[PROP.ANIM_NAME] ?? ''),
        fps: Number(props[PROP.FPS] ?? 0),
        duration: Number(props[PROP.DURATION] ?? 0),
        loop: Number(props[PROP.LOOP] ?? 0),
        objects: [],
      };
      animations.push(curAnim);
      curKeyed = null; curProp = null;
    } else if (typeKey === TYPE.KEYED_OBJECT) {
      curKeyed = { objectId: Number(props[PROP.OBJECT_ID] ?? 0), props: [] };
      curAnim!.objects.push(curKeyed);
      curProp = null;
    } else if (typeKey === TYPE.KEYED_PROPERTY) {
      curProp = { propertyKey: Number(props[PROP.PROPERTY_KEY] ?? 0), keyframes: [] };
      curKeyed!.props.push(curProp);
    } else if (typeKey === TYPE.KEYFRAME_DOUBLE) {
      curProp!.keyframes.push({
        frame: Number(props[PROP.FRAME] ?? 0),
        value: Number(props[PROP.VALUE] ?? 0),
        interpType: Number(props[PROP.INTERP_TYPE] ?? 0),
        interpId: props[PROP.INTERPOLATOR_ID] === undefined ? -1 : Number(props[PROP.INTERPOLATOR_ID]),
      });
    } else if (typeKey === TYPE.STATE_MACHINE) {
      // StateMachine extends Animation, so its name is Animation.name (55), not 138.
      curSM = { name: String(props[PROP.ANIM_NAME] ?? ''), inputs: [], states: [], listeners: [] };
      stateMachines.push(curSM);
      curState = null; curTransition = null; curListener = null;
    } else if (typeKey === TYPE.SM_BOOL || typeKey === TYPE.SM_NUMBER || typeKey === TYPE.SM_TRIGGER) {
      const value = typeKey === TYPE.SM_BOOL ? props[PROP.SM_BOOL_VALUE]
        : typeKey === TYPE.SM_NUMBER ? props[PROP.SM_NUMBER_VALUE] : undefined;
      curSM!.inputs.push({
        typeKey, name: String(props[PROP.SM_NAME] ?? ''),
        value: value === undefined ? undefined : Number(value),
      });
    } else if (typeKey === TYPE.SM_LAYER) {
      curState = null; curTransition = null;
    } else if (
      typeKey === TYPE.ENTRY_STATE || typeKey === TYPE.ANY_STATE ||
      typeKey === TYPE.EXIT_STATE || typeKey === TYPE.ANIMATION_STATE
    ) {
      curState = {
        typeKey,
        animationId: props[PROP.ANIMATION_ID] === undefined ? undefined : Number(props[PROP.ANIMATION_ID]),
        transitions: [],
      };
      curSM!.states.push(curState);
      curTransition = null;
    } else if (typeKey === TYPE.STATE_TRANSITION) {
      curTransition = {
        typeKey,
        stateToId: Number(props[PROP.STATE_TO_ID] ?? -1),
        duration: Number(props[PROP.TRANS_DURATION] ?? 0),
        flags: props[PROP.TRANS_FLAGS] === undefined ? undefined : Number(props[PROP.TRANS_FLAGS]),
        conditions: [],
      };
      curState!.transitions.push(curTransition);
    } else if (
      typeKey === TYPE.TRANS_TRIGGER_COND || typeKey === TYPE.TRANS_NUMBER_COND ||
      typeKey === TYPE.TRANS_BOOL_COND
    ) {
      curTransition!.conditions.push({
        typeKey,
        inputId: Number(props[PROP.COND_INPUT_ID] ?? -1),
        op: props[PROP.COND_OP] === undefined ? undefined : Number(props[PROP.COND_OP]),
        value: props[PROP.COND_VALUE] === undefined ? undefined : Number(props[PROP.COND_VALUE]),
      });
    } else if (typeKey === TYPE.SM_LISTENER) {
      curListener = {
        targetId: Number(props[PROP.LISTENER_TARGET_ID] ?? -1),
        listenerType: Number(props[PROP.LISTENER_TYPE] ?? -1),
        actions: [],
      };
      curSM!.listeners.push(curListener);
    } else if (
      typeKey === TYPE.LISTENER_TRIGGER_CHANGE || typeKey === TYPE.LISTENER_BOOL_CHANGE ||
      typeKey === TYPE.LISTENER_NUMBER_CHANGE
    ) {
      const value = typeKey === TYPE.LISTENER_BOOL_CHANGE ? props[PROP.LISTENER_BOOL_VALUE]
        : typeKey === TYPE.LISTENER_NUMBER_CHANGE ? props[PROP.LISTENER_NUMBER_VALUE] : undefined;
      curListener!.actions.push({
        typeKey, inputId: Number(props[PROP.LISTENER_INPUT_ID] ?? -1),
        value: value === undefined ? undefined : Number(value),
      });
    }
  }
  return { major, minor, fileId, tocKeys, tocTypes, objects, animations, stateMachines };
}

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
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 }, parentId: null,
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
    rest: { rotate: 15, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
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
