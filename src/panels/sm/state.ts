/**
 * Shared session state + generic DOM helpers for the state-machine editor package
 * (`panels/sm/*`). Mirrors `view/context.ts`'s pattern: a single mutable `ctx` object
 * (never raw module-level `let`s) so every sm/ module can read AND write the same
 * selection/host state — reassigning a plain imported `let` binding from another module
 * is illegal in ES modules, but mutating a property of an imported object is fine.
 */

import { StateMachine } from '../../core/model';
import { SM_REST_STATE_ID } from '../../core/stateMachine';

// ---- Editor selection & interaction state (module-level so it survives re-renders) ----

export interface SMPanelCtx {
  host: HTMLElement | null;
  selMachineId: string | null;
  selStateId: string | null;
  selTransitionId: string | null;
  /** Whether the logic view is the one currently on screen (gates the main.ts Delete/Escape hooks). */
  logicVisible: boolean;
}

export const ctx: SMPanelCtx = {
  host: null,
  selMachineId: null,
  selStateId: null,
  selTransitionId: null,
  logicVisible: false,
};

// `panel.ts` (the top-level orchestrator that owns `buildSMPanel`) registers the real
// rebuild implementation once at module load. Every other sm/ module triggers a full
// panel rebuild through this hook instead of importing panel.ts back — panel.ts already
// imports graph/props/globals/preview to assemble the panel, so a back-import would cycle.
let rerenderImpl: (() => void) | null = null;
export function registerRerender(fn: () => void): void { rerenderImpl = fn; }

/** Re-render just the panel (preview keeps running — the rAF loop holds its own state). */
export function rerender(): void { rerenderImpl?.(); }

export function stateName(sm: StateMachine, id: string): string {
  if (id === SM_REST_STATE_ID) return 'rest';
  return sm.states.find((s) => s.id === id)?.name ?? '?';
}

// ---- Generic DOM helpers shared across the sm/ modules ----

export function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

export function iconBtn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button(glyph, onClick);
  b.className = 'sm-icon-btn';
  b.title = title;
  return b;
}

export function section(title: string): HTMLElement {
  const sec = div('sm-section');
  sec.appendChild(span('sm-section-title', title));
  return sec;
}

export function labeledRow(label: string): HTMLElement {
  const row = div('sm-labeled');
  row.appendChild(span('sm-label', label));
  return row;
}

export function hintBlock(text: string): HTMLElement {
  return span('sm-hint', text);
}

export function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const n = document.createElement('input');
  n.type = 'number';
  n.step = 'any';
  n.className = 'sm-num';
  n.value = String(value);
  n.onchange = () => onChange(Number(n.value) || 0);
  return n;
}

export function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const t = document.createElement('input');
  t.type = 'text';
  t.value = value;
  t.onchange = () => onChange(t.value.trim());
  return t;
}

export function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}
