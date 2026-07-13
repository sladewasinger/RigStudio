/**
 * LEFT global column: Inputs (machine-wide) and Listeners (machine-wide) — see the
 * comment above `buildLeftPanel` below for why these are machine-wide and live in their
 * own column rather than stacking below the selected item's Properties in `./props.ts`.
 * The header (machine CRUD + preview button) lives in `./header.ts`.
 */

import {
  notify, freshId, state, StateMachine, SMInput, SMListener, SMListenerAction, SMInputType,
} from '../../core/model';
import { checkpoint } from '../../core/history';
import { dialog } from '../../ui/dialogs';
import { div, span, button, iconBtn, section, hintBlock, numberInput, option } from './state';
import { isPreviewing, boolLive, numLive, setLive, fireLiveTrigger } from './preview';

// =====================================================================================
// Side panels: LEFT is machine-wide (Inputs, Listeners — every state can read every
// input, a listener fires regardless of what's selected), RIGHT (`./props.ts`) is the
// selected state's or transition's own Properties. Splitting them into separate columns
// (rather than stacking machine-wide sections below Properties in one shared column, the
// previous layout) makes the scope distinction structural instead of relying on a
// "— machine-wide" label alone — a real user once added a trigger input and a listener
// while a state was selected and believed both were scoped to it because everything sat
// in one column.
// =====================================================================================

export function buildLeftPanel(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine,
): HTMLElement {
  const side = div('sm-side sm-side-left');
  const scoped = div('sm-scope-group');
  scoped.appendChild(buildInputs(sm));
  scoped.appendChild(buildListeners(doc, sm));
  side.appendChild(scoped);
  return side;
}

// ---- Inputs (machine-wide) ----

function buildInputs(sm: StateMachine): HTMLElement {
  const sec = section('Inputs — machine-wide');
  sec.appendChild(hintBlock(
    'Inputs are signals for the whole machine; conditions on transitions decide when they matter.',
  ));
  for (const inp of sm.inputs) sec.appendChild(inputRow(sm, inp));
  if (!sm.inputs.length) sec.appendChild(hintBlock('No inputs. Add bool / number / trigger controls.'));
  const add = div('sm-add-row');
  add.appendChild(button('+ bool', () => addInput(sm, 'bool')));
  add.appendChild(button('+ number', () => addInput(sm, 'number')));
  add.appendChild(button('+ trigger', () => addInput(sm, 'trigger')));
  sec.appendChild(add);
  return sec;
}

function inputRow(sm: StateMachine, inp: SMInput): HTMLElement {
  const row = div('sm-row');
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'sm-inp-name';
  name.value = inp.name;
  name.title = 'Input name';
  name.onchange = () => {
    const v = name.value.trim();
    if (!v || v === inp.name) return;
    checkpoint();
    inp.name = v;
    notify();
  };
  row.appendChild(name);
  row.appendChild(span('sm-badge', inp.type));
  row.appendChild(defaultOrLiveControl(sm, inp));
  row.appendChild(iconBtn('✕', 'Remove input', () => removeInput(sm, inp)));
  return row;
}

/** Editing the input default, unless preview is live — then it drives the running instance. */
function defaultOrLiveControl(sm: StateMachine, inp: SMInput): HTMLElement {
  const live = isPreviewing(sm);
  if (inp.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    if (live) {
      cb.checked = boolLive(inp);
      cb.title = 'Live: toggle the input';
      cb.onchange = () => setLive(inp, cb.checked);
    } else {
      cb.checked = inp.default === true;
      cb.onchange = () => { checkpoint(); inp.default = cb.checked; notify(); };
    }
    return cb;
  }
  if (inp.type === 'number') {
    const n = document.createElement('input');
    n.type = 'number';
    n.step = 'any';
    n.className = 'sm-num';
    if (live) {
      n.value = String(numLive(inp));
      n.title = 'Live: drive the input';
      n.oninput = () => setLive(inp, Number(n.value) || 0);
    } else {
      n.value = String(typeof inp.default === 'number' ? inp.default : 0);
      n.onchange = () => { checkpoint(); inp.default = Number(n.value) || 0; notify(); };
    }
    return n;
  }
  // trigger
  if (live) return button('fire', () => fireLiveTrigger(inp.name));
  return span('sm-trigger-note', '(fires)');
}

function addInput(sm: StateMachine, type: SMInputType): void {
  checkpoint();
  const inp: SMInput = {
    id: freshId('input'),
    name: uniqueInputName(sm, type),
    type,
    default: type === 'bool' ? false : type === 'number' ? 0 : undefined,
  };
  sm.inputs.push(inp);
  notify();
}

/**
 * Deleting an input that's still referenced (by a transition condition or a listener
 * action) silently orphaned those references before — the deleted input's id just stayed
 * on the condition/action, unresolved forever (which reads as "always false" per
 * stateMachine.ts's conditionPasses, i.e. a transition that can never fire again). That
 * broke a real user's saved file. Now: count the usages BEFORE removing anything; if
 * there are any, confirm with the exact counts and, on confirm, cascade-delete the
 * referencing conditions/actions in the SAME checkpoint as the input removal (one undo
 * step). Unreferenced inputs still delete instantly, no prompt.
 */
async function removeInput(sm: StateMachine, inp: SMInput): Promise<void> {
  let condCount = 0;
  for (const tr of sm.transitions) condCount += tr.conditions.filter((c) => c.inputId === inp.id).length;
  let actionCount = 0;
  for (const ls of sm.listeners) actionCount += ls.actions.filter((a) => a.inputId === inp.id).length;

  if (condCount > 0 || actionCount > 0) {
    const parts: string[] = [];
    if (condCount > 0) parts.push(`${condCount} transition condition${condCount === 1 ? '' : 's'}`);
    if (actionCount > 0) parts.push(`${actionCount} listener action${actionCount === 1 ? '' : 's'}`);
    const ok = await dialog.confirm(
      `Used by ${parts.join(' and ')} — deleting removes those too.`,
      { title: `Delete input "${inp.name}"?`, okText: 'Delete', danger: true },
    );
    if (!ok) return;
  }

  checkpoint();
  sm.inputs = sm.inputs.filter((i) => i !== inp);
  for (const tr of sm.transitions) tr.conditions = tr.conditions.filter((c) => c.inputId !== inp.id);
  for (const ls of sm.listeners) ls.actions = ls.actions.filter((a) => a.inputId !== inp.id);
  notify();
}

// ---- Listeners (machine-wide) ----

function buildListeners(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine,
): HTMLElement {
  const sec = section('Listeners — machine-wide');
  for (const ls of sm.listeners) sec.appendChild(listenerRow(doc, sm, ls));
  if (!sm.listeners.length) sec.appendChild(hintBlock('No listeners. Map a click/hover on a part to an input.'));
  const add = div('sm-add-row');
  const addBtn = button('+ listener', () => addListener(doc, sm, null));
  if (!doc.parts.length) { addBtn.disabled = true; addBtn.title = 'Import a rig first'; }
  add.appendChild(addBtn);
  const useSel = button('use selected part', () => {
    if (state.selectedPartId) addListener(doc, sm, state.selectedPartId);
  });
  useSel.title = 'Add a listener on the part selected on the canvas';
  add.appendChild(useSel);
  sec.appendChild(add);
  return sec;
}

function listenerRow(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine, ls: SMListener,
): HTMLElement {
  const wrap = div('sm-listener');
  if (ls.actions.length === 0) wrap.classList.add('sm-listener-warn');
  const top = div('sm-row');

  const partSel = document.createElement('select');
  for (const p of doc.parts) {
    const o = option(p.id, p.label);
    if (p.id === ls.targetPartId) o.selected = true;
    partSel.appendChild(o);
  }
  partSel.onchange = () => { checkpoint(); ls.targetPartId = partSel.value; notify(); };
  top.appendChild(partSel);

  const evSel = document.createElement('select');
  for (const e of ['down', 'up', 'enter', 'exit'] as const) {
    const o = option(e, e);
    if (e === ls.event) o.selected = true;
    evSel.appendChild(o);
  }
  evSel.onchange = () => { checkpoint(); ls.event = evSel.value as SMListener['event']; notify(); };
  top.appendChild(evSel);

  if (ls.actions.length === 0) top.appendChild(span('sm-warn-badge', '⚠'));
  top.appendChild(iconBtn('✕', 'Remove listener', () => {
    checkpoint();
    sm.listeners = sm.listeners.filter((l) => l !== ls);
    notify();
  }));
  wrap.appendChild(top);

  ls.actions.forEach((a, i) => wrap.appendChild(actionRow(sm, ls, a, i)));
  if (ls.actions.length === 0) {
    wrap.appendChild(span(
      'sm-warn',
      sm.inputs.length
        ? '⚠ no actions — this listener does nothing. Add one below.'
        : '⚠ no actions — add an input first, then an action, or this listener does nothing.',
    ));
  }
  const addA = button('+ action', () => {
    if (!sm.inputs.length) return;
    checkpoint();
    ls.actions.push(defaultAction(sm.inputs[0]));
    notify();
  });
  addA.className = 'sm-add-action';
  if (!sm.inputs.length) { addA.disabled = true; addA.title = 'Add an input first'; }
  wrap.appendChild(addA);
  return wrap;
}

function actionRow(sm: StateMachine, ls: SMListener, a: SMListenerAction, i: number): HTMLElement {
  const row = div('sm-row sm-action');
  const inSel = document.createElement('select');
  for (const inp of sm.inputs) {
    const o = option(inp.id, inp.name);
    if (inp.id === a.inputId) o.selected = true;
    inSel.appendChild(o);
  }
  inSel.onchange = () => {
    const inp = sm.inputs.find((x) => x.id === inSel.value);
    if (!inp) return;
    checkpoint();
    // Reset stale value when the input type changes (e.g. setBool → fireTrigger).
    delete a.value;
    Object.assign(a, defaultAction(inp));
    notify();
  };
  row.appendChild(inSel);
  row.appendChild(span('sm-badge', actionLabel(a.type)));

  const type = sm.inputs.find((x) => x.id === a.inputId)?.type ?? 'bool';
  if (type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.value === true;
    cb.onchange = () => { checkpoint(); a.value = cb.checked; notify(); };
    row.appendChild(cb);
  } else if (type === 'number') {
    row.appendChild(numberInput(typeof a.value === 'number' ? a.value : 0, (v) => {
      checkpoint();
      a.value = v;
      notify();
    }));
  }
  row.appendChild(iconBtn('✕', 'Remove action', () => {
    checkpoint();
    ls.actions.splice(i, 1);
    notify();
  }));
  return row;
}

function addListener(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine, partId: string | null,
): void {
  const target = partId ?? doc.parts[0]?.id;
  if (!target) return;
  checkpoint();
  // Seed ONE action (first input, type-inferred) so a fresh listener actually does
  // something — an actionless listener is exactly the silent-no-op that broke the user's
  // saved file. When the machine has no inputs yet, it stays empty and the row warns.
  const actions: SMListenerAction[] = sm.inputs.length ? [defaultAction(sm.inputs[0])] : [];
  sm.listeners.push({ id: freshId('listener'), targetPartId: target, event: 'down', actions });
  notify();
}

function defaultAction(inp: SMInput): SMListenerAction {
  if (inp.type === 'bool') return { inputId: inp.id, type: 'setBool', value: true };
  if (inp.type === 'number') return { inputId: inp.id, type: 'setNumber', value: 0 };
  return { inputId: inp.id, type: 'fireTrigger' };
}

const actionLabel = (t: SMListenerAction['type']): string =>
  t === 'setBool' ? 'set' : t === 'setNumber' ? 'set' : 'fire';

function uniqueInputName(sm: StateMachine, type: SMInputType): string {
  const base = type === 'bool' ? 'flag' : type === 'number' ? 'value' : 'trigger';
  const used = new Set(sm.inputs.map((i) => i.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}
