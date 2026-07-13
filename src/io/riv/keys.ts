/**
 * TypeKey/propertyKey table for the Rive (.riv) exporter, derived from rive-runtime
 * dev/defs (NOT from memory — table cited below), plus the small shared format
 * constants (FPS/DEG2RAD), the easing->cubic-bezier table, and the enum maps
 * (condition ops, listener types) the exporter and state-machine emitter write.
 * Backing type in [brackets]: U=uint/bool D=double S=string C=color.
 *
 * TYPE/PROPERTY KEY TABLE (int typeKey / propertyKey -> def file under
 * rive-runtime/dev/defs).
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
 *   duration         = 158 [U]    | state_transition.json           | mix MS (flags omits bit 2)
 *   flags            = 152 [U]    | state_transition.json           | StateTransitionFlags bits
 *   exitTime         = 160 [U]    | state_transition.json           | exit-time (ms, or % if the
 *                                 |                                 | ExitTimeIsPercentage flag set)
 *   targetId         = 224 [U]    | state_machine_listener.json      | artboard component index
 *   listenerTypeValue= 225 [U]    | state_machine_listener_single.json| ListenerType enum
 *   listenerInputId  = 227 [U]    | listener_input_change.json      | index into machine inputs
 *   listenerBoolVal  = 228 [U]    | listener_bool_change.json       | 0/1
 *   listenerNumberVal= 229 [D]    | listener_number_change.json     | number
 *
 *   TransitionConditionOp (transition_condition_op.hpp): equal 0, notEqual 1,
 *     lessThanOrEqual 2, greaterThanOrEqual 3, lessThan 4, greaterThan 5.
 *   ListenerType (listener_type.hpp): enter 0, exit 1, down 2, up 3.
 *   StateTransitionFlags (include/rive/animation/state_transition_flags.hpp, verified
 *     against master): None 0, Disabled 1, DurationIsPercentage 2, EnableExitTime 4,
 *     ExitTimeIsPercentage 8, PauseOnExit 16, EnableEarlyExit 32. The blend `duration`
 *     stays MS (DurationIsPercentage clear). EXIT TIME: exitFraction (0..1 of the FROM
 *     clip) maps to exitTime as a PERCENTAGE — flags = EnableExitTime|ExitTimeIsPercentage
 *     (4|8 = 12) and exitTime = round(fraction*100) — so it is clip-duration-independent
 *     and 1.0 == 100% == "wait for the animation to finish". EnableEarlyExit is left clear
 *     so conditions are only honored at/after the exit time (matching our evaluator, whose
 *     conditions AND with the exit-time gate). flags/exitTime are emitted ONLY when a
 *     transition leaving an ANIMATION state carries an exitFraction; every other transition
 *     omits both keys, so a doc without exit times exports byte-identically to before.
 */

import { Easing, SMConditionOp, SMListener } from '../../core/model';

// ---- Shared format constants ----

export const FPS = 60;
export const DEG2RAD = Math.PI / 180;

// typeKeys
export const T_BACKBOARD = 23;
export const T_ARTBOARD = 1;
export const T_NODE = 2;
export const T_SHAPE = 3;
export const T_POINTS_PATH = 16;
export const T_CUBIC_VERTEX = 6;
export const T_FILL = 20;
export const T_STROKE = 24;
export const T_SOLID_COLOR = 18;
export const T_CUBIC_INTERP = 28;
export const T_LINEAR_ANIM = 31;
export const T_KEYED_OBJECT = 25;
export const T_KEYED_PROPERTY = 26;
export const T_KEYFRAME_DOUBLE = 30;

// State-machine typeKeys (animation/*.json). None of these consume an artboard
// component index: like animations, they are added to the artboard's separate
// state-machine list (src/importers/artboard_importer.cpp addStateMachine), NOT to the
// component object list that id references resolve against (addObject/addComponent).
export const T_STATE_MACHINE = 53; // state_machine.json (name from state_machine_component 138)
export const T_SM_BOOL = 59; // state_machine_bool.json (value 141)
export const T_SM_NUMBER = 56; // state_machine_number.json (value 140)
export const T_SM_TRIGGER = 58; // state_machine_trigger.json (no value)
export const T_SM_LAYER = 57; // state_machine_layer.json
export const T_ENTRY_STATE = 63; // entry_state.json
export const T_ANY_STATE = 62; // any_state.json
export const T_EXIT_STATE = 64; // exit_state.json
export const T_ANIMATION_STATE = 61; // animation_state.json (animationId 149)
export const T_STATE_TRANSITION = 65; // state_transition.json (stateToId 151, duration 158, flags 152, exitTime 160)
export const T_TRANS_TRIGGER_COND = 68; // transition_trigger_condition.json (inputId 155)
export const T_TRANS_NUMBER_COND = 70; // transition_number_condition.json (inputId 155, opValue 156, value 157)
export const T_TRANS_BOOL_COND = 71; // transition_bool_condition.json (inputId 155, opValue 156)
export const T_SM_LISTENER = 114; // state_machine_listener_single.json (targetId 224, listenerTypeValue 225)
export const T_LISTENER_TRIGGER_CHANGE = 115; // listener_trigger_change.json (inputId 227)
export const T_LISTENER_BOOL_CHANGE = 117; // listener_bool_change.json (inputId 227, value 228)
export const T_LISTENER_NUMBER_CHANGE = 118; // listener_number_change.json (inputId 227, value 229)

// propertyKeys
export const P_NAME = 4;
export const P_PARENT_ID = 5;
export const P_WIDTH = 7;
export const P_HEIGHT = 8;
export const P_NODE_X = 13;
export const P_NODE_Y = 14;
export const P_ROTATION = 15;
export const P_SCALE_X = 16;
export const P_SCALE_Y = 17;
export const P_VERT_X = 24;
export const P_VERT_Y = 25;
export const P_IS_CLOSED = 32;
export const P_COLOR = 37;
export const P_THICKNESS = 47;
export const P_OBJECT_ID = 51;
export const P_PROPERTY_KEY = 53;
export const P_ANIM_NAME = 55; // Animation.name (animation.json) — NOT Component.name (4)
export const P_FPS = 56;
export const P_DURATION = 57;
export const P_LOOP = 59;
export const P_X1 = 63;
export const P_Y1 = 64;
export const P_X2 = 65;
export const P_Y2 = 66;
export const P_FRAME = 67;
export const P_INTERP_TYPE = 68;
export const P_INTERPOLATOR_ID = 69;
export const P_VALUE = 70;
export const P_IN_ROTATION = 84;
export const P_IN_DISTANCE = 85;
export const P_OUT_ROTATION = 86;
export const P_OUT_DISTANCE = 87;

// State-machine propertyKeys.
export const P_SM_NAME = 138; // [S] StateMachineComponent.name — machine/input names (addressed by name at runtime)
export const P_SM_NUMBER_VALUE = 140; // [D] StateMachineNumber.value (default)
export const P_SM_BOOL_VALUE = 141; // [U/bool] StateMachineBool.value (default)
export const P_ANIMATION_ID = 149; // [U] AnimationState.animationId (index into artboard LinearAnimations)
export const P_STATE_TO_ID = 151; // [U] StateTransition.stateToId (index into the layer's states)
export const P_COND_INPUT_ID = 155; // [U] TransitionInputCondition.inputId (index into machine inputs)
export const P_COND_OP = 156; // [U] TransitionValueCondition.opValue (TransitionConditionOp enum)
export const P_COND_VALUE = 157; // [D] TransitionNumberCondition.value
export const P_TRANS_DURATION = 158; // [U] StateTransition.duration (blend/mix ms; flags default 0 => ms)
export const P_TRANS_FLAGS = 152; // [U] StateTransition.flags (StateTransitionFlags bits)
export const P_TRANS_EXIT_TIME = 160; // [U] StateTransition.exitTime (ms, or % when ExitTimeIsPercentage set)
export const P_LISTENER_TARGET_ID = 224; // [U] StateMachineListener.targetId (artboard component index)

// StateTransitionFlags bits (state_transition_flags.hpp). We set EnableExitTime|
// ExitTimeIsPercentage for an exit-time transition; everything else stays clear.
export const F_ENABLE_EXIT_TIME = 4;
export const F_EXIT_TIME_IS_PERCENTAGE = 8;
export const P_LISTENER_TYPE = 225; // [U] StateMachineListenerSingle.listenerTypeValue (ListenerType enum)
export const P_LISTENER_INPUT_ID = 227; // [U] ListenerInputChange.inputId (index into machine inputs)
export const P_LISTENER_BOOL_VALUE = 228; // [U] ListenerBoolChange.value
export const P_LISTENER_NUMBER_VALUE = 229; // [D] ListenerNumberChange.value

// ToC backing-type indices.
const F_UINT = 0;
const F_STRING = 1;
const F_DOUBLE = 2;
const F_COLOR = 3;

/** Backing type for every property key this exporter can write (for the ToC). */
export const FIELD_TYPE: Record<number, number> = {
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
  [P_TRANS_FLAGS]: F_UINT,
  [P_TRANS_EXIT_TIME]: F_UINT,
  [P_LISTENER_TARGET_ID]: F_UINT,
  [P_LISTENER_TYPE]: F_UINT,
  [P_LISTENER_INPUT_ID]: F_UINT,
  [P_LISTENER_BOOL_VALUE]: F_UINT,
  [P_LISTENER_NUMBER_VALUE]: F_DOUBLE,
};

// TransitionConditionOp enum (include/rive/animation/transition_condition_op.hpp).
// NOTE the non-obvious ordering: <= and >= come BEFORE < and >.
export const COND_OP: Record<SMConditionOp, number> = {
  '==': 0, // equal
  '!=': 1, // notEqual
  '<=': 2, // lessThanOrEqual
  '>=': 3, // greaterThanOrEqual
  '<': 4, // lessThan
  '>': 5, // greaterThan
};

// ListenerType enum (include/rive/listener_type.hpp): enter 0, exit 1, down 2, up 3.
export const LISTENER_TYPE: Record<SMListener['event'], number> = {
  enter: 0,
  exit: 1,
  down: 2,
  up: 3,
};

// Rive keyframe interpolation enum (interpolationType). Linear needs no interpolator;
// cubic references a CubicEaseInterpolator by index. (Hold=0/Linear=1/Cubic=2.)
export const INTERP_LINEAR = 1;
export const INTERP_CUBIC = 2;

/**
 * Studio easings -> cubic-bezier control points (x1,y1,x2,y2). Identical to
 * exportLottie.ts's EASING_BEZIER so the two exporters bend the same way; the studio's
 * model easings are quadratic/smoothstep and both exporters approximate them with these
 * handles. `linear` is emitted as a true linear segment (no interpolator) instead.
 */
export const EASING_CUBIC: Record<Exclude<Easing, 'linear'>, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};
