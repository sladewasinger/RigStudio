/**
 * RIGHT column: the selected state's or transition's own Properties (state name/clip,
 * transition blend duration + exit time, conditions). Titled with the selected item's own
 * name so it reads unmistakably as THIS item's scope, not the machine's — see
 * `./globals.ts`'s `buildLeftPanel` doc comment for why the machine-wide sections (Inputs,
 * Listeners) live in a separate column instead of stacking below Properties here.
 */

import { StateMachine, SMTransition, SMState, SMCondition, SMInput, SMConditionOp, notify } from '../../core/model';
import { checkpoint } from '../../core/history';
import {
  ctx, stateName, div, span, button, hintBlock, labeledRow, numberInput, textInput, option,
} from './state';
import { deleteState } from './graph';

export function buildRightPanel(
  doc: { clips: { name: string }[] }, sm: StateMachine,
): HTMLElement {
  const side = div('sm-side sm-side-right');
  side.appendChild(buildProps(doc, sm));
  return side;
}

function buildProps(doc: { clips: { name: string }[] }, sm: StateMachine): HTMLElement {
  const tr = sm.transitions.find((t) => t.id === ctx.selTransitionId);
  const st = sm.states.find((s) => s.id === ctx.selStateId);

  const sec = div('sm-section sm-props-section');
  const head = div('sm-prop-head');
  const title = tr
    ? `Transition ${stateName(sm, tr.fromId)} → ${stateName(sm, tr.toId)}`
    : st
      ? (st.kind === 'animation' ? `State: ${st.name}` : `${cap(st.kind)} state`)
      : 'Properties';
  head.appendChild(span('sm-prop-title', title));
  if (tr) {
    head.appendChild(button('delete', () => {
      checkpoint();
      sm.transitions = sm.transitions.filter((t) => t !== tr);
      ctx.selTransitionId = null;
      notify();
    }));
  } else if (st?.kind === 'animation') {
    head.appendChild(button('delete', () => deleteState(sm, st)));
  }
  sec.appendChild(head);

  if (tr) buildTransitionProps(sec, sm, tr);
  else if (st) buildStateProps(sec, doc, sm, st);
  else sec.appendChild(hintBlock('Nothing selected — select a state or transition to edit it.'));
  return sec;
}

function buildTransitionProps(sec: HTMLElement, sm: StateMachine, tr: SMTransition): void {
  const durRow = labeledRow('blend (ms)');
  durRow.appendChild(numberInput(tr.durationMs, (v) => {
    checkpoint();
    tr.durationMs = Math.max(0, v);
    notify();
  }));
  sec.appendChild(durRow);

  // Exit time — only for transitions LEAVING an animation state (meaningless from
  // entry/any/exit, so hidden there). A checkbox for the common "wait for the animation
  // to finish" (exitFraction 1) plus an advanced 0–100% field for a partial exit point.
  const fromState = sm.states.find((s) => s.id === tr.fromId);
  if (fromState?.kind === 'animation') {
    sec.appendChild(span('sm-subhead', 'Exit time'));

    const waitRow = div('sm-row sm-exit-row');
    const waitLbl = document.createElement('label');
    waitLbl.className = 'sm-check';
    const waitCb = document.createElement('input');
    waitCb.type = 'checkbox';
    waitCb.checked = tr.exitFraction != null;
    waitCb.title = 'Only allow this transition once the from-clip has played to the exit point';
    waitCb.onchange = () => {
      checkpoint();
      tr.exitFraction = waitCb.checked ? 1 : null;
      notify();
    };
    waitLbl.appendChild(waitCb);
    waitLbl.appendChild(document.createTextNode('wait for animation to finish'));
    waitRow.appendChild(waitLbl);
    sec.appendChild(waitRow);

    const pctRow = labeledRow('at %');
    const pct = document.createElement('input');
    pct.type = 'number';
    pct.min = '0';
    pct.max = '100';
    pct.step = '1';
    pct.className = 'sm-num';
    pct.value = String(Math.round((tr.exitFraction ?? 1) * 100));
    pct.disabled = tr.exitFraction == null;
    pct.title = 'Advanced: percent of the from-clip that must play before this transition can fire';
    pct.onchange = () => {
      checkpoint();
      const v = Math.min(100, Math.max(0, Number(pct.value) || 0));
      tr.exitFraction = v / 100;
      notify();
    };
    pctRow.appendChild(pct);
    sec.appendChild(pctRow);
  }

  sec.appendChild(span('sm-subhead', 'Conditions (all must pass)'));
  if (!tr.conditions.length) sec.appendChild(hintBlock('Unconditional — fires as soon as it is reached.'));
  tr.conditions.forEach((c, i) => sec.appendChild(conditionRow(sm, tr, c, i)));

  const addC = button('+ condition', () => {
    if (!sm.inputs.length) return;
    checkpoint();
    tr.conditions.push(defaultCondition(sm.inputs[0]));
    notify();
  });
  if (!sm.inputs.length) { addC.disabled = true; addC.title = 'Add an input first'; }
  sec.appendChild(addC);
}

function conditionRow(sm: StateMachine, tr: SMTransition, c: SMCondition, i: number): HTMLElement {
  const row = div('sm-row');
  const inSel = document.createElement('select');
  for (const inp of sm.inputs) {
    const o = option(inp.id, inp.name);
    if (inp.id === c.inputId) o.selected = true;
    inSel.appendChild(o);
  }
  inSel.onchange = () => {
    const inp = sm.inputs.find((x) => x.id === inSel.value);
    if (!inp) return;
    checkpoint();
    // Reset stale op/value when the input type changes (e.g. bool → trigger).
    delete c.op;
    delete c.value;
    Object.assign(c, defaultCondition(inp));
    notify();
  };
  row.appendChild(inSel);

  const type = sm.inputs.find((x) => x.id === c.inputId)?.type ?? 'bool';
  if (type === 'trigger') {
    row.appendChild(span('sm-trigger-note', 'when fired'));
  } else {
    const opSel = document.createElement('select');
    const ops: SMConditionOp[] = type === 'bool' ? ['==', '!='] : ['==', '!=', '<', '<=', '>', '>='];
    for (const op of ops) {
      const o = option(op, op);
      if ((c.op ?? '==') === op) o.selected = true;
      opSel.appendChild(o);
    }
    opSel.onchange = () => { checkpoint(); c.op = opSel.value as SMConditionOp; notify(); };
    row.appendChild(opSel);

    if (type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.value === true;
      cb.onchange = () => { checkpoint(); c.value = cb.checked; notify(); };
      row.appendChild(cb);
    } else {
      row.appendChild(numberInput(typeof c.value === 'number' ? c.value : 0, (v) => {
        checkpoint();
        c.value = v;
        notify();
      }));
    }
  }
  row.appendChild(button('✕', () => {
    checkpoint();
    tr.conditions.splice(i, 1);
    notify();
  }));
  return row;
}

function defaultCondition(inp: SMInput): SMCondition {
  if (inp.type === 'trigger') return { inputId: inp.id };
  if (inp.type === 'bool') return { inputId: inp.id, op: '==', value: true };
  return { inputId: inp.id, op: '>', value: 0 };
}

function buildStateProps(
  sec: HTMLElement, doc: { clips: { name: string }[] }, sm: StateMachine, st: SMState,
): void {
  if (st.kind !== 'animation') {
    sec.appendChild(hintBlock(kindHint(st.kind)));
    return;
  }

  const nameRow = labeledRow('name');
  nameRow.appendChild(textInput(st.name, (v) => { checkpoint(); st.name = v || st.name; notify(); }));
  sec.appendChild(nameRow);

  const clipRow = labeledRow('clip');
  const clipSel = document.createElement('select');
  if (!doc.clips.length) clipSel.appendChild(option('', '(no clips)'));
  for (const cl of doc.clips) {
    const o = option(cl.name, cl.name);
    if (cl.name === st.clipName) o.selected = true;
    clipSel.appendChild(o);
  }
  clipSel.onchange = () => { checkpoint(); st.clipName = clipSel.value; notify(); };
  clipRow.appendChild(clipSel);
  sec.appendChild(clipRow);

  // Loop is CLIP data now (v2.12 — matches Rive: looping is a LinearAnimation property,
  // not a per-state one), so it's set once per clip in the timeline's clip-management
  // cluster rather than here per state.
  sec.appendChild(hintBlock('Looping is set on the clip itself — see the loop toggle in Timeline → clip management.'));
}

function kindHint(kind: string): string {
  if (kind === 'entry') return 'Start node — its outgoing transition picks the first state.';
  if (kind === 'any') return 'Transitions from here may fire from any state.';
  return 'Exit ends the machine and freezes the last pose.';
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
