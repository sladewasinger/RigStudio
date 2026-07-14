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
 *
 * DRAW ORDER (DrawRules/DrawTarget) + PER-KEYFRAME-TYPE KEYS (.riv export completions wave,
 * 2026-07-13). Pinned from rive-runtime dev/defs (main branch) + src, fetched directly —
 * see io/riv/drawRules.ts's header for the full mechanism writeup and citations.
 *
 *   Object (typeKey)   | def                            | notes
 *   -------------------|--------------------------------|-------------------------------------
 *   DrawTarget    = 48 | draw_target.json               | drawableId(119)/placementValue(120)
 *   DrawRules     = 49 | draw_rules.json                | drawTargetId(121), ANIMATES
 *   KeyFrameColor = 37 | animation/keyframe_color.json  | value(88); extends InterpolatingKeyFrame
 *                      |                                | (frame/interpolationType/interpolatorId
 *                      |                                | are the SAME 67/68/69 keys KeyFrameDouble
 *                      |                                | uses) - real lerp per src/animation/
 *                      |                                | keyframe_color.cpp's colorLerp, so custom
 *                      |                                | bezier/easing works exactly like doubles.
 *   KeyFrameId    = 50 | animation/keyframe_id.json     | value(122); src/animation/keyframe_id.cpp's
 *                      |                                | apply()/applyInterpolation() BOTH hard-SET
 *                      |                                | the frame's raw value regardless of
 *                      |                                | interpolationType/mix - inherently a HOLD,
 *                      |                                | matching this app's stepped `z` channel.
 *
 *   Property (propertyKey)     | owner def                     | type  | notes
 *   ----------------------------|-------------------------------|-------|---------------------
 *   drawableId     = 119 [U]    | draw_target.json              | Id    | DrawTarget's anchor
 *   placementValue = 120 [U]    | draw_target.json              | uint  | DrawTargetPlacement enum
 *   drawTargetId   = 121 [U]    | draw_rules.json               | Id    | ANIMATABLE; -1/missing
 *                                |                               |       | = inactive (normal spot)
 *   keyframeIdValue    = 122 [U]| animation/keyframe_id.json    | Id    | KeyFrameId.value
 *   keyframeColorValue = 88 [C] | animation/keyframe_color.json | Color | KeyFrameColor.value
 *
 *   DrawTargetPlacement (include/rive/draw_target_placement.hpp): before=0, after=1. Given
 *   this exporter's REVERSED shape-emission (first-in-file = topmost, see scene.ts's draw-
 *   order comment) and the prev/next splice in src/artboard.cpp's Artboard::sortDrawOrder,
 *   `before` renders the ruled group IN FRONT OF (more topmost than) its DrawTarget's anchor
 *   and `after` renders it BEHIND - traced and documented in drawRules.ts.
 *
 * SKELETAL DEFORMATION (Skin/Tendon/Weight — the skinned-part export wave, 2026-07-13).
 * Pinned from rive-runtime dev/defs bones/*.json + src/bones/*.cpp, fetched directly.
 *
 *   Object (typeKey)      | def                        | notes
 *   ----------------------|----------------------------|----------------------------------
 *   Bone           = 40   | bones/bone.json            | length(89); NOT emitted — a plain
 *                         |                            | Bone requires a Bone parent
 *                         | (bone.cpp onAddedClean) and derives its origin from the
 *                         | parent's length (x() == parent length, y() == 0), while this
 *                         | editor's chains root on art/groups and attachedRoot bones
 *                         | carry LOOSE offsets — so every bone exports as a RootBone.
 *   RootBone       = 41   | bones/root_bone.json       | x(90)/y(91); root_bone.cpp
 *                         |                            | SKIPS Bone's parent check
 *                         | (calls TransformComponent::onAddedClean directly), so any
 *                         | TransformComponent parent — Node, Shape, another bone — is
 *                         | valid, and x/y/rotation compose EXACTLY like a Node's. That
 *                         | keeps this exporter's verified pivot-relative placement math
 *                         | byte-for-byte identical to the old Node emission; Tendon only
 *                         | needs is<Bone>() (tendon.cpp), which RootBone satisfies.
 *   Skin           = 43   | bones/skin.json            | child of the SKINNED PointsPath
 *                         |                            | (skin.cpp: Skinnable::from(parent()));
 *                         | xx..ty = the path's BIND world transform, applied to stored
 *                         | vertices BEFORE the blended bone deltas (weight.cpp deform:
 *                         | final = blended * (world * inPoint)).
 *   Tendon         = 44   | bones/tendon.json          | child of the Skin (addTendon, file
 *                         |                            | order = tendon order); boneId(95)
 *                         | must resolve to a Bone; xx..ty = the bone's BIND world
 *                         | transform — the runtime inverts it (m_InverseBind) and each
 *                         | frame computes boneWorld * inverseBind (skin.cpp update).
 *   Weight         = 45   | bones/weight.json          | child of a Vertex; NOT emitted —
 *                         |                            | every vertex here is a
 *                         | CubicDetachedVertex, whose handles need the Cubic form.
 *   CubicWeight    = 46   | bones/cubic_weight.json    | extends Weight: values/indices for
 *                         |                            | the point + in/out pairs for the
 *                         | two handles. Emitted for EVERY vertex of a skinned path
 *                         | (Vertex::deform dereferences its weight unconditionally).
 *
 *   Property (propertyKey)   | owner def             | type | notes
 *   --------------------------|-----------------------|------|------------------------------
 *   length          =  89 [D] | bones/bone.json       |      | cosmetic for RootBone-only
 *                             |                       |      | rigs (child POSITIONING uses
 *                             |                       |      | it only for plain Bones)
 *   x (root bone)   =  90 [D] | bones/root_bone.json  |      | NOT Node.x(13) — RootBone has
 *   y (root bone)   =  91 [D] | bones/root_bone.json  |      | its own keys; animation.ts
 *                             |                       |      | maps keyed bone tx/ty here
 *   boneId          =  95 [U] | bones/tendon.json     | Id   | artboard component index
 *   tendon xx       =  96 [D] | bones/tendon.json     |      | PROPERTY-KEY ORDER IS
 *   tendon yx       =  97 [D] | bones/tendon.json     |      | xx, yx, xy, yy (NOT xx,xy,..)
 *   tendon xy       =  98 [D] | bones/tendon.json     |      | but the NAMES map to Mat2D
 *   tendon yy       =  99 [D] | bones/tendon.json     |      | slots [xx, xy, yx, yy, tx, ty]
 *   tendon tx       = 100 [D] | bones/tendon.json     |      | (tendon.cpp: bind[0]=xx(),
 *   tendon ty       = 101 [D] | bones/tendon.json     |      | bind[1]=xy(), bind[2]=yx()…)
 *   weight values   = 102 [U] | bones/weight.json     |      | 4 packed bytes, byte i =
 *                             |                       |      | influence i's weight 0..255
 *                             |                       |      | (weight.cpp encodedWeightValue
 *                             |                       |      | = (data >> i*8) & 0xFF); the
 *                             |                       |      | four SHOULD sum to 255
 *   weight indices  = 103 [U] | bones/weight.json     |      | 4 packed bytes, byte i = the
 *                             |                       |      | influence's index into the
 *                             |                       |      | bone-transform buffer, which
 *                             |                       |      | is 1-BASED: slot 0 is identity,
 *                             |                       |      | tendon k lives at slot k+1
 *                             |                       |      | (skin.cpp sizes it
 *                             |                       |      | (tendons+1)*6 with identity
 *                             |                       |      | first) — 0 = "unbound"
 *   skin xx..ty     = 104..109 [D] | bones/skin.json  |      | SAME xx,yx,xy,yy,tx,ty key
 *                             |                       |      | order as tendon (104=xx,
 *                             |                       |      | 105=yx, 106=xy, 107=yy)
 *   in/out values/indices = 110..113 [U] | bones/cubic_weight.json | inValues 110,
 *                             |                       |      | inIndices 111, outValues 112,
 *                             |                       |      | outIndices 113
 */

import { Easing, SMConditionOp, SMListener } from '../../core/model';

// ---- Shared format constants ----

/** Fallback animation fps when a doc carries no (or an invalid) `doc.fps` — matches the
 *  pre-doc.fps hardcoded value, so every doc that never sets fps exports byte-identically
 *  to before (Category B item 2: doc.fps threading, 2026-07-13). The real per-doc value
 *  is resolved once in animation.ts's `emitAnimations` and threaded through from there. */
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
export const T_DRAW_TARGET = 48; // draw_target.json
export const T_DRAW_RULES = 49; // draw_rules.json
export const T_KEYFRAME_COLOR = 37; // animation/keyframe_color.json
export const T_KEYFRAME_ID = 50; // animation/keyframe_id.json
// Skeletal deformation (see the header table for why RootBone/CubicWeight are the only
// bone/weight types this exporter ever writes).
export const T_ROOT_BONE = 41; // bones/root_bone.json
export const T_SKIN = 43; // bones/skin.json
export const T_TENDON = 44; // bones/tendon.json
export const T_CUBIC_WEIGHT = 46; // bones/cubic_weight.json

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
export const P_KEYFRAME_COLOR_VALUE = 88; // [C] KeyFrameColor.value — NOT SolidColor.colorValue (37)
// Skeletal deformation. NOTE the xx,yx,xy,yy property-key order on tendon/skin matrices
// (header table cites tendon.cpp's Mat2D slot assignment — swapping 97/98 or 105/106
// transposes every bind matrix).
export const P_BONE_LENGTH = 89; // [D] Bone.length
export const P_ROOT_BONE_X = 90; // [D] RootBone.x — NOT Node.x (13)
export const P_ROOT_BONE_Y = 91; // [D] RootBone.y — NOT Node.y (14)
export const P_TENDON_BONE_ID = 95; // [U] Tendon.boneId (artboard component index)
export const P_TENDON_XX = 96; // [D] Tendon bind matrix — Mat {a, c, b, d, e, f} in
export const P_TENDON_YX = 97; // [D] key order 96..101 (SVG a=xx, b=xy, c=yx, d=yy)
export const P_TENDON_XY = 98; // [D]
export const P_TENDON_YY = 99; // [D]
export const P_TENDON_TX = 100; // [D]
export const P_TENDON_TY = 101; // [D]
export const P_WEIGHT_VALUES = 102; // [U] 4 packed weight bytes (should sum to 255)
export const P_WEIGHT_INDICES = 103; // [U] 4 packed 1-BASED tendon slots (0 = unbound)
export const P_SKIN_XX = 104; // [D] Skin bind matrix — same xx,yx,xy,yy,tx,ty key order
export const P_SKIN_YX = 105; // [D]
export const P_SKIN_XY = 106; // [D]
export const P_SKIN_YY = 107; // [D]
export const P_SKIN_TX = 108; // [D]
export const P_SKIN_TY = 109; // [D]
export const P_WEIGHT_IN_VALUES = 110; // [U] CubicWeight in-handle weights
export const P_WEIGHT_IN_INDICES = 111; // [U]
export const P_WEIGHT_OUT_VALUES = 112; // [U] CubicWeight out-handle weights
export const P_WEIGHT_OUT_INDICES = 113; // [U]
export const P_DRAWABLE_ID = 119; // [U] DrawTarget.drawableId (Id)
export const P_PLACEMENT_VALUE = 120; // [U] DrawTarget.placementValue (DrawTargetPlacement enum)
export const P_DRAW_TARGET_ID = 121; // [U] DrawRules.drawTargetId (Id, ANIMATABLE)
export const P_KEYFRAME_ID_VALUE = 122; // [U] KeyFrameId.value — NOT KeyFrameDouble.value (70)

// DrawTargetPlacement (include/rive/draw_target_placement.hpp). See the header comment
// above for the before=in-front / after=behind mapping under this exporter's conventions.
export const PLACEMENT_BEFORE = 0;
export const PLACEMENT_AFTER = 1;

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
  [P_KEYFRAME_COLOR_VALUE]: F_COLOR,
  [P_DRAWABLE_ID]: F_UINT,
  [P_PLACEMENT_VALUE]: F_UINT,
  [P_DRAW_TARGET_ID]: F_UINT,
  [P_KEYFRAME_ID_VALUE]: F_UINT,
  [P_BONE_LENGTH]: F_DOUBLE,
  [P_ROOT_BONE_X]: F_DOUBLE,
  [P_ROOT_BONE_Y]: F_DOUBLE,
  [P_TENDON_BONE_ID]: F_UINT,
  [P_TENDON_XX]: F_DOUBLE,
  [P_TENDON_YX]: F_DOUBLE,
  [P_TENDON_XY]: F_DOUBLE,
  [P_TENDON_YY]: F_DOUBLE,
  [P_TENDON_TX]: F_DOUBLE,
  [P_TENDON_TY]: F_DOUBLE,
  [P_WEIGHT_VALUES]: F_UINT,
  [P_WEIGHT_INDICES]: F_UINT,
  [P_SKIN_XX]: F_DOUBLE,
  [P_SKIN_YX]: F_DOUBLE,
  [P_SKIN_XY]: F_DOUBLE,
  [P_SKIN_YY]: F_DOUBLE,
  [P_SKIN_TX]: F_DOUBLE,
  [P_SKIN_TY]: F_DOUBLE,
  [P_WEIGHT_IN_VALUES]: F_UINT,
  [P_WEIGHT_IN_INDICES]: F_UINT,
  [P_WEIGHT_OUT_VALUES]: F_UINT,
  [P_WEIGHT_OUT_INDICES]: F_UINT,
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

/**
 * #rgb / #rrggbb + opacity -> packed ARGB uint32 (0xAARRGGBB). Rive folds paint opacity
 * into the SolidColor's alpha (there is no separate paint-opacity property). Unparseable
 * colors fall back to opaque black. Lives here (not scene.ts) so both scene.ts (the static
 * fold) and animation.ts (keyed opacity's per-frame color, drawRules.ts's neighbors) can
 * import it without scene.ts <-> animation.ts import cycles.
 */
export function argb(value: string, opacity: number): number {
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
