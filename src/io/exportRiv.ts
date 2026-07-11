/**
 * RigDoc -> Rive (.riv) binary exporter. Exports the WHOLE document (every clip) as
 * one .riv that PLAYS in the official Rive runtimes (@rive-app/canvas / webgl). It is a
 * playback/distribution format alongside the Lottie export; it is NOT meant to reopen
 * in the Rive editor (the editor cannot import .riv).
 *
 * The scene mapping mirrors exportLottie.ts decisions exactly (they solved the same
 * problems):
 *   - one Node per part (art/bone/group), positioned at the part's effective pivot so
 *     rotation happens about the joint; geometry is baked with all static SVG
 *     transforms + rest scale/skew and shifted by -pivot into the node's local space
 *     (Rive Nodes rotate about their own origin, so the -pivot shift is the same trick
 *     as Lottie anchor points);
 *   - a synthetic `root` Node carries whole-figure translate + scale about rootPivot,
 *     like Lottie's root null layer; every top-level part parents to it;
 *   - parts parent via `parentId` following the bone hierarchy (ancestors outermost);
 *   - each RigPath -> Shape + PointsPath(s) of cubic vertices from pathToCubics, with
 *     Fill/Stroke SolidColors; rest scale/skew and baked transforms flattened into the
 *     geometry, arcs converted to cubics, stroke width scaled by the baked matrix norm;
 *   - shape clusters are emitted in REVERSE paint order because Rive draws the
 *     first drawable in the file LAST (topmost) — see the draw-order comment in
 *     exportRiv() citing rive-runtime/src/artboard.cpp;
 *   - keyed values are ABSOLUTE; rest fills only unkeyed channels (a channel with no
 *     keyframes stays a static Node property, a keyed channel becomes a LinearAnimation
 *     KeyedProperty). Easing lives on the ARRIVING keyframe and Keyframe.bezier
 *     overrides the preset (both mirrored below);
 *   - skinned parts export RIGIDLY at rest (Rive Skin/Tendon left for a future wave),
 *     which happens for free since binding already baked their geometry.
 *
 * BINARY FORMAT (little-endian) per the official docs + rive-runtime:
 *   - https://rive.app/docs/runtimes/advanced-topic/format
 *   - runtime_header.hpp (fingerprint 'RIVE', varuint major/minor/fileId, then the ToC:
 *     varuint property keys terminated by 0, then a packed 2-bit backing-type array read
 *     as uint32 words, FOUR keys per word in bits 0..7). 0=uint/bool 1=string 2=double
 *     3=color.
 *   - src/file.cpp readRuntimeObject: each object = varuint typeKey, then (varuint
 *     propertyKey, value) pairs terminated by propertyKey 0. Known props read by type;
 *     unknown props skipped via the ToC field id (so every key we write is in the ToC).
 *   - References (parentId/objectId/interpolatorId) are indices into the artboard's
 *     component list in file read order: the Artboard is index 0, then every
 *     Node/Shape/Path/Vertex/Paint/SolidColor/Interpolator gets the next index.
 *     Animation objects (LinearAnimation/KeyedObject/KeyedProperty/KeyFrame) do NOT
 *     consume indices (verified against rive-lottie's reader + rive-runtime's
 *     ImportStack). So we emit all referenceable components (incl. interpolators) BEFORE
 *     the animations.
 *
 * TYPE/PROPERTY KEY TABLE (int typeKey / propertyKey -> def file under
 * rive-runtime/dev/defs). Backing type in [brackets]: U=uint/bool D=double S=string
 * C=color.
 *
 *   Object (typeKey)        | def
 *   ------------------------|------------------------------------------------
 *   Backboard        = 23   | backboard.json
 *   Artboard         =  1   | artboard.json (extends layout_component)
 *   Node             =  2   | node.json (extends transform_component)
 *   Shape            =  3   | shapes/shape.json
 *   PointsPath       = 16   | shapes/points_path.json
 *   CubicDetachedVertex = 6 | shapes/cubic_detached_vertex.json (typeString cubicvertex)
 *   Fill             = 20   | shapes/paint/fill.json
 *   Stroke           = 24   | shapes/paint/stroke.json
 *   SolidColor       = 18   | shapes/paint/solid_color.json
 *   CubicEaseInterpolator = 28 | animation/cubic_ease_interpolator.json (x1..y2 from cubic_interpolator)
 *   LinearAnimation  = 31   | animation/linear_animation.json
 *   KeyedObject      = 25   | animation/keyed_object.json
 *   KeyedProperty    = 26   | animation/keyed_property.json
 *   KeyFrameDouble   = 30   | animation/keyframe_double.json
 *
 *   Property (propertyKey)        | owner def          | type
 *   ------------------------------|--------------------|-----
 *   name             =  4  [S]    | component.json
 *   parentId         =  5  [U]    | component.json
 *   width            =  7  [D]    | layout_component.json (artboard)
 *   height           =  8  [D]    | layout_component.json (artboard)
 *   x (node)         = 13  [D]    | node.json
 *   y (node)         = 14  [D]    | node.json
 *   rotation         = 15  [D]    | transform_component.json (RADIANS)
 *   scaleX           = 16  [D]    | transform_component.json
 *   scaleY           = 17  [D]    | transform_component.json
 *   x (vertex)       = 24  [D]    | shapes/vertex.json
 *   y (vertex)       = 25  [D]    | shapes/vertex.json
 *   isClosed         = 32  [U]    | shapes/points_common_path.json (bool)
 *   colorValue       = 37  [C]    | shapes/paint/solid_color.json (0xAARRGGBB uint32)
 *   thickness        = 47  [D]    | shapes/paint/stroke.json
 *   objectId         = 51  [U]    | animation/keyed_object.json
 *   propertyKey(key) = 53  [U]    | animation/keyed_property.json
 *   fps              = 56  [U]    | animation/linear_animation.json
 *   duration         = 57  [U]    | animation/linear_animation.json (frames)
 *   loopValue        = 59  [U]    | animation/linear_animation.json (0 oneShot/1 loop/2 pingPong)
 *   x1,y1,x2,y2      = 63..66 [D] | animation/cubic_interpolator.json
 *   frame            = 67  [U]    | animation/keyframe.json
 *   interpolationType= 68  [U]    | animation/interpolating_keyframe.json (1 linear/2 cubic)
 *   interpolatorId   = 69  [U]    | animation/interpolating_keyframe.json
 *   value            = 70  [D]    | animation/keyframe_double.json
 *   inRotation       = 84  [D]    | shapes/cubic_detached_vertex.json (RADIANS)
 *   inDistance       = 85  [D]    | shapes/cubic_detached_vertex.json
 *   outRotation      = 86  [D]    | shapes/cubic_detached_vertex.json (RADIANS)
 *   outDistance      = 87  [D]    | shapes/cubic_detached_vertex.json
 *
 * STATE-MACHINE TYPE/PROPERTY KEYS (animation/*.json; pinned from rive-runtime dev/defs
 * + src). State-machine objects, like animation objects, do NOT consume artboard
 * component indices — the artboard importer files them in a separate state-machine list
 * (src/importers/artboard_importer.cpp addStateMachine vs addComponent). References
 * WITHIN a machine are positional indices computed from emission order; targetId reaches
 * OUT into the shared component index space.
 *
 *   Object (typeKey)             | def
 *   -----------------------------|-------------------------------------------------
 *   StateMachine          =  53  | state_machine.json
 *   StateMachineLayer     =  57  | state_machine_layer.json
 *   StateMachineBool      =  59  | state_machine_bool.json
 *   StateMachineNumber    =  56  | state_machine_number.json
 *   StateMachineTrigger   =  58  | state_machine_trigger.json
 *   EntryState            =  63  | entry_state.json
 *   AnyState              =  62  | any_state.json
 *   ExitState             =  64  | exit_state.json
 *   AnimationState        =  61  | animation_state.json
 *   StateTransition       =  65  | state_transition.json
 *   TransitionTriggerCondition = 68 | transition_trigger_condition.json
 *   TransitionNumberCondition  = 70 | transition_number_condition.json
 *   TransitionBoolCondition    = 71 | transition_bool_condition.json
 *   StateMachineListenerSingle = 114| state_machine_listener_single.json
 *   ListenerTriggerChange = 115  | listener_trigger_change.json
 *   ListenerBoolChange    = 117  | listener_bool_change.json
 *   ListenerNumberChange  = 118  | listener_number_change.json
 *
 *   Property (propertyKey)        | owner def                       | type
 *   ------------------------------|---------------------------------|-----
 *   animation name   =  55 [S]    | animation.json                  | StateMachine name (it
 *                                 |                                 | extends Animation, NOT
 *                                 |                                 | StateMachineComponent)
 *   name (SM comp)   = 138 [S]    | state_machine_component.json    | input + listener names
 *   number value     = 140 [D]    | state_machine_number.json       | input default
 *   bool value       = 141 [U]    | state_machine_bool.json         | input default (0/1)
 *   animationId      = 149 [U]    | animation_state.json            | index into LinearAnimations
 *   stateToId        = 151 [U]    | state_transition.json           | index into layer states
 *   condInputId      = 155 [U]    | transition_input_condition.json | index into machine inputs
 *   opValue          = 156 [U]    | transition_value_condition.json | TransitionConditionOp enum
 *   condValue        = 157 [D]    | transition_number_condition.json| number RHS
 *   duration         = 158 [U]    | state_transition.json           | MS (flags omits bit 2)
 *   targetId         = 224 [U]    | state_machine_listener.json      | artboard component index
 *   listenerTypeValue= 225 [U]    | state_machine_listener_single.json| ListenerType enum
 *   listenerInputId  = 227 [U]    | listener_input_change.json      | index into machine inputs
 *   listenerBoolVal  = 228 [U]    | listener_bool_change.json       | 0/1
 *   listenerNumberVal= 229 [D]    | listener_number_change.json     | number
 *
 *   TransitionConditionOp (transition_condition_op.hpp): equal 0, notEqual 1,
 *     lessThanOrEqual 2, greaterThanOrEqual 3, lessThan 4, greaterThan 5.
 *   ListenerType (listener_type.hpp): enter 0, exit 1, down 2, up 3.
 *   StateTransitionFlags (state_transition_flags.hpp): DurationIsPercentage = 2 (we
 *     leave it clear => ms); EnableExitTime = 4 (clear => immediate).
 */

import {
  artboardFrame,
  Channel,
  Easing,
  Keyframe,
  RigDoc,
  RigPart,
  RigPath,
  SMConditionOp,
  SMListener,
  SMState,
  Track,
} from '../core/model';
import { parsePath, pathToCubics } from '../geometry/paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../geometry/transforms';

// ---- Format constants ----

const RIVE_MAJOR = 7;
const RIVE_MINOR = 0;
/** Fixed file id keeps identical input -> identical bytes (the docs allow any/zero). */
const FILE_ID = 1380270931; // 'RIGS'
const FPS = 60;
const DEG2RAD = Math.PI / 180;

// typeKeys
const T_BACKBOARD = 23;
const T_ARTBOARD = 1;
const T_NODE = 2;
const T_SHAPE = 3;
const T_POINTS_PATH = 16;
const T_CUBIC_VERTEX = 6;
const T_FILL = 20;
const T_STROKE = 24;
const T_SOLID_COLOR = 18;
const T_CUBIC_INTERP = 28;
const T_LINEAR_ANIM = 31;
const T_KEYED_OBJECT = 25;
const T_KEYED_PROPERTY = 26;
const T_KEYFRAME_DOUBLE = 30;

// State-machine typeKeys (animation/*.json). None of these consume an artboard
// component index: like animations, they are added to the artboard's separate
// state-machine list (src/importers/artboard_importer.cpp addStateMachine), NOT to the
// component object list that id references resolve against (addObject/addComponent).
const T_STATE_MACHINE = 53; // state_machine.json (name from state_machine_component 138)
const T_SM_BOOL = 59; // state_machine_bool.json (value 141)
const T_SM_NUMBER = 56; // state_machine_number.json (value 140)
const T_SM_TRIGGER = 58; // state_machine_trigger.json (no value)
const T_SM_LAYER = 57; // state_machine_layer.json
const T_ENTRY_STATE = 63; // entry_state.json
const T_ANY_STATE = 62; // any_state.json
const T_EXIT_STATE = 64; // exit_state.json
const T_ANIMATION_STATE = 61; // animation_state.json (animationId 149)
const T_STATE_TRANSITION = 65; // state_transition.json (stateToId 151, duration 158, flags 152)
const T_TRANS_TRIGGER_COND = 68; // transition_trigger_condition.json (inputId 155)
const T_TRANS_NUMBER_COND = 70; // transition_number_condition.json (inputId 155, opValue 156, value 157)
const T_TRANS_BOOL_COND = 71; // transition_bool_condition.json (inputId 155, opValue 156)
const T_SM_LISTENER = 114; // state_machine_listener_single.json (targetId 224, listenerTypeValue 225)
const T_LISTENER_TRIGGER_CHANGE = 115; // listener_trigger_change.json (inputId 227)
const T_LISTENER_BOOL_CHANGE = 117; // listener_bool_change.json (inputId 227, value 228)
const T_LISTENER_NUMBER_CHANGE = 118; // listener_number_change.json (inputId 227, value 229)

// propertyKeys
const P_NAME = 4;
const P_PARENT_ID = 5;
const P_WIDTH = 7;
const P_HEIGHT = 8;
const P_NODE_X = 13;
const P_NODE_Y = 14;
const P_ROTATION = 15;
const P_SCALE_X = 16;
const P_SCALE_Y = 17;
const P_VERT_X = 24;
const P_VERT_Y = 25;
const P_IS_CLOSED = 32;
const P_COLOR = 37;
const P_THICKNESS = 47;
const P_OBJECT_ID = 51;
const P_PROPERTY_KEY = 53;
const P_ANIM_NAME = 55; // Animation.name (animation.json) — NOT Component.name (4)
const P_FPS = 56;
const P_DURATION = 57;
const P_LOOP = 59;
const P_X1 = 63;
const P_Y1 = 64;
const P_X2 = 65;
const P_Y2 = 66;
const P_FRAME = 67;
const P_INTERP_TYPE = 68;
const P_INTERPOLATOR_ID = 69;
const P_VALUE = 70;
const P_IN_ROTATION = 84;
const P_IN_DISTANCE = 85;
const P_OUT_ROTATION = 86;
const P_OUT_DISTANCE = 87;

// State-machine propertyKeys.
const P_SM_NAME = 138; // [S] StateMachineComponent.name — machine/input names (addressed by name at runtime)
const P_SM_NUMBER_VALUE = 140; // [D] StateMachineNumber.value (default)
const P_SM_BOOL_VALUE = 141; // [U/bool] StateMachineBool.value (default)
const P_ANIMATION_ID = 149; // [U] AnimationState.animationId (index into artboard LinearAnimations)
const P_STATE_TO_ID = 151; // [U] StateTransition.stateToId (index into the layer's states)
const P_COND_INPUT_ID = 155; // [U] TransitionInputCondition.inputId (index into machine inputs)
const P_COND_OP = 156; // [U] TransitionValueCondition.opValue (TransitionConditionOp enum)
const P_COND_VALUE = 157; // [D] TransitionNumberCondition.value
const P_TRANS_DURATION = 158; // [U] StateTransition.duration (ms; flags default 0 => ms, not percentage)
const P_LISTENER_TARGET_ID = 224; // [U] StateMachineListener.targetId (artboard component index)
const P_LISTENER_TYPE = 225; // [U] StateMachineListenerSingle.listenerTypeValue (ListenerType enum)
const P_LISTENER_INPUT_ID = 227; // [U] ListenerInputChange.inputId (index into machine inputs)
const P_LISTENER_BOOL_VALUE = 228; // [U] ListenerBoolChange.value
const P_LISTENER_NUMBER_VALUE = 229; // [D] ListenerNumberChange.value

// ToC backing-type indices.
const F_UINT = 0;
const F_STRING = 1;
const F_DOUBLE = 2;
const F_COLOR = 3;

/** Backing type for every property key this exporter can write (for the ToC). */
const FIELD_TYPE: Record<number, number> = {
  [P_NAME]: F_STRING,
  [P_PARENT_ID]: F_UINT,
  [P_WIDTH]: F_DOUBLE,
  [P_HEIGHT]: F_DOUBLE,
  [P_NODE_X]: F_DOUBLE,
  [P_NODE_Y]: F_DOUBLE,
  [P_ROTATION]: F_DOUBLE,
  [P_SCALE_X]: F_DOUBLE,
  [P_SCALE_Y]: F_DOUBLE,
  [P_VERT_X]: F_DOUBLE,
  [P_VERT_Y]: F_DOUBLE,
  [P_IS_CLOSED]: F_UINT,
  [P_COLOR]: F_COLOR,
  [P_THICKNESS]: F_DOUBLE,
  [P_OBJECT_ID]: F_UINT,
  [P_PROPERTY_KEY]: F_UINT,
  [P_ANIM_NAME]: F_STRING,
  [P_FPS]: F_UINT,
  [P_DURATION]: F_UINT,
  [P_LOOP]: F_UINT,
  [P_X1]: F_DOUBLE,
  [P_Y1]: F_DOUBLE,
  [P_X2]: F_DOUBLE,
  [P_Y2]: F_DOUBLE,
  [P_FRAME]: F_UINT,
  [P_INTERP_TYPE]: F_UINT,
  [P_INTERPOLATOR_ID]: F_UINT,
  [P_VALUE]: F_DOUBLE,
  [P_IN_ROTATION]: F_DOUBLE,
  [P_IN_DISTANCE]: F_DOUBLE,
  [P_OUT_ROTATION]: F_DOUBLE,
  [P_OUT_DISTANCE]: F_DOUBLE,
  [P_SM_NAME]: F_STRING,
  [P_SM_NUMBER_VALUE]: F_DOUBLE,
  [P_SM_BOOL_VALUE]: F_UINT,
  [P_ANIMATION_ID]: F_UINT,
  [P_STATE_TO_ID]: F_UINT,
  [P_COND_INPUT_ID]: F_UINT,
  [P_COND_OP]: F_UINT,
  [P_COND_VALUE]: F_DOUBLE,
  [P_TRANS_DURATION]: F_UINT,
  [P_LISTENER_TARGET_ID]: F_UINT,
  [P_LISTENER_TYPE]: F_UINT,
  [P_LISTENER_INPUT_ID]: F_UINT,
  [P_LISTENER_BOOL_VALUE]: F_UINT,
  [P_LISTENER_NUMBER_VALUE]: F_DOUBLE,
};

// TransitionConditionOp enum (include/rive/animation/transition_condition_op.hpp).
// NOTE the non-obvious ordering: <= and >= come BEFORE < and >.
const COND_OP: Record<SMConditionOp, number> = {
  '==': 0, // equal
  '!=': 1, // notEqual
  '<=': 2, // lessThanOrEqual
  '>=': 3, // greaterThanOrEqual
  '<': 4, // lessThan
  '>': 5, // greaterThan
};

// ListenerType enum (include/rive/listener_type.hpp): enter 0, exit 1, down 2, up 3.
const LISTENER_TYPE: Record<SMListener['event'], number> = {
  enter: 0,
  exit: 1,
  down: 2,
  up: 3,
};

// Rive keyframe interpolation enum (interpolationType). Linear needs no interpolator;
// cubic references a CubicEaseInterpolator by index. (Hold=0/Linear=1/Cubic=2.)
const INTERP_LINEAR = 1;
const INTERP_CUBIC = 2;

/**
 * Studio easings -> cubic-bezier control points (x1,y1,x2,y2). Identical to
 * exportLottie.ts's EASING_BEZIER so the two exporters bend the same way; the studio's
 * model easings are quadratic/smoothstep and both exporters approximate them with these
 * handles. `linear` is emitted as a true linear segment (no interpolator) instead.
 */
const EASING_CUBIC: Record<Exclude<Easing, 'linear'>, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

// ---- Binary writer ----

/** Little-endian byte writer with the Rive primitive encodings. */
class ByteWriter {
  bytes: number[] = [];
  private scratch = new DataView(new ArrayBuffer(4));

  get length(): number {
    return this.bytes.length;
  }

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  /** uint32, little-endian (used for the ToC words and packed ARGB colors). */
  u32(v: number): void {
    const n = v >>> 0;
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  /** float32, little-endian. */
  f32(v: number): void {
    this.scratch.setFloat32(0, v, true);
    this.bytes.push(
      this.scratch.getUint8(0),
      this.scratch.getUint8(1),
      this.scratch.getUint8(2),
      this.scratch.getUint8(3),
    );
  }

  /** LEB128 unsigned varint. */
  varuint(value: number): void {
    let v = Math.floor(value);
    if (v < 0) v = 0;
    do {
      let byte = v & 0x7f;
      v = Math.floor(v / 128);
      if (v !== 0) byte |= 0x80;
      this.bytes.push(byte);
    } while (v !== 0);
  }

  /** varuint length + UTF-8 bytes. */
  string(s: string): void {
    const utf8 = new TextEncoder().encode(s);
    this.varuint(utf8.length);
    for (const b of utf8) this.bytes.push(b);
  }

  concat(other: ByteWriter): void {
    for (const b of other.bytes) this.bytes.push(b);
  }
}

// ---- Object stream helper ----

/**
 * Writes objects into `body` while tracking which property keys were used (for the ToC)
 * and assigning each component a sequential artboard index. Property helpers add their
 * key to `usedKeys` so the ToC is always complete.
 */
class Scene {
  body = new ByteWriter();
  usedKeys = new Set<number>();
  /** Next artboard component index. Artboard itself will take index 0. */
  index = 0;

  private key(k: number): void {
    this.body.varuint(k);
    this.usedKeys.add(k);
  }

  propUint(k: number, v: number): void {
    this.key(k);
    this.body.varuint(v);
  }

  propBool(k: number, v: boolean): void {
    this.key(k);
    this.body.u8(v ? 1 : 0);
  }

  propDouble(k: number, v: number): void {
    this.key(k);
    this.body.f32(v);
  }

  propString(k: number, v: string): void {
    this.key(k);
    this.body.string(v);
  }

  propColor(k: number, argb: number): void {
    this.key(k);
    this.body.u32(argb);
  }

  /** Begin an object: write its typeKey. Returns the component index it consumes. */
  begin(typeKey: number, consumesIndex = true): number {
    this.body.varuint(typeKey);
    return consumesIndex ? this.index++ : -1;
  }

  /** End an object (properties terminator). */
  end(): void {
    this.body.varuint(0);
  }
}

// ---- Public API ----

/**
 * Serialize the whole document (all clips) to a Rive .riv binary. Deterministic:
 * identical input -> identical bytes.
 */
export function exportRiv(doc: RigDoc): Uint8Array {
  const scene = new Scene();
  // Reference frame for the whole export: the artboard rect when the doc has one
  // enabled, else the viewBox (today's behavior, byte-identical when disabled/absent).
  const frame = artboardFrame(doc);
  const ox = frame.x;
  const oy = frame.y;

  // Backboard: no properties; not part of the artboard index space.
  scene.begin(T_BACKBOARD, false);
  scene.end();

  // Artboard = component index 0. Origin (0,0), size = the reference frame above,
  // transparent (no bg).
  const artboardIndex = scene.begin(T_ARTBOARD); // 0
  scene.propString(P_NAME, doc.name);
  scene.propDouble(P_WIDTH, frame.w);
  scene.propDouble(P_HEIGHT, frame.h);
  scene.end();

  // Root Node: whole-figure translate + scale about rootPivot (never rotates). Its
  // origin sits at rootPivot in artboard space (doc minus the reference frame's origin).
  const rootBaseX = doc.rootPivot.x - ox;
  const rootBaseY = doc.rootPivot.y - oy;
  const rootIndex = scene.begin(T_NODE); // 1
  scene.propUint(P_PARENT_ID, artboardIndex);
  scene.propString(P_NAME, `${doc.name} root`);
  scene.propDouble(P_NODE_X, rootBaseX);
  scene.propDouble(P_NODE_Y, rootBaseY);
  scene.end();

  // Emit ALL part nodes first, ancestors before descendants (parentId must reference
  // an earlier index; doc.parts order is the tiebreak). Shape clusters follow below —
  // their order carries draw order, node order does not (Nodes are not Drawables).
  const partIndex = new Map<string, number>();
  const inProgress = new Set<string>();
  const byId = new Map(doc.parts.map((p) => [p.id, p]));

  const emitPart = (part: RigPart): void => {
    if (partIndex.has(part.id) || inProgress.has(part.id)) return;
    inProgress.add(part.id);
    const parent = part.parentId ? byId.get(part.parentId) ?? null : null;
    if (parent) emitPart(parent);
    inProgress.delete(part.id);

    const parentNodeIndex = parent ? partIndex.get(parent.id)! : rootIndex;
    // Node origin is expressed in the parent's local frame; the reference frame's
    // origin cancels for part->part and part->root (both refs are pivots).
    // base = pivot - parentRef.
    const parentRef = parent ? parent.pivot : doc.rootPivot;
    const baseX = part.pivot.x - parentRef.x;
    const baseY = part.pivot.y - parentRef.y;

    const nodeIndex = scene.begin(T_NODE);
    partIndex.set(part.id, nodeIndex);
    scene.propUint(P_PARENT_ID, parentNodeIndex);
    scene.propString(P_NAME, part.label);
    // Static Node transform = rest pose; keyed channels override it via animations.
    scene.propDouble(P_NODE_X, baseX + part.rest.tx);
    scene.propDouble(P_NODE_Y, baseY + part.rest.ty);
    if (part.rest.rotate !== 0) scene.propDouble(P_ROTATION, part.rest.rotate * DEG2RAD);
    // Rest scale/skew are baked into geometry (below), so the Node scale stays 1.
    scene.end();
  };

  for (const part of doc.parts) emitPart(part);

  // DRAW ORDER (pinned from rive-runtime/src/artboard.cpp): Artboard::initialize()
  // fills m_Drawables in file/component order; sortDrawOrder() links them in that
  // order and then sets `m_FirstDrawable = lastDrawable` (the LAST drawable in file
  // order); drawInternal() iterates `drawable = m_FirstDrawable; ...; drawable =
  // drawable->prev`. Net effect: the FIRST drawable component in the file is drawn
  // LAST — first-in-file = TOPMOST, like the Rive editor's layer panel. The studio's
  // convention is the opposite (doc.parts order is paint order, last = topmost; a
  // part's paths array likewise). So shape clusters are emitted fully REVERSED:
  // parts in reverse doc order, each part's paths in reverse array order. Only Shape
  // (typeKey 3) is a Drawable — plain Nodes and PointsPaths never enter m_Drawables —
  // and every part Node was emitted above, so all parentIds still point backward and
  // the animation objectIds (recorded in partIndex at node-emit time) are unaffected.
  for (let pi = doc.parts.length - 1; pi >= 0; pi--) {
    const part = doc.parts[pi];
    for (let qi = part.paths.length - 1; qi >= 0; qi--) {
      emitShape(scene, part, part.paths[qi], partIndex.get(part.id)!);
    }
  }

  // ---- Animations ----
  // Build the plan for every clip first: this writes any needed CubicEaseInterpolators
  // (which consume component indices) BEFORE any animation object is emitted.
  const interpCache = new Map<string, number>();
  const emitInterpolator = (b: [number, number, number, number]): number => {
    const cacheKey = b.map((n) => Math.fround(n)).join(',');
    const cached = interpCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const idx = scene.begin(T_CUBIC_INTERP);
    scene.propDouble(P_X1, b[0]);
    scene.propDouble(P_Y1, b[1]);
    scene.propDouble(P_X2, b[2]);
    scene.propDouble(P_Y2, b[3]);
    scene.end();
    interpCache.set(cacheKey, idx);
    return idx;
  };

  interface PlanKey { frame: number; value: number; interpType: number; interpId: number }
  interface PlanProp { objectId: number; propertyKey: number; keys: PlanKey[] }
  interface PlanClip { name: string; duration: number; props: PlanProp[] }

  // Canonical, deterministic per-target channel plan: [target, channel, propertyKey,
  // base offset, isAngle]. root first, then parts in doc order; fixed channel order.
  interface ChannelSpec {
    target: string;
    channel: Channel;
    propertyKey: number;
    base: number;
    isAngle: boolean;
  }
  const channelSpecs: ChannelSpec[] = [
    { target: 'root', channel: 'tx', propertyKey: P_NODE_X, base: rootBaseX, isAngle: false },
    { target: 'root', channel: 'ty', propertyKey: P_NODE_Y, base: rootBaseY, isAngle: false },
    { target: 'root', channel: 'sx', propertyKey: P_SCALE_X, base: 0, isAngle: false },
    { target: 'root', channel: 'sy', propertyKey: P_SCALE_Y, base: 0, isAngle: false },
  ];
  for (const part of doc.parts) {
    const parent = part.parentId ? byId.get(part.parentId) ?? null : null;
    const parentRef = parent ? parent.pivot : doc.rootPivot;
    channelSpecs.push(
      { target: part.id, channel: 'rotate', propertyKey: P_ROTATION, base: 0, isAngle: true },
      { target: part.id, channel: 'tx', propertyKey: P_NODE_X, base: part.pivot.x - parentRef.x, isAngle: false },
      { target: part.id, channel: 'ty', propertyKey: P_NODE_Y, base: part.pivot.y - parentRef.y, isAngle: false },
    );
  }
  const objectIdOf = (target: string): number =>
    target === 'root' ? rootIndex : partIndex.get(target)!;

  const plans: PlanClip[] = doc.clips.map((clip) => {
    const props: PlanProp[] = [];
    const trackOf = (target: string, channel: Channel): Track | undefined =>
      clip.tracks.find((t) => t.target === target && t.channel === channel);

    for (const spec of channelSpecs) {
      const { channel, propertyKey, base, isAngle } = spec;
      const track = trackOf(spec.target, channel);
      const sorted = keysOf(track);
      if (sorted.length === 0) continue; // unkeyed -> stays a static Node property
      const keys: PlanKey[] = sorted.map((key, i) => {
        const raw = base + (isAngle ? key.value * DEG2RAD : key.value);
        let interpType = INTERP_LINEAR;
        let interpId = -1;
        // Easing lives on the ARRIVING keyframe; Rive stores it on the LEAVING key,
        // so segment i->i+1 uses sorted[i+1]'s easing/bezier.
        const next = sorted[i + 1];
        if (next) {
          const bez = cubicFor(next);
          if (bez) {
            interpType = INTERP_CUBIC;
            interpId = emitInterpolator(bez);
          }
        }
        return { frame: toFrame(key.time), value: raw, interpType, interpId };
      });
      props.push({ objectId: objectIdOf(spec.target), propertyKey, keys });
    }
    return {
      name: clip.name,
      duration: Math.max(1, Math.round((clip.duration / 1000) * FPS)),
      props,
    };
  });

  // Now emit the animation objects (they do NOT consume component indices).
  for (const plan of plans) {
    scene.begin(T_LINEAR_ANIM, false);
    scene.propString(P_ANIM_NAME, plan.name);
    scene.propUint(P_FPS, FPS);
    scene.propUint(P_DURATION, plan.duration);
    scene.propUint(P_LOOP, 1); // loop
    scene.end();

    for (const prop of plan.props) {
      scene.begin(T_KEYED_OBJECT, false);
      scene.propUint(P_OBJECT_ID, prop.objectId);
      scene.end();

      scene.begin(T_KEYED_PROPERTY, false);
      scene.propUint(P_PROPERTY_KEY, prop.propertyKey);
      scene.end();

      for (const k of prop.keys) {
        scene.begin(T_KEYFRAME_DOUBLE, false);
        if (k.frame !== 0) scene.propUint(P_FRAME, k.frame);
        scene.propUint(P_INTERP_TYPE, k.interpType);
        if (k.interpId >= 0) scene.propUint(P_INTERPOLATOR_ID, k.interpId);
        scene.propDouble(P_VALUE, k.value);
        scene.end();
      }
    }
  }

  // ---- State machines ----
  // Emitted AFTER the animations (animationId is a positional index into the artboard's
  // LinearAnimation list, so file position relative to the animations is irrelevant).
  // A doc with no stateMachines (field absent OR []) emits nothing here, so its bytes
  // stay byte-identical to the pre-state-machine exporter.
  emitStateMachines(scene, doc, partIndex);

  return assemble(scene);
}

/**
 * Emit each app StateMachine as one StateMachine object + one StateMachineLayer, mapping
 * 1:1 to Rive's own state-machine core objects. Nesting is purely by EMISSION ORDER:
 * Rive's import stack (src/importers/import_stack.cpp — a map keyed by importer typeKey)
 * attaches each child to the most-recently-emitted parent of the required type, exactly
 * like the KeyedObject/KeyedProperty/KeyFrame chain the animation exporter already relies
 * on. Per machine we emit, in order:
 *
 *   StateMachine
 *     StateMachineInput* (bool/number/trigger — addInput, index = array position)
 *     StateMachineLayer
 *       LayerState* (Entry/Any/Exit/AnimationState — addState; stateToId indexes these)
 *         StateTransition* (each nested under its FROM state; stateFromId is runtime:false
 *                           and recovered from nesting, so we never emit it)
 *           TransitionCondition* (addCondition; ANDed)
 *     StateMachineListener* (addListener; children of the MACHINE, emitted after the
 *                            layer — safe because the listener looks up the still-latest
 *                            StateMachine importer in the map)
 *       ListenerInputChange* (addAction)
 *
 * None of these consume artboard component indices (they go to the artboard's separate
 * state-machine list), so partIndex/rootIndex references from the drawing tree are
 * untouched.
 *
 * Index/enum ground truth (rive-runtime/dev/defs + src):
 *  - AnimationState.animationId = positional index into the artboard's LinearAnimations
 *    (= doc.clips order); a state whose clipName no longer resolves is DROPPED along with
 *    any transition touching it (an AnimationState with a missing animationId fails
 *    import — layer_state_importer resolve() returns MissingObject).
 *  - StateTransition.stateToId = index into the layer's emitted states.
 *  - Condition inputId / listener-action inputId = index into the machine's inputs.
 *  - StateTransition.duration is milliseconds because flags omits DurationIsPercentage
 *    (bit value 2, state_transition_flags.hpp); flags default 0 also leaves exit-time
 *    disabled so a satisfied transition fires immediately.
 *  - Bool conditions: Rive's TransitionBoolCondition::evaluate passes when
 *    (value && op==equal) || (!value && op==notEqual), so opValue ENCODES the expected
 *    boolean (equal=expect true, notEqual=expect false) rather than a comparison; the app
 *    (op,value) pair is reduced to that expected boolean here.
 *  - StateMachineListener.targetId = the target part's Node component index. Rive's hit
 *    test (state_machine_instance.cpp addToHitLookup) walks a ContainerComponent's
 *    descendants, so pointing at the part's Node picks up its child Shapes.
 *  - Every layer MUST contain an Entry, an Any, AND an Exit state or the runtime rejects
 *    it as corrupt (state_machine_layer.cpp onAddedDirty). The app guarantees entry+any
 *    but not exit, so a bare Exit is synthesized when absent.
 *
 * Documented limitations:
 *  - Per-state loop (SMState.loop) is NOT independently expressible: looping is a property
 *    of the LinearAnimation (loopValue), and the animation exporter emits every animation
 *    as looped. A state's loop flag is therefore ignored; the shared clip's loop governs.
 *  - Listener event type is carried on StateMachineListenerSingle.listenerTypeValue (the
 *    classic representation). Very new runtimes that read the type only from separate
 *    ListenerInputType child objects may not fire pointer listeners; the rest of the
 *    machine (inputs/states/transitions) is unaffected.
 */
function emitStateMachines(scene: Scene, doc: RigDoc, partIndex: Map<string, number>): void {
  const machines = doc.stateMachines;
  if (!machines || machines.length === 0) return;

  // clipName -> positional index among the emitted LinearAnimations (doc.clips order).
  const clipIndexByName = new Map<string, number>();
  doc.clips.forEach((c, i) => {
    if (!clipIndexByName.has(c.name)) clipIndexByName.set(c.name, i);
  });

  for (const sm of machines) {
    // --- StateMachine (named so the runtime can address it by name) ---
    // StateMachine extends Animation (via StateMachineResolver), NOT
    // StateMachineComponent, so its name is Animation.name (key 55) — the SAME key the
    // LinearAnimations use — not the component name (138) that inputs/listeners carry.
    scene.begin(T_STATE_MACHINE, false);
    scene.propString(P_ANIM_NAME, sm.name);
    scene.end();

    // --- Inputs (index = array position; name so setInput-by-name works) ---
    const inputIndex = new Map<string, number>();
    const inputType = new Map<string, SMInputKind>();
    sm.inputs.forEach((inp, i) => {
      inputIndex.set(inp.id, i);
      inputType.set(inp.id, inp.type);
      if (inp.type === 'bool') {
        scene.begin(T_SM_BOOL, false);
        scene.propString(P_SM_NAME, inp.name);
        scene.propBool(P_SM_BOOL_VALUE, inp.default === true);
        scene.end();
      } else if (inp.type === 'number') {
        scene.begin(T_SM_NUMBER, false);
        scene.propString(P_SM_NAME, inp.name);
        scene.propDouble(P_SM_NUMBER_VALUE, typeof inp.default === 'number' ? inp.default : 0);
        scene.end();
      } else {
        scene.begin(T_SM_TRIGGER, false);
        scene.propString(P_SM_NAME, inp.name);
        scene.end();
      }
    });

    // --- Layer ---
    scene.begin(T_SM_LAYER, false);
    scene.end();

    // --- States (drop dangling animation states; entry/any/exit never dangle) ---
    const kept: SMState[] = sm.states.filter(
      (st) => st.kind !== 'animation' || resolveClipIndex(st, clipIndexByName) !== undefined,
    );
    // Rive rejects a layer that lacks ANY of Entry/Any/Exit as "corrupt"
    // (state_machine_layer.cpp onAddedDirty). The app guarantees one entry + one any but
    // NOT an exit, so synthesize the missing mandatory states (unreferenced — nothing
    // transitions to a synthetic exit, which is legal).
    const synthetic: SMState[] = [];
    const hasKind = (k: SMState['kind']) => kept.some((s) => s.kind === k);
    if (!hasKind('entry')) synthetic.push({ id: '__sm_entry__', name: 'Entry', kind: 'entry' });
    if (!hasKind('any')) synthetic.push({ id: '__sm_any__', name: 'Any', kind: 'any' });
    if (!hasKind('exit')) synthetic.push({ id: '__sm_exit__', name: 'Exit', kind: 'exit' });
    const emitted: SMState[] = [...kept, ...synthetic];
    const stateIndex = new Map<string, number>();
    emitted.forEach((st, i) => stateIndex.set(st.id, i));

    for (const st of emitted) {
      const typeKey =
        st.kind === 'entry' ? T_ENTRY_STATE
        : st.kind === 'any' ? T_ANY_STATE
        : st.kind === 'exit' ? T_EXIT_STATE
        : T_ANIMATION_STATE;
      scene.begin(typeKey, false);
      if (st.kind === 'animation') {
        scene.propUint(P_ANIMATION_ID, resolveClipIndex(st, clipIndexByName)!);
      }
      scene.end();

      // Outgoing transitions nested under this (their FROM) state.
      for (const tr of sm.transitions) {
        if (tr.fromId !== st.id) continue;
        const to = stateIndex.get(tr.toId);
        if (to === undefined) continue; // target state was dropped
        scene.begin(T_STATE_TRANSITION, false);
        scene.propUint(P_STATE_TO_ID, to);
        // flags omitted (=> 0 => duration in ms, exit-time disabled).
        if (tr.durationMs > 0) scene.propUint(P_TRANS_DURATION, Math.round(tr.durationMs));
        scene.end();

        for (const cond of tr.conditions) {
          const iidx = inputIndex.get(cond.inputId);
          const itype = inputType.get(cond.inputId);
          if (iidx === undefined || itype === undefined) continue; // dangling input
          if (itype === 'trigger') {
            scene.begin(T_TRANS_TRIGGER_COND, false);
            scene.propUint(P_COND_INPUT_ID, iidx);
            scene.end();
          } else if (itype === 'bool') {
            const op: SMConditionOp = cond.op ?? '==';
            const rhs = cond.value === true;
            const expected = op === '!=' ? !rhs : rhs; // input == expected
            scene.begin(T_TRANS_BOOL_COND, false);
            scene.propUint(P_COND_INPUT_ID, iidx);
            scene.propUint(P_COND_OP, expected ? 0 : 1); // equal / notEqual
            scene.end();
          } else {
            const op: SMConditionOp = cond.op ?? '==';
            scene.begin(T_TRANS_NUMBER_COND, false);
            scene.propUint(P_COND_INPUT_ID, iidx);
            scene.propUint(P_COND_OP, COND_OP[op]);
            scene.propDouble(P_COND_VALUE, typeof cond.value === 'number' ? cond.value : 0);
            scene.end();
          }
        }
      }
    }

    // --- Listeners (machine-level; after the layer) ---
    for (const ln of sm.listeners) {
      const target = partIndex.get(ln.targetPartId);
      if (target === undefined) continue; // target part missing/deleted
      scene.begin(T_SM_LISTENER, false);
      scene.propUint(P_LISTENER_TARGET_ID, target);
      scene.propUint(P_LISTENER_TYPE, LISTENER_TYPE[ln.event]);
      scene.end();

      for (const act of ln.actions) {
        const iidx = inputIndex.get(act.inputId);
        const itype = inputType.get(act.inputId);
        if (iidx === undefined || itype === undefined) continue;
        if (act.type === 'fireTrigger') {
          scene.begin(T_LISTENER_TRIGGER_CHANGE, false);
          scene.propUint(P_LISTENER_INPUT_ID, iidx);
          scene.end();
        } else if (act.type === 'setBool') {
          scene.begin(T_LISTENER_BOOL_CHANGE, false);
          scene.propUint(P_LISTENER_INPUT_ID, iidx);
          scene.propUint(P_LISTENER_BOOL_VALUE, act.value === true ? 1 : 0);
          scene.end();
        } else {
          scene.begin(T_LISTENER_NUMBER_CHANGE, false);
          scene.propUint(P_LISTENER_INPUT_ID, iidx);
          scene.propDouble(P_LISTENER_NUMBER_VALUE, typeof act.value === 'number' ? act.value : 0);
          scene.end();
        }
      }
    }
  }
}

type SMInputKind = 'bool' | 'number' | 'trigger';

/** Index of the clip a state plays, or undefined when the clipName no longer resolves. */
function resolveClipIndex(st: SMState, clipIndexByName: Map<string, number>): number | undefined {
  if (st.clipName === undefined) return undefined;
  return clipIndexByName.get(st.clipName);
}

/** Assemble the header + ToC + object body into the final byte array. */
function assemble(scene: Scene): Uint8Array {
  const head = new ByteWriter();
  head.u8(0x52); head.u8(0x49); head.u8(0x56); head.u8(0x45); // 'RIVE'
  head.varuint(RIVE_MAJOR);
  head.varuint(RIVE_MINOR);
  head.varuint(FILE_ID);

  const keys = [...scene.usedKeys].sort((a, b) => a - b);
  for (const k of keys) head.varuint(k);
  head.varuint(0); // property-key terminator

  // Packed 2-bit backing types: FOUR keys per uint32 word (bits 0..7), rest unused —
  // this exact layout is what runtime_header.hpp reads.
  for (let i = 0; i < keys.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4 && i + j < keys.length; j++) {
      word |= (FIELD_TYPE[keys[i + j]] & 3) << (j * 2);
    }
    head.u32(word);
  }

  head.concat(scene.body);
  return Uint8Array.from(head.bytes);
}

// ---- Geometry (mirrors exportLottie.ts shapeGroup/pathToBeziers) ----

/** One RigPath -> Shape (child of the part node) with PointsPath(s), Fill, Stroke. */
function emitShape(scene: Scene, part: RigPart, path: RigPath, partNodeIndex: number): void {
  const m = bakedMatrix(part, path);
  const subs = pathToLocalSubpaths(path.d, m, part.pivot.x, part.pivot.y);
  if (subs.length === 0) return;

  const shapeIndex = scene.begin(T_SHAPE);
  scene.propUint(P_PARENT_ID, partNodeIndex);
  scene.propString(P_NAME, path.label);
  scene.end();

  for (const sub of subs) {
    const pathIndex = scene.begin(T_POINTS_PATH);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.propBool(P_IS_CLOSED, sub.closed);
    scene.end();
    for (const v of sub.verts) {
      scene.begin(T_CUBIC_VERTEX);
      scene.propUint(P_PARENT_ID, pathIndex);
      scene.propDouble(P_VERT_X, v.x);
      scene.propDouble(P_VERT_Y, v.y);
      scene.propDouble(P_IN_ROTATION, v.inRot);
      scene.propDouble(P_IN_DISTANCE, v.inDist);
      scene.propDouble(P_OUT_ROTATION, v.outRot);
      scene.propDouble(P_OUT_DISTANCE, v.outDist);
      scene.end();
    }
  }

  if (path.fill) {
    const fillIndex = scene.begin(T_FILL);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.end();
    const colorIndex = scene.begin(T_SOLID_COLOR);
    scene.propUint(P_PARENT_ID, fillIndex);
    scene.propColor(P_COLOR, argb(path.fill, path.fillOpacity));
    scene.end();
    void colorIndex;
  }
  if (path.stroke) {
    // Uniform-scale approximation of the baked matrix for the stroke width (as Lottie).
    const widthScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const strokeIndex = scene.begin(T_STROKE);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.propDouble(P_THICKNESS, path.strokeWidth * widthScale);
    scene.end();
    const colorIndex = scene.begin(T_SOLID_COLOR);
    scene.propUint(P_PARENT_ID, strokeIndex);
    scene.propColor(P_COLOR, argb(path.stroke, path.strokeOpacity));
    scene.end();
    void colorIndex;
  }
}

/**
 * Baked matrix for a path: part group transform, then rest scale/skew innermost around
 * the pivot (mapped into pre-baked local space) so artwork reshapes on its own axes and
 * the joint stays fixed, then the per-path transform. Identical to exportLottie.ts.
 */
function bakedMatrix(part: RigPart, path: RigPath): Mat {
  const baked = matrixOfTransform(part.transform);
  let m = baked;
  const sx = part.rest?.sx ?? 1;
  const sy = part.rest?.sy ?? 1;
  const kx = part.rest?.kx ?? 0;
  const ky = part.rest?.ky ?? 0;
  if (sx !== 1 || sy !== 1 || kx !== 0 || ky !== 0) {
    const pl = applyMat(invertMat(baked), part.pivot.x, part.pivot.y);
    const local = matrixOfTransform(
      `translate(${pl.x},${pl.y}) scale(${sx},${sy}) ` +
      `skewX(${kx}) skewY(${ky}) translate(${-pl.x},${-pl.y})`,
    );
    m = multiply(baked, local);
  }
  return multiply(m, matrixOfTransform(path.transform));
}

interface RivVertex {
  x: number; y: number;
  inRot: number; inDist: number;
  outRot: number; outDist: number;
}
interface RivSubpath { verts: RivVertex[]; closed: boolean }

/**
 * Parse path data, rewrite arcs as cubics, flatten the baked matrix, subtract the pivot
 * to land in the part node's local space, and convert each vertex's in/out tangent
 * offsets to Rive's polar (rotation, distance) form. Straight segments become
 * zero-distance handles (Rive renders a degenerate cubic as a line). The subpath fold
 * for an explicit closing segment mirrors exportLottie.ts's pathToBeziers.
 */
function pathToLocalSubpaths(d: string, m: Mat, pivotX: number, pivotY: number): RivSubpath[] {
  const cmds = pathToCubics(parsePath(d));
  const subs: RivSubpath[] = [];
  // Working buffers for the current subpath: vertex point + in/out tangent OFFSETS.
  let v: { x: number; y: number }[] = [];
  let inv: { x: number; y: number }[] = [];
  let outv: { x: number; y: number }[] = [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let open = false;

  const local = (x: number, y: number) => {
    const p = applyMat(m, x, y);
    return { x: p.x - pivotX, y: p.y - pivotY };
  };
  const tangent = (cx: number, cy: number, vx: number, vy: number) => {
    const c = applyMat(m, cx, cy);
    const w = applyMat(m, vx, vy);
    return { x: c.x - w.x, y: c.y - w.y };
  };
  const finish = (closed: boolean) => {
    if (v.length >= 2) {
      subs.push({ verts: v.map((pt, i) => toPolar(pt, inv[i], outv[i])), closed });
    }
    v = []; inv = []; outv = []; open = false;
  };
  const startSub = (x: number, y: number) => {
    v = [local(x, y)]; inv = [{ x: 0, y: 0 }]; outv = [{ x: 0, y: 0 }]; open = true;
  };

  for (const c of cmds) {
    switch (c.cmd) {
      case 'M':
        if (open) finish(false);
        startSub(c.x, c.y);
        curX = c.x; curY = c.y; startX = c.x; startY = c.y;
        break;
      case 'L': {
        if (!open) startSub(curX, curY);
        v.push(local(c.x, c.y)); inv.push({ x: 0, y: 0 }); outv.push({ x: 0, y: 0 });
        curX = c.x; curY = c.y;
        break;
      }
      case 'C': {
        if (!open) startSub(curX, curY);
        outv[outv.length - 1] = tangent(c.x1, c.y1, curX, curY);
        v.push(local(c.x, c.y));
        inv.push(tangent(c.x2, c.y2, c.x, c.y));
        outv.push({ x: 0, y: 0 });
        curX = c.x; curY = c.y;
        break;
      }
      case 'Z': {
        if (open) {
          const n = v.length;
          // Explicit final segment back to the start duplicates vertex 0: fold its
          // incoming tangent into vertex 0 and drop it (Rive auto-closes last->first).
          if (n > 1 && Math.hypot(v[n - 1].x - v[0].x, v[n - 1].y - v[0].y) < 1e-3) {
            inv[0] = inv[n - 1];
            v.pop(); inv.pop(); outv.pop();
          }
          finish(true);
        }
        curX = startX; curY = startY;
        break;
      }
      case 'A':
        break; // unreachable: pathToCubics rewrote all arcs
    }
  }
  if (open) finish(false);
  return subs;
}

/** Vertex point + in/out tangent offsets -> Rive detached-cubic polar handles. */
function toPolar(
  pt: { x: number; y: number },
  inOff: { x: number; y: number },
  outOff: { x: number; y: number },
): RivVertex {
  return {
    x: pt.x, y: pt.y,
    inRot: Math.atan2(inOff.y, inOff.x),
    inDist: Math.hypot(inOff.x, inOff.y),
    outRot: Math.atan2(outOff.y, outOff.x),
    outDist: Math.hypot(outOff.x, outOff.y),
  };
}

// ---- Small helpers ----

/** Sorted copy of a track's keyframes (empty when the track is missing). */
function keysOf(track: Track | undefined): Keyframe[] {
  return [...(track?.keyframes ?? [])].sort((a, b) => a.time - b.time);
}

/** ms -> integer frame at 60 fps. */
function toFrame(ms: number): number {
  return Math.round((ms / 1000) * FPS);
}

/**
 * Cubic-bezier handles for the segment arriving at `key`, or null for a linear segment.
 * Keyframe.bezier (custom curve editor) overrides the preset everywhere.
 */
function cubicFor(key: Keyframe): [number, number, number, number] | null {
  if (key.bezier) return [key.bezier[0], key.bezier[1], key.bezier[2], key.bezier[3]];
  if (key.easing === 'linear') return null;
  return EASING_CUBIC[key.easing];
}

/**
 * #rgb / #rrggbb + opacity -> packed ARGB uint32 (0xAARRGGBB). Rive folds paint opacity
 * into the SolidColor's alpha (there is no separate paint-opacity property). Unparseable
 * colors fall back to opaque black.
 */
function argb(value: string, opacity: number): number {
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  let r = 0, g = 0, b = 0;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  }
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return (((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
}

/** @internal Exposed for unit tests only — not part of the public export surface. */
export const __riv = { ByteWriter, argb, toFrame, cubicFor, FIELD_TYPE, EASING_CUBIC, COND_OP, LISTENER_TYPE };
