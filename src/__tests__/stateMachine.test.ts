/**
 * Unit tests for the pure state-machine evaluator (src/stateMachine.ts). Every machine
 * is a plainly constructed RigDoc + StateMachine; time flows only through advance(dtMs)
 * so the tests are fully deterministic. Covers entry resolution, all comparison ops,
 * trigger arm/consume/clear timing, any-state priority + skip-self, transition array
 * order, crossfade math + retargeting, looping vs clamping, dangling clips, exit/done,
 * reset, and channelValue parity with model.channelValue.
 */

import { describe, expect, it } from 'vitest';
import {
  Clip,
  RigDoc,
  SMCondition,
  SMConditionOp,
  SMInput,
  SMState,
  SMTransition,
  StateMachine,
  channelValue,
} from '../core/model';
import { SM_REST_STATE_ID, createSMInstance } from '../core/stateMachine';
import { makeClip, makeDoc, makePart, makeTrack, resetState } from './helpers';

// ---- Tiny builders ----

const entry = (id = 'entry'): SMState => ({ id, name: id, kind: 'entry' });
const anyState = (id = 'any'): SMState => ({ id, name: id, kind: 'any' });
const exitState = (id = 'exit'): SMState => ({ id, name: id, kind: 'exit' });
const anim = (id: string, clipName: string, loop = true): SMState =>
  ({ id, name: id, kind: 'animation', clipName, loop });

const tr = (
  id: string, fromId: string, toId: string,
  conditions: SMCondition[] = [], durationMs = 0,
): SMTransition => ({ id, fromId, toId, durationMs, conditions });

const numIn = (name: string, def = 0): SMInput => ({ id: `in_${name}`, name, type: 'number', default: def });
const boolIn = (name: string, def = false): SMInput => ({ id: `in_${name}`, name, type: 'bool', default: def });
const trigIn = (name: string): SMInput => ({ id: `in_${name}`, name, type: 'trigger' });

function machine(opts: {
  inputs?: SMInput[];
  states: SMState[];
  transitions?: SMTransition[];
}): StateMachine {
  return {
    id: 'sm',
    name: 'm',
    inputs: opts.inputs ?? [],
    states: opts.states,
    transitions: opts.transitions ?? [],
    listeners: [],
  };
}

/** A RigDoc carrying one part 'p1', the given clips, and one state machine. */
function docWith(sm: StateMachine, clips: Clip[], restRotate = 0): RigDoc {
  const part = makePart('p1', {
    rest: { rotate: restRotate, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
  });
  const doc = makeDoc([part], clips);
  doc.stateMachines = [sm];
  return doc;
}

/** A clip holding a single rotate key → constant value at every time. */
const constClip = (name: string, value: number): Clip =>
  makeClip({ name, duration: 1000, tracks: [makeTrack('p1', 'rotate', [[0, value, 'linear']])] });

// ---- Entry resolution ----

describe('entry resolution', () => {
  it('falls to the rest pseudo-state when no entry transition passes', () => {
    const sm = machine({
      inputs: [boolIn('start', false)],
      states: [entry(), anyState(), anim('A', 'idle')],
      transitions: [tr('t', 'entry', 'A', [{ inputId: 'in_start', op: '==', value: true }])],
    });
    const doc = docWith(sm, [constClip('idle', 77)], /* restRotate */ 30);
    const inst = createSMInstance(doc, sm);
    expect(inst.status().stateId).toBe(SM_REST_STATE_ID);
    expect(inst.channelValue('p1', 'rotate')).toBe(30); // pure rest, not the clip's 77
  });

  it('takes the first passing entry transition on defaults', () => {
    const sm = machine({
      inputs: [boolIn('start', true)], // default satisfies the condition at create
      states: [entry(), anyState(), anim('A', 'idle')],
      transitions: [tr('t', 'entry', 'A', [{ inputId: 'in_start', op: '==', value: true }])],
    });
    const doc = docWith(sm, [constClip('idle', 77)], 30);
    const inst = createSMInstance(doc, sm);
    expect(inst.status().stateId).toBe('A');
    expect(inst.channelValue('p1', 'rotate')).toBe(77); // now sampling the clip
  });

  it('an any-state transition rescues the machine out of rest', () => {
    const sm = machine({
      inputs: [boolIn('go', false)],
      states: [entry(), anyState(), anim('A', 'idle')],
      // No entry transition → starts in rest; any→A can still fire.
      transitions: [tr('t', 'any', 'A', [{ inputId: 'in_go', op: '==', value: true }])],
    });
    const doc = docWith(sm, [constClip('idle', 77)], 30);
    const inst = createSMInstance(doc, sm);
    expect(inst.status().stateId).toBe(SM_REST_STATE_ID);
    inst.setInput('go', true);
    inst.advance(0);
    expect(inst.status().stateId).toBe('A');
  });
});

// ---- Condition operators ----

/** Whether A→B fires for a number condition given the input value and rhs. */
function numFires(op: SMConditionOp | undefined, inputVal: number, rhs: number): boolean {
  const sm = machine({
    inputs: [numIn('n', 0)],
    states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
    transitions: [
      tr('te', 'entry', 'A'),
      tr('tab', 'A', 'B', [{ inputId: 'in_n', op, value: rhs }]),
    ],
  });
  const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
  const inst = createSMInstance(doc, sm);
  inst.setInput('n', inputVal);
  inst.advance(0);
  return inst.status().stateId === 'B';
}

describe('number comparison operators', () => {
  it('== / != compare for equality', () => {
    expect(numFires('==', 5, 5)).toBe(true);
    expect(numFires('==', 4, 5)).toBe(false);
    expect(numFires('!=', 4, 5)).toBe(true);
    expect(numFires('!=', 5, 5)).toBe(false);
  });

  it('< / <= / > / >= order correctly', () => {
    expect(numFires('<', 4, 5)).toBe(true);
    expect(numFires('<', 5, 5)).toBe(false);
    expect(numFires('<=', 5, 5)).toBe(true);
    expect(numFires('<=', 6, 5)).toBe(false);
    expect(numFires('>', 6, 5)).toBe(true);
    expect(numFires('>', 5, 5)).toBe(false);
    expect(numFires('>=', 5, 5)).toBe(true);
    expect(numFires('>=', 4, 5)).toBe(false);
  });

  it('treats a missing op on a number as equality', () => {
    expect(numFires(undefined, 5, 5)).toBe(true);
    expect(numFires(undefined, 4, 5)).toBe(false);
  });

  it('evaluates a malformed number condition (non-number rhs) as false, never throwing', () => {
    const sm = machine({
      inputs: [numIn('n', 5)],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_n', op: '==', value: true as unknown as number }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
    const inst = createSMInstance(doc, sm);
    expect(() => inst.advance(0)).not.toThrow();
    expect(inst.status().stateId).toBe('A'); // condition false → no fire
  });
});

describe('bool comparison operators', () => {
  function boolFires(op: SMConditionOp | undefined, inputVal: boolean, rhs: boolean): boolean {
    const sm = machine({
      inputs: [boolIn('b', false)],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_b', op, value: rhs }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('b', inputVal);
    inst.advance(0);
    return inst.status().stateId === 'B';
  }

  it('accepts == and != (missing op is ==)', () => {
    expect(boolFires('==', true, true)).toBe(true);
    expect(boolFires('==', false, true)).toBe(false);
    expect(boolFires('!=', false, true)).toBe(true);
    expect(boolFires('!=', true, true)).toBe(false);
    expect(boolFires(undefined, true, true)).toBe(true); // default ==
    expect(boolFires(undefined, false, true)).toBe(false);
  });

  it('rejects an ordering op on a bool as malformed (false)', () => {
    expect(boolFires('<' as SMConditionOp, true, true)).toBe(false);
  });
});

// ---- Triggers ----

describe('triggers', () => {
  it('a fired trigger persists across the gap until the next advance consumes it', () => {
    const sm = machine({
      inputs: [trigIn('t')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [tr('te', 'entry', 'A'), tr('tab', 'A', 'B', [{ inputId: 'in_t' }])],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
    const inst = createSMInstance(doc, sm);
    expect(inst.status().stateId).toBe('A');
    inst.fireTrigger('t'); // armed now, no advance yet
    inst.advance(0); // evaluation sees it → A→B fires
    expect(inst.status().stateId).toBe('B');
  });

  it('clears an armed trigger at the end of an advance even when nothing fired', () => {
    const sm = machine({
      inputs: [boolIn('go', false), trigIn('t')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb'), anim('C', 'cc')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_go', op: '==', value: true }]),
        tr('tbc', 'B', 'C', [{ inputId: 'in_t' }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1), constClip('cc', 2)]);
    const inst = createSMInstance(doc, sm);
    inst.fireTrigger('t'); // armed in A, which has no trigger transition
    inst.advance(0); // A stays (go false); t is consumed/cleared even though unused
    expect(inst.status().stateId).toBe('A');
    inst.setInput('go', true);
    inst.advance(0); // A→B fires
    expect(inst.status().stateId).toBe('B');
    inst.advance(0); // B→C needs t, which was cleared earlier → no fire
    expect(inst.status().stateId).toBe('B');
    inst.fireTrigger('t');
    inst.advance(0); // freshly armed → B→C fires
    expect(inst.status().stateId).toBe('C');
  });
});

// ---- Any-state priority and skip-self ----

describe('any-state transitions', () => {
  it('are evaluated before the current-state transitions', () => {
    const sm = machine({
      inputs: [boolIn('toB'), boolIn('toC')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb'), anim('C', 'cc')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tany', 'any', 'C', [{ inputId: 'in_toC', op: '==', value: true }]),
        tr('tab', 'A', 'B', [{ inputId: 'in_toB', op: '==', value: true }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1), constClip('cc', 2)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('toB', true);
    inst.setInput('toC', true);
    inst.advance(0);
    expect(inst.status().stateId).toBe('C'); // any→C wins over A→B
  });

  it('skips an any transition whose target is the current state, then fires it elsewhere', () => {
    const sm = machine({
      inputs: [boolIn('toA'), boolIn('toB')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tanyA', 'any', 'A', [{ inputId: 'in_toA', op: '==', value: true }]),
        tr('tab', 'A', 'B', [{ inputId: 'in_toB', op: '==', value: true }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('toA', true);
    inst.advance(0); // any→A targets current A → skipped; A→B needs toB(false) → stay A
    expect(inst.status().stateId).toBe('A');
    inst.setInput('toB', true);
    inst.advance(0); // A→B fires
    expect(inst.status().stateId).toBe('B');
    inst.advance(0); // now any→A targets A ≠ current B → fires
    expect(inst.status().stateId).toBe('A');
  });
});

// ---- Transition array order ----

describe('transition array-order precedence', () => {
  const build = (order: 'BC' | 'CB') => {
    const abcTransitions =
      order === 'BC'
        ? [tr('te', 'entry', 'A'), tr('ab', 'A', 'B'), tr('ac', 'A', 'C')]
        : [tr('te', 'entry', 'A'), tr('ac', 'A', 'C'), tr('ab', 'A', 'B')];
    const sm = machine({
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb'), anim('C', 'cc')],
      transitions: abcTransitions,
    });
    return createSMInstance(docWith(sm, [constClip('ca', 0), constClip('cb', 1), constClip('cc', 2)]), sm);
  };

  it('fires the earliest passing transition in array order', () => {
    const bFirst = build('BC');
    bFirst.advance(0);
    expect(bFirst.status().stateId).toBe('B');
    const cFirst = build('CB');
    cFirst.advance(0);
    expect(cFirst.status().stateId).toBe('C');
  });
});

// ---- Crossfade math ----

describe('crossfade', () => {
  it('lerps two clips linearly — a half-duration advance is their mean', () => {
    const sm = machine({
      inputs: [boolIn('go')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_go', op: '==', value: true }], 1000),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 100)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('go', true);
    inst.advance(500); // evaluate fires A→B (progress 0), then integrate → progress 0.5
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(50, 9); // 0*0.5 + 100*0.5
    const s = inst.status();
    expect(s.stateId).toBe('B');
    expect(s.blend).toEqual({ fromStateId: 'A', progress: 0.5 });
  });

  it('completes the crossfade and drops the blend once progress reaches 1', () => {
    const sm = machine({
      inputs: [boolIn('go')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_go', op: '==', value: true }], 1000),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 100)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('go', true);
    inst.advance(1000); // fires then integrates a full duration
    expect(inst.status().blend).toBeNull();
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(100, 9); // pure B
  });

  it('blends an unkeyed channel on one side against the rest pose', () => {
    // ca keys rotate = 10; cb has NO rotate track → its side samples rest (40).
    const ca = makeClip({ name: 'ca', duration: 1000, tracks: [makeTrack('p1', 'rotate', [[0, 10, 'linear']])] });
    const cb = makeClip({ name: 'cb', duration: 1000, tracks: [makeTrack('p1', 'tx', [[0, 5, 'linear']])] });
    const sm = machine({
      inputs: [boolIn('go')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_go', op: '==', value: true }], 1000),
      ],
    });
    const doc = docWith(sm, [ca, cb], /* restRotate */ 40);
    const inst = createSMInstance(doc, sm);
    inst.setInput('go', true);
    inst.advance(500);
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(25, 9); // 10*0.5 + 40*0.5
  });

  it('retargets a mid-blend transition FROM the incoming state, dropping the outgoing side', () => {
    const sm = machine({
      inputs: [boolIn('toB'), boolIn('toC')],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb'), anim('C', 'cc')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_toB', op: '==', value: true }], 1000),
        tr('tbc', 'B', 'C', [{ inputId: 'in_toC', op: '==', value: true }], 1000),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 100), constClip('cc', 200)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('toB', true);
    inst.advance(500); // mid A→B
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(50, 9);

    inst.setInput('toC', true);
    inst.advance(0); // B→C fires; blend retargets from B (100), A is gone → progress 0 = B
    expect(inst.status().blend).toEqual({ fromStateId: 'B', progress: 0 });
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(100, 9); // B's value, NOT A's 0

    inst.advance(500); // progress 0.5 over B→C
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(150, 9); // 100*0.5 + 200*0.5
  });
});

// ---- Looping vs clamping ----

describe('looping vs clamping states', () => {
  const ramp = () =>
    makeClip({ name: 'ramp', duration: 1000, tracks: [makeTrack('p1', 'rotate', [[0, 0, 'linear'], [1000, 100, 'linear']])] });

  const runTo = (loop: boolean, timeMs: number): number => {
    const sm = machine({
      states: [entry(), anyState(), anim('S', 'ramp', loop)],
      transitions: [tr('te', 'entry', 'S')],
    });
    const inst = createSMInstance(docWith(sm, [ramp()]), sm);
    inst.advance(timeMs);
    return inst.channelValue('p1', 'rotate');
  };

  it('wraps a looping clip and clamps a non-looping one past the end', () => {
    expect(runTo(true, 1500)).toBeCloseTo(50, 9); // 1500 % 1000 = 500 → 50
    expect(runTo(true, 2000)).toBeCloseTo(0, 9); // 2000 % 1000 = 0 → 0 (seam)
    expect(runTo(false, 1500)).toBeCloseTo(100, 9); // clamped at 1000 → 100
    expect(runTo(false, 5000)).toBeCloseTo(100, 9);
  });
});

// ---- Dangling clip ----

describe('dangling clipName', () => {
  it('samples pure rest pose for a state whose clip does not exist', () => {
    const sm = machine({
      states: [entry(), anyState(), anim('X', 'ghost_clip')],
      transitions: [tr('te', 'entry', 'X')],
    });
    const doc = docWith(sm, [constClip('idle', 77)], /* restRotate */ 42);
    const inst = createSMInstance(doc, sm);
    expect(inst.status().stateId).toBe('X');
    inst.advance(500);
    expect(inst.channelValue('p1', 'rotate')).toBe(42); // rest, since 'ghost_clip' is missing
  });
});

// ---- Exit / done ----

describe('exit and done', () => {
  it('freezes the pose and no-ops advance once an exit state is entered', () => {
    const sm = machine({
      inputs: [boolIn('stop')],
      states: [entry(), anyState(), anim('A', 'ca'), exitState()],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tex', 'A', 'exit', [{ inputId: 'in_stop', op: '==', value: true }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 55)]);
    const inst = createSMInstance(doc, sm);
    expect(inst.channelValue('p1', 'rotate')).toBe(55);
    inst.setInput('stop', true);
    inst.advance(0);
    expect(inst.status().done).toBe(true);
    expect(inst.status().stateId).toBe('exit');
    expect(inst.channelValue('p1', 'rotate')).toBe(55); // holds the pre-exit pose
    inst.advance(1000); // no-op
    expect(inst.channelValue('p1', 'rotate')).toBe(55);
    expect(inst.status().done).toBe(true);
  });
});

// ---- reset ----

describe('reset', () => {
  it('rewinds to entry resolution with inputs back at their defaults', () => {
    const sm = machine({
      inputs: [boolIn('go', false)],
      states: [entry(), anyState(), anim('A', 'ca'), anim('B', 'cb')],
      transitions: [
        tr('te', 'entry', 'A'),
        tr('tab', 'A', 'B', [{ inputId: 'in_go', op: '==', value: true }]),
      ],
    });
    const doc = docWith(sm, [constClip('ca', 0), constClip('cb', 1)]);
    const inst = createSMInstance(doc, sm);
    inst.setInput('go', true);
    inst.advance(0);
    expect(inst.status().stateId).toBe('B');

    inst.reset();
    expect(inst.status().stateId).toBe('A'); // back to entry-resolved state
    inst.advance(0); // 'go' was reset to its default false → stays A
    expect(inst.status().stateId).toBe('A');
  });
});

// ---- Parity with model.channelValue ----

describe('channelValue parity with model.channelValue', () => {
  it('matches model.channelValue for a single non-blending animation state', () => {
    const part = makePart('p1', { rest: { rotate: 30, tx: 7, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 } });
    const track = makeTrack('p1', 'rotate', [[0, 10, 'linear'], [1000, 20, 'linear']]);
    const clip = makeClip({ name: 'idle', duration: 100000, tracks: [track] }); // huge → no wrap
    const doc = makeDoc([part], [clip]);
    const sm = machine({
      states: [entry(), anyState(), anim('A', 'idle')],
      transitions: [tr('te', 'entry', 'A')],
    });
    doc.stateMachines = [sm];

    resetState(doc); // model.channelValue reads the active clip (idle)
    const inst = createSMInstance(doc, sm);
    inst.advance(500);

    // Keyed channel → identical absolute sample.
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(channelValue(part, 'rotate', 500), 9);
    expect(inst.channelValue('p1', 'rotate')).toBeCloseTo(15, 9);
    // Unkeyed channel → identical rest fallback.
    expect(inst.channelValue('p1', 'tx')).toBe(channelValue(part, 'tx', 500));
    expect(inst.channelValue('p1', 'tx')).toBe(7);
  });
});
