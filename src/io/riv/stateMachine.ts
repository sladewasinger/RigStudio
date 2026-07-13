import { RigDoc, SMConditionOp, SMState } from '../../core/model';
import { Scene } from './writer';
import {
  COND_OP, LISTENER_TYPE, P_ANIM_NAME, P_ANIMATION_ID, P_COND_INPUT_ID, P_COND_OP,
  P_COND_VALUE, P_LISTENER_BOOL_VALUE, P_LISTENER_INPUT_ID, P_LISTENER_NUMBER_VALUE,
  P_LISTENER_TARGET_ID, P_LISTENER_TYPE, P_SM_BOOL_VALUE, P_SM_NAME, P_SM_NUMBER_VALUE,
  P_STATE_TO_ID, P_TRANS_DURATION, P_TRANS_EXIT_TIME, P_TRANS_FLAGS,
  F_ENABLE_EXIT_TIME, F_EXIT_TIME_IS_PERCENTAGE,
  T_ANIMATION_STATE, T_ANY_STATE, T_ENTRY_STATE, T_EXIT_STATE, T_LISTENER_BOOL_CHANGE,
  T_LISTENER_NUMBER_CHANGE, T_LISTENER_TRIGGER_CHANGE, T_SM_BOOL, T_SM_LAYER, T_SM_LISTENER,
  T_SM_NUMBER, T_SM_TRIGGER, T_STATE_MACHINE, T_STATE_TRANSITION, T_TRANS_BOOL_COND,
  T_TRANS_NUMBER_COND, T_TRANS_TRIGGER_COND,
} from './keys';

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
 *    (bit value 2, state_transition_flags.hpp). With NO exitFraction, flags stays absent
 *    (default 0) so the transition fires as soon as conditions pass. WITH an exitFraction
 *    on an animation-state transition, flags = EnableExitTime|ExitTimeIsPercentage (12) and
 *    exitTime (key 160) = round(fraction*100): a percentage exit time, clip-duration-free.
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
 *  - Listener event type is carried on StateMachineListenerSingle.listenerTypeValue (the
 *    classic representation). Very new runtimes that read the type only from separate
 *    ListenerInputType child objects may not fire pointer listeners; the rest of the
 *    machine (inputs/states/transitions) is unaffected.
 */
export function emitStateMachines(scene: Scene, doc: RigDoc, partIndex: Map<string, number>): void {
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
        // Exit time: only for a transition leaving an ANIMATION state (Rive ignores it on
        // entry/any/exit; normalizeDoc already strips it there). Emitted as a PERCENTAGE
        // (flags EnableExitTime|ExitTimeIsPercentage) so it is independent of the clip's
        // frame duration — exitFraction 1.0 => exitTime 100 => "wait for the animation to
        // finish". Absent exitFraction emits neither key, keeping non-exit docs byte-stable.
        if (st.kind === 'animation' && tr.exitFraction !== null && tr.exitFraction !== undefined) {
          const frac = Math.min(1, Math.max(0, tr.exitFraction));
          scene.propUint(P_TRANS_FLAGS, F_ENABLE_EXIT_TIME | F_EXIT_TIME_IS_PERCENTAGE);
          scene.propUint(P_TRANS_EXIT_TIME, Math.round(frac * 100));
        }
        // blend/mix duration (omitted when 0 => instant; DurationIsPercentage stays clear).
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
