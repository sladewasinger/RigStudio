/**
 * Standalone ToC-aware .riv decoder that re-reads an exported .riv the way the runtime
 * does — fingerprint/version, ToC-driven value decoding, the artboard component index
 * space, and the animation/state-machine object trees — for structural assertions in
 * `exportRiv.test.ts` (and reusable for future headless-package tests, e.g. H1).
 * Independent of the exporter's internal consts by design (a separate, hand-pinned key
 * table below) so the decoder can't accidentally agree with a broken exporter.
 */

// ---- Minimal key table (independent of the exporter's internal consts) ----
export const TYPE = {
  BACKBOARD: 23, ARTBOARD: 1, NODE: 2, SHAPE: 3, POINTS_PATH: 16, CUBIC_VERTEX: 6,
  FILL: 20, STROKE: 24, SOLID_COLOR: 18, CUBIC_INTERP: 28,
  LINEAR_ANIM: 31, KEYED_OBJECT: 25, KEYED_PROPERTY: 26, KEYFRAME_DOUBLE: 30,
  // Draw order (.riv export completions wave).
  DRAW_TARGET: 48, DRAW_RULES: 49, KEYFRAME_COLOR: 37, KEYFRAME_ID: 50,
  // Skeletal deformation (skinned-part export wave): bones + skin family.
  BONE: 40, ROOT_BONE: 41, SKIN: 43, TENDON: 44, WEIGHT: 45, CUBIC_WEIGHT: 46,
  // State machine family (none consume an artboard index).
  STATE_MACHINE: 53, SM_LAYER: 57, SM_BOOL: 59, SM_NUMBER: 56, SM_TRIGGER: 58,
  ENTRY_STATE: 63, ANY_STATE: 62, EXIT_STATE: 64, ANIMATION_STATE: 61,
  STATE_TRANSITION: 65, TRANS_TRIGGER_COND: 68, TRANS_NUMBER_COND: 70, TRANS_BOOL_COND: 71,
  SM_LISTENER: 114, LISTENER_TRIGGER_CHANGE: 115, LISTENER_BOOL_CHANGE: 117, LISTENER_NUMBER_CHANGE: 118,
};
export const PROP = {
  NAME: 4, PARENT_ID: 5, WIDTH: 7, HEIGHT: 8, X: 13, Y: 14, ROTATION: 15,
  SCALE_X: 16, SCALE_Y: 17, VERT_X: 24, VERT_Y: 25, IS_CLOSED: 32, COLOR: 37,
  THICKNESS: 47, OBJECT_ID: 51, PROPERTY_KEY: 53, ANIM_NAME: 55, FPS: 56, DURATION: 57, LOOP: 59,
  X1: 63, Y1: 64, X2: 65, Y2: 66, FRAME: 67, INTERP_TYPE: 68, INTERPOLATOR_ID: 69,
  VALUE: 70, IN_ROT: 84, IN_DIST: 85, OUT_ROT: 86, OUT_DIST: 87,
  KEYFRAME_COLOR_VALUE: 88, DRAWABLE_ID: 119, PLACEMENT_VALUE: 120, DRAW_TARGET_ID: 121,
  KEYFRAME_ID_VALUE: 122,
  // Skeletal deformation. Matrix property-key order is xx,yx,xy,yy (dev/defs
  // bones/tendon.json + skin.json — NOT xx,xy,...).
  BONE_LENGTH: 89, ROOT_BONE_X: 90, ROOT_BONE_Y: 91,
  TENDON_BONE_ID: 95, TENDON_XX: 96, TENDON_YX: 97, TENDON_XY: 98, TENDON_YY: 99,
  TENDON_TX: 100, TENDON_TY: 101,
  WEIGHT_VALUES: 102, WEIGHT_INDICES: 103,
  SKIN_XX: 104, SKIN_YX: 105, SKIN_XY: 106, SKIN_YY: 107, SKIN_TX: 108, SKIN_TY: 109,
  WEIGHT_IN_VALUES: 110, WEIGHT_IN_INDICES: 111, WEIGHT_OUT_VALUES: 112, WEIGHT_OUT_INDICES: 113,
  // State machine family.
  SM_NAME: 138, SM_NUMBER_VALUE: 140, SM_BOOL_VALUE: 141, ANIMATION_ID: 149, STATE_TO_ID: 151,
  COND_INPUT_ID: 155, COND_OP: 156, COND_VALUE: 157, TRANS_DURATION: 158, TRANS_FLAGS: 152,
  TRANS_EXIT_TIME: 160,
  LISTENER_TARGET_ID: 224, LISTENER_TYPE: 225, LISTENER_INPUT_ID: 227,
  LISTENER_BOOL_VALUE: 228, LISTENER_NUMBER_VALUE: 229,
};
// Component object typeKeys consume an artboard index (in read order); animation and
// state-machine objects and the backboard do not. DrawRules/DrawTarget DO consume one
// (they're plain artboard components, per draw_rules.json/draw_target.json — see
// io/riv/drawRules.ts's header) but KeyFrameId/KeyFrameColor, like KeyFrameDouble, don't.
export const CONSUMES_INDEX = new Set([
  TYPE.ARTBOARD, TYPE.NODE, TYPE.SHAPE, TYPE.POINTS_PATH, TYPE.CUBIC_VERTEX,
  TYPE.FILL, TYPE.STROKE, TYPE.SOLID_COLOR, TYPE.CUBIC_INTERP,
  TYPE.DRAW_TARGET, TYPE.DRAW_RULES,
  // The whole skeletal family are plain artboard components.
  TYPE.BONE, TYPE.ROOT_BONE, TYPE.SKIN, TYPE.TENDON, TYPE.WEIGHT, TYPE.CUBIC_WEIGHT,
]);

// ---- Structural .riv decoder ----

export interface DecodedObject {
  typeKey: number;
  index: number; // artboard component index, or -1
  props: Record<number, number | string>;
}
export interface DecodedProp { propertyKey: number; keyframes: { frame: number; value: number; interpType: number; interpId: number }[] }
export interface DecodedKeyedObject { objectId: number; props: DecodedProp[] }
export interface DecodedAnim { name: string; fps: number; duration: number; loop: number; objects: DecodedKeyedObject[] }

// State-machine tree (walked by context, mirroring the runtime import stack: each child
// attaches to the most-recently-seen parent of the required type).
export interface DecodedSMInput { typeKey: number; name: string; value: number | undefined }
export interface DecodedCond { typeKey: number; inputId: number; op: number | undefined; value: number | undefined }
export interface DecodedTransition { typeKey: number; stateToId: number; duration: number; flags: number | undefined; exitTime: number | undefined; conditions: DecodedCond[] }
export interface DecodedState { typeKey: number; animationId: number | undefined; transitions: DecodedTransition[] }
export interface DecodedAction { typeKey: number; inputId: number; value: number | undefined }
export interface DecodedListener { targetId: number; listenerType: number; actions: DecodedAction[] }
export interface DecodedSM { name: string; inputs: DecodedSMInput[]; states: DecodedState[]; listeners: DecodedListener[] }

export interface Decoded {
  major: number; minor: number; fileId: number;
  tocKeys: number[]; tocTypes: Map<number, number>;
  objects: DecodedObject[];
  animations: DecodedAnim[];
  stateMachines: DecodedSM[];
}

export class Reader {
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

export function decodeRiv(bytes: Uint8Array): Decoded {
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
    } else if (
      typeKey === TYPE.KEYFRAME_DOUBLE || typeKey === TYPE.KEYFRAME_ID || typeKey === TYPE.KEYFRAME_COLOR
    ) {
      // Same nesting (child of the most-recent KeyedProperty); only the "value" property
      // key differs per keyframe type (double 70, id 122, color 88 — keys.ts's header).
      const raw = props[PROP.VALUE] ?? props[PROP.KEYFRAME_ID_VALUE] ?? props[PROP.KEYFRAME_COLOR_VALUE];
      curProp!.keyframes.push({
        frame: Number(props[PROP.FRAME] ?? 0),
        value: Number(raw ?? 0),
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
        exitTime: props[PROP.TRANS_EXIT_TIME] === undefined ? undefined : Number(props[PROP.TRANS_EXIT_TIME]),
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
