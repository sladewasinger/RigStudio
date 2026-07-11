/**
 * Pure runtime evaluator for the Rive-style state machines defined in model.ts.
 *
 * NO DOM and NO app-state access: an SMInstance is a self-contained clock driven only
 * by advance(dtMs) plus input mutations, so it is fully deterministic (no Date.now / no
 * random). It samples the document's clips with the SAME "keyed values are absolute,
 * rest fills unkeyed channels" rule as model.channelValue, crossfading two clips during
 * a blend.
 *
 * ---------------------------------------------------------------------------
 * Edge-case decisions (each documented at its site below):
 *  - Entry is resolved ONCE at create/reset. If no entry transition passes we fall to a
 *    "rest" pseudo-state (SM_REST_STATE_ID) that samples pure rest pose; from there only
 *    'any' transitions can move us (entry transitions are not re-evaluated per frame).
 *  - advance(dt) EVALUATES transitions first (any-state, then current-state, in array
 *    order — at most ONE fires, which guarantees termination), THEN consumes triggers,
 *    THEN integrates time. Evaluating before integrating lets a single advance(dur/2)
 *    reach a clean blend midpoint after the input that fires the transition is set.
 *  - A crossfade runs both clocks and lerps per channel: out*(1-t) + in*t. A transition
 *    firing mid-blend retargets FROM the incoming state (the old outgoing side is
 *    dropped — never more than one blend at a time).
 *  - Triggers arm on fireTrigger and survive until an advance's evaluation, after which
 *    they are cleared whether or not they fired anything.
 *  - Entering 'exit' sets done and FREEZES the pre-exit pose (advance becomes a no-op).
 *  - Malformed conditions evaluate false; the evaluator never throws.
 * ---------------------------------------------------------------------------
 */

import {
  CHANNEL_DEFAULTS,
  Channel,
  Clip,
  RigDoc,
  SMCondition,
  SMState,
  StateMachine,
  sampleKeyList,
} from './model';

/** Sentinel state id for the "rest" pseudo-state (no clip → pure rest pose). */
export const SM_REST_STATE_ID = '__rest__';

/** A crossfade in progress: which state we are blending out of, and how far (0..1). */
export interface SMBlendInfo {
  fromStateId: string;
  progress: number;
}

export interface SMStatus {
  /** The current state's id (SM_REST_STATE_ID when resting, the exit id once done). */
  stateId: string;
  /** The current sampling clock's time within its clip (ms). */
  timeMs: number;
  blend: SMBlendInfo | null;
  done: boolean;
}

export interface SMInstance {
  advance(dtMs: number): void;
  /** Set a bool/number input by NAME (Rive addresses inputs by name at runtime). */
  setInput(name: string, value: boolean | number): void;
  /** Arm a trigger input by NAME. */
  fireTrigger(name: string): void;
  /** Blended, absolute-keys/rest-fallback sample of a target part's channel. */
  channelValue(target: string, channel: Channel): number;
  status(): SMStatus;
  /** Rewind to entry resolution with every input back at its default. */
  reset(): void;
}

/** A sampling clock: which state's clip we are in, and the elapsed time within it. */
interface Clock {
  stateId: string;
  timeMs: number;
}

interface Blend {
  from: Clock;
  progress: number;
  durationMs: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

class Instance implements SMInstance {
  private current: Clock = { stateId: SM_REST_STATE_ID, timeMs: 0 };
  private blend: Blend | null = null;
  private done = false;
  private exitStateId: string | null = null;

  private readonly boolValues = new Map<string, boolean>();
  private readonly numberValues = new Map<string, number>();
  private readonly armed = new Set<string>(); // trigger input ids currently armed

  private readonly statesById: Map<string, SMState>;
  private readonly inputById = new Map<string, { type: string; def?: boolean | number }>();
  private readonly inputByName = new Map<string, { id: string; type: string }>();

  constructor(private readonly doc: RigDoc, private readonly sm: StateMachine) {
    this.statesById = new Map(sm.states.map((s) => [s.id, s]));
    for (const inp of sm.inputs) {
      this.inputById.set(inp.id, { type: inp.type, def: inp.default });
      this.inputByName.set(inp.name, { id: inp.id, type: inp.type });
    }
    this.reset();
  }

  // ---- Public API ----

  reset(): void {
    this.boolValues.clear();
    this.numberValues.clear();
    this.armed.clear();
    for (const inp of this.sm.inputs) {
      if (inp.type === 'bool') this.boolValues.set(inp.id, inp.default === true);
      else if (inp.type === 'number') {
        this.numberValues.set(inp.id, typeof inp.default === 'number' ? inp.default : 0);
      }
      // triggers start disarmed
    }
    this.blend = null;
    this.done = false;
    this.exitStateId = null;
    this.resolveEntry();
  }

  setInput(name: string, value: boolean | number): void {
    const inp = this.inputByName.get(name);
    if (!inp) return; // unknown input — no-op, never throws
    if (inp.type === 'bool') this.boolValues.set(inp.id, !!value);
    else if (inp.type === 'number') {
      this.numberValues.set(inp.id, typeof value === 'number' ? value : value ? 1 : 0);
    }
    // triggers are armed via fireTrigger, not setInput
  }

  fireTrigger(name: string): void {
    const inp = this.inputByName.get(name);
    if (!inp || inp.type !== 'trigger') return;
    this.armed.add(inp.id);
  }

  advance(dtMs: number): void {
    if (this.done) return; // exit reached — advance is a no-op, pose stays frozen

    // 1) Transitions: 'any' (skip-self) first, then the current state, array order.
    this.evaluateTransitions();
    // 2) Triggers are consumed after the frame's evaluation, fired or not.
    this.armed.clear();
    // Entering 'exit' this frame freezes the pose — skip time integration.
    if (this.done) return;

    // 3) Integrate time on the current clock (and the outgoing side of a blend).
    this.current.timeMs += dtMs;
    if (this.blend) {
      this.blend.from.timeMs += dtMs;
      if (this.blend.durationMs > 0) {
        this.blend.progress += dtMs / this.blend.durationMs;
        if (this.blend.progress >= 1) this.blend = null; // crossfade complete
      } else {
        this.blend = null;
      }
    }
  }

  channelValue(target: string, channel: Channel): number {
    const inVal = this.sampleClock(this.current, target, channel);
    if (this.blend) {
      const outVal = this.sampleClock(this.blend.from, target, channel);
      const t = clamp01(this.blend.progress);
      return outVal * (1 - t) + inVal * t;
    }
    return inVal;
  }

  status(): SMStatus {
    return {
      stateId: this.done ? (this.exitStateId ?? this.current.stateId) : this.current.stateId,
      timeMs: this.current.timeMs,
      blend: this.blend
        ? { fromStateId: this.blend.from.stateId, progress: clamp01(this.blend.progress) }
        : null,
      done: this.done,
    };
  }

  // ---- Transition engine ----

  /** Resolve the entry node once: first passing transition wins, else the rest state. */
  private resolveEntry(): void {
    this.current = { stateId: SM_REST_STATE_ID, timeMs: 0 };
    const entry = this.sm.states.find((s) => s.kind === 'entry');
    if (!entry) return; // malformed graph without an entry — stay in rest
    for (const t of this.sm.transitions) {
      if (t.fromId !== entry.id) continue;
      if (this.conditionsPass(t.conditions)) {
        // Entry resolution snaps instantly — there is no prior pose to blend from.
        this.enter(t.toId, 0, false);
        break;
      }
    }
  }

  private evaluateTransitions(): void {
    const curId = this.current.stateId;
    const any = this.sm.states.find((s) => s.kind === 'any');
    if (any) {
      for (const t of this.sm.transitions) {
        if (t.fromId !== any.id) continue;
        if (t.toId === curId) continue; // skip transitions targeting the current state
        if (this.conditionsPass(t.conditions)) {
          this.enter(t.toId, t.durationMs, true);
          return; // at most one transition fires per advance
        }
      }
    }
    if (curId === SM_REST_STATE_ID) return; // rest has no outgoing transitions of its own
    for (const t of this.sm.transitions) {
      if (t.fromId !== curId) continue;
      if (this.conditionsPass(t.conditions)) {
        this.enter(t.toId, t.durationMs, true);
        return;
      }
    }
  }

  /**
   * Move into a target state. Entering 'exit' freezes the current pose and sets done.
   * A durationMs>0 blend crossfades FROM the state we are leaving (this.current); any
   * prior blend is dropped, so we never stack more than one crossfade.
   */
  private enter(toId: string, durationMs: number, allowBlend: boolean): void {
    const target = this.statesById.get(toId);
    if (!target) return; // unresolved target (normalizeDoc prunes these) — no-op
    if (target.kind === 'exit') {
      this.done = true;
      this.exitStateId = toId;
      return; // leave this.current/this.blend untouched → holds the last pose
    }
    const leaving = this.current; // the incoming/current clock we blend out of
    this.blend = allowBlend && durationMs > 0 ? { from: leaving, progress: 0, durationMs } : null;
    this.current = { stateId: toId, timeMs: 0 };
  }

  // ---- Condition evaluation ----

  private conditionsPass(conditions: SMCondition[]): boolean {
    // All conditions AND together; an empty list is unconditional (true).
    for (const c of conditions) if (!this.conditionPasses(c)) return false;
    return true;
  }

  private conditionPasses(c: SMCondition): boolean {
    const inp = this.inputById.get(c.inputId);
    if (!inp) return false; // unresolved input → false, never throws
    if (inp.type === 'trigger') return this.armed.has(c.inputId); // op/value ignored
    if (inp.type === 'bool') {
      // Bool accepts only ==/!= (missing op = ==); anything else is malformed → false.
      if (c.op !== undefined && c.op !== '==' && c.op !== '!=') return false;
      if (typeof c.value !== 'boolean') return false;
      const cur = this.boolValues.get(c.inputId) ?? false;
      return (c.op ?? '==') === '!=' ? cur !== c.value : cur === c.value;
    }
    // number
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return false;
    const cur = this.numberValues.get(c.inputId) ?? 0;
    switch (c.op ?? '==') { // missing op on a number defaults to equality
      case '==': return cur === c.value;
      case '!=': return cur !== c.value;
      case '<': return cur < c.value;
      case '<=': return cur <= c.value;
      case '>': return cur > c.value;
      case '>=': return cur >= c.value;
      default: return false;
    }
  }

  // ---- Sampling ----

  /** Sample one clock's clip for a channel (mirrors model.channelValue's rule). */
  private sampleClock(clock: Clock, target: string, channel: Channel): number {
    const rest = this.restFallback(target, channel);
    if (clock.stateId === SM_REST_STATE_ID) return rest;
    const st = this.statesById.get(clock.stateId);
    if (!st || st.kind !== 'animation' || !st.clipName) return rest;
    const clip = this.doc.clips.find((c) => c.name === st.clipName);
    if (!clip) return rest; // dangling clipName → rest pose
    const time = effClipTime(clip, clock.timeMs, st.loop !== false);
    const track = clip.tracks.find((t) => t.target === target && t.channel === channel);
    // Keyed channel → absolute sampled value; unkeyed → rest (the load-bearing rule).
    if (!track || track.keyframes.length === 0) return rest;
    return sampleKeyList(track.keyframes, time, rest);
  }

  private restFallback(target: string, channel: Channel): number {
    const part = this.doc.parts.find((p) => p.id === target);
    if (!part) return CHANNEL_DEFAULTS[channel]; // e.g. the synthetic 'root' target
    switch (channel) {
      case 'rotate': return part.rest.rotate;
      case 'tx': return part.rest.tx;
      case 'ty': return part.rest.ty;
      case 'sx': return part.rest.sx;
      case 'sy': return part.rest.sy;
    }
  }
}

/** Map a raw clock time into a clip: wrap when looping, clamp at the end otherwise. */
function effClipTime(clip: Clip, timeMs: number, looping: boolean): number {
  const dur = clip.duration;
  if (looping) {
    if (dur > 0) return ((timeMs % dur) + dur) % dur;
    return 0; // zero-length loop has no meaningful phase
  }
  if (dur > 0) return Math.min(Math.max(0, timeMs), dur);
  return Math.max(0, timeMs); // sampleKeyList clamps beyond the last key anyway
}

export function createSMInstance(doc: RigDoc, sm: StateMachine): SMInstance {
  return new Instance(doc, sm);
}
