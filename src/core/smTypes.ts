// ---- State machines ----
//
// Rive-style interactive animation graphs. A machine wires named INPUTS (bool/number/
// trigger) into STATES (each an animation clip, plus the special entry/any/exit nodes)
// connected by TRANSITIONS whose CONDITIONS gate them. LISTENERS map canvas pointer
// events on a part to input mutations. Shapes mirror Rive's own semantics so the .riv
// exporter can map 1:1. The runtime evaluator lives in stateMachine.ts (pure, no DOM).

export type SMInputType = 'bool' | 'number' | 'trigger';

export interface SMInput {
  id: string;
  name: string;
  type: SMInputType;
  /** Initial value (bool/number). Triggers start disarmed and take no default. */
  default?: boolean | number;
}

/**
 * 'entry' is the graph's start node (resolved once at create/reset); 'any' is a
 * source-only node whose transitions may fire from any state; 'exit' ends the machine
 * (done); 'animation' plays a clip by name.
 */
export type SMStateKind = 'entry' | 'any' | 'exit' | 'animation';

export interface SMState {
  id: string;
  name: string;
  kind: SMStateKind;
  /** The clip this state plays (kind 'animation' only). A dangling name samples rest. */
  clipName?: string;
  /** Cosmetic graph-editor position (smPanel). Persisted for free; never affects runtime. */
  x?: number;
  y?: number;
}

export type SMConditionOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface SMCondition {
  inputId: string;
  /** Comparison operator. Bool inputs accept only ==/!= (missing = ==); triggers ignore it. */
  op?: SMConditionOp;
  /** Right-hand value (bool/number). Trigger conditions omit it — they fire when armed. */
  value?: boolean | number;
}

export interface SMTransition {
  id: string;
  fromId: string;
  toId: string;
  /** Crossfade length into the target state, ms. 0 = instant. */
  durationMs: number;
  /** ANDed together; an empty list is an unconditional transition. */
  conditions: SMCondition[];
  /**
   * Exit time: a fraction 0..1 of the FROM clip's duration that must play before this
   * transition becomes eligible (conditions still AND on top). Rive parity — the editor
   * presents 1.0 as "wait for animation to finish". Only meaningful when the FROM state
   * is an ANIMATION state; normalizeDoc clamps it to [0,1] and strips it (→ null) from
   * transitions leaving entry/any/exit. null/absent = no exit-time gate (fires as soon as
   * conditions pass, today's behavior).
   */
  exitFraction?: number | null;
}

export interface SMListenerAction {
  inputId: string;
  type: 'setBool' | 'setNumber' | 'fireTrigger';
  value?: boolean | number;
}

export interface SMListener {
  id: string;
  targetPartId: string;
  event: 'down' | 'up' | 'enter' | 'exit';
  actions: SMListenerAction[];
}

export interface StateMachine {
  id: string;
  name: string;
  inputs: SMInput[];
  states: SMState[];
  transitions: SMTransition[];
  listeners: SMListener[];
}
