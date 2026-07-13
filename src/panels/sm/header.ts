/**
 * The panel header: machine selection + management (dropdown / +machine / rename /
 * delete) and the ▶ preview button + live status readout.
 */

import { state, notify, StateMachine, newStateMachine } from '../../core/model';
import { checkpoint } from '../../core/history';
import { ctx, rerender, div, button, option } from './state';
import { forgetGraphView } from './graphCamera';
import { isPreviewing, startPreview, stopPreview, previewStatusText } from './preview';

export function buildHeader(machines: StateMachine[], sm: StateMachine | null): HTMLElement {
  const header = div('sm-header');

  // Cluster 1: machine selection + management (dropdown / +machine / rename / delete).
  const machineCluster = div('sm-cluster');

  const sel = document.createElement('select');
  sel.title = 'Active state machine';
  if (!machines.length) {
    const o = option('', 'No machines');
    o.selected = true;
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    for (const m of machines) {
      const o = option(m.id, m.name);
      if (m.id === sm?.id) o.selected = true;
      sel.appendChild(o);
    }
  }
  sel.onchange = () => {
    stopPreview();
    ctx.selMachineId = sel.value;
    ctx.selStateId = null;
    ctx.selTransitionId = null;
    rerender();
  };
  machineCluster.appendChild(sel);

  machineCluster.appendChild(button('+ machine', () => addMachine()));

  if (sm) {
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'sm-name';
    nameIn.value = sm.name;
    nameIn.title = 'Machine name (edit to rename)';
    nameIn.onchange = () => {
      const v = nameIn.value.trim();
      if (!v || v === sm.name) return;
      checkpoint();
      sm.name = v;
      notify();
    };
    machineCluster.appendChild(nameIn);

    machineCluster.appendChild(button('delete machine', () => {
      stopPreview();
      checkpoint();
      const arr = state.doc!.stateMachines!;
      const i = arr.findIndex((m) => m.id === sm.id);
      if (i >= 0) arr.splice(i, 1);
      forgetGraphView(sm.id); // drop the now-dangling view state
      ctx.selMachineId = arr[0]?.id ?? null;
      ctx.selStateId = null;
      ctx.selTransitionId = null;
      notify();
    }));
  }
  header.appendChild(machineCluster);

  // Cluster 2: live preview + status readout (pushed to the row's end).
  if (sm) {
    const previewCluster = div('sm-cluster sm-cluster-end');
    const active = isPreviewing(sm);
    const pv = button(active ? '■ stop' : '▶ preview', () => {
      if (isPreviewing(sm)) stopPreview();
      else startPreview(sm);
      rerender();
    });
    pv.className = 'sm-preview-btn';
    if (active) pv.classList.add('active');
    pv.title = 'Run the machine live and drive the canvas pose';
    previewCluster.appendChild(pv);

    if (active) {
      const status = div('sm-status');
      status.textContent = previewStatusText(sm);
      previewCluster.appendChild(status);
    }
    header.appendChild(previewCluster);
  }

  return header;
}

export function addMachine(): void {
  stopPreview();
  const doc = state.doc;
  if (!doc) return;
  if (!Array.isArray(doc.stateMachines)) doc.stateMachines = [];
  checkpoint();
  const m = newStateMachine(`machine_${doc.stateMachines.length + 1}`);
  doc.stateMachines.push(m);
  ctx.selMachineId = m.id;
  ctx.selStateId = null;
  ctx.selTransitionId = null;
  notify();
}
