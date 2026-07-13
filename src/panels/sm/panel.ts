/**
 * State-machine editor + live preview. Swaps into the timeline's lanes area exactly like
 * the curves editor does (a mutually-exclusive "logic" toggle), and owns everything the
 * feature needs so the view.ts monolith stays untouched save one hook (`setPoseSampler`).
 *
 * Layout: a header row (machine selector / +machine / rename / delete / ▶ preview + live
 * status) over a two-column body — LEFT a draggable graph canvas of states & transitions,
 * RIGHT a stack of Inputs, the selected transition/state Properties, and Listeners.
 *
 * PREVIEW builds a pure SMInstance (stateMachine.ts), ticks it with real rAF frame deltas,
 * and drives the rendered pose through view.setPoseSampler. While it runs the inputs list
 * becomes LIVE controls and canvas pointer events over artwork are consumed (selection/drag
 * suppressed) and routed to the machine's listeners. Preview is APP state — never serialized.
 *
 * This module is the top-level orchestrator of the `panels/sm/*` package: it assembles
 * `./header` (header row), `./globals` (left column: Inputs/Listeners), `./graph` (state
 * graph canvas), and `./props` (right column) into the panel, and is the only module that
 * registers `./state`'s rerender hook — every lower module triggers a rebuild through that
 * hook rather than importing this file back (which would cycle, since this file imports
 * all of them).
 */

import { state, notify } from '../../core/model';
import { checkpoint } from '../../core/history';
import { ctx, rerender, registerRerender, div, hintBlock, button } from './state';
import { ensureLayout, buildGraph, deleteState } from './graph';
import { isArming, cancelArm } from './graphInteract';
import { buildRightPanel } from './props';
import { buildHeader, addMachine } from './header';
import { buildLeftPanel } from './globals';
import { stopPreview, isAnyPreviewActive } from './preview';

registerRerender(() => { if (ctx.host) buildSMPanel(ctx.host); });

// =====================================================================================
// Entry point (called by the timeline when the logic view is shown)
// =====================================================================================

export function buildSMPanel(container: HTMLElement): void {
  ctx.host = container;
  ctx.logicVisible = true;
  container.innerHTML = '';
  container.classList.add('sm-editor');
  const doc = state.doc;
  if (!doc) {
    container.appendChild(hintBlock('Import an SVG to build a state machine.'));
    return;
  }
  if (!Array.isArray(doc.stateMachines)) doc.stateMachines = [];
  const machines = doc.stateMachines;

  let sm = machines.find((m) => m.id === ctx.selMachineId) ?? null;
  if (!sm && machines.length) {
    sm = machines[0];
    ctx.selMachineId = sm.id;
  }

  container.appendChild(buildHeader(machines, sm));

  if (!sm) {
    const empty = div('sm-empty');
    empty.appendChild(hintBlock('No state machines yet. Wire your clips into an interactive graph.'));
    empty.appendChild(button('+ machine', () => addMachine()));
    container.appendChild(empty);
    return;
  }

  ensureLayout(sm);

  const body = div('sm-body');
  body.appendChild(buildLeftPanel(doc, sm));
  body.appendChild(buildGraph(doc, sm));
  body.appendChild(buildRightPanel(doc, sm));
  container.appendChild(body);
}

/** Timeline tells us when the logic view is NOT on screen (setup mode / toggled off / no doc). */
export function setLogicVisible(v: boolean): void {
  ctx.logicVisible = v;
}

// =====================================================================================
// main.ts key hooks (Delete / Escape) — only act while the logic view is on screen
// =====================================================================================

export function smHandleEscape(): boolean {
  if (isArming()) { cancelArm(); rerender(); return true; }
  if (isAnyPreviewActive()) { stopPreview(); rerender(); return true; }
  return false;
}

export function smHandleDelete(): boolean {
  if (!ctx.logicVisible) return false;
  const sm = state.doc?.stateMachines?.find((m) => m.id === ctx.selMachineId);
  if (!sm) return false;
  if (ctx.selTransitionId) {
    const tr = sm.transitions.find((t) => t.id === ctx.selTransitionId);
    if (tr) {
      checkpoint();
      sm.transitions = sm.transitions.filter((t) => t !== tr);
      ctx.selTransitionId = null;
      notify();
      return true;
    }
  }
  if (ctx.selStateId) {
    const st = sm.states.find((s) => s.id === ctx.selStateId);
    if (st && st.kind === 'animation') {
      deleteState(sm, st);
      return true;
    }
  }
  return false;
}
