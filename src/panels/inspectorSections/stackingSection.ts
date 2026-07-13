// ---- Draw order (rest stacking) ----
import {
  state, notify, RigPart, canMoveSelectedInDrawOrder, moveSelectedInDrawOrder,
} from '../../core/model';
import { reorderCanvas } from '../../view';
import { checkpoint } from '../../core/history';

/**
 * Edit-mode stacking row: the selected part's (or entered path's) position in the paint
 * order + ▲/▼ that run the EXACT same op as PageUp/PageDown (moveSelectedInDrawOrder →
 * reorderCanvas). This edits the AUTHORED rest stacking (doc.parts order, hierarchy-
 * independent by design); the keyable `z` OFFSET in Animate lifts a part off it per frame.
 * Readout + button enablement mirror moveSelectedInDrawOrder's own entered-path-vs-part
 * resolution so the label always matches what the arrows move.
 */
export function buildStackingRow(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const pathEntered = !!state.selectedPathId;
  const list = pathEntered ? part.paths.map((p) => p.id) : doc.parts.map((p) => p.id);
  const curId = pathEntered ? state.selectedPathId! : part.id;
  const idx = list.indexOf(curId);
  const what = pathEntered ? 'object' : 'layer';

  const row = document.createElement('div');
  row.className = 'field';
  row.title = 'Authored draw order (last = topmost). ▲ brings forward, ▼ sends back — ' +
    'same as PageUp/PageDown. Animate a per-part z offset to change stacking over time.';
  const span = document.createElement('span');
  span.textContent = 'stacking';
  row.appendChild(span);

  const controls = document.createElement('span');
  controls.className = 'stacking-controls';
  const readout = document.createElement('span');
  readout.className = 'stacking-pos';
  readout.textContent = idx >= 0 ? `${what} ${idx + 1} of ${list.length}` : '—';
  controls.appendChild(readout);

  const step = (delta: 1 | -1) => {
    if (!canMoveSelectedInDrawOrder(delta)) return;
    checkpoint();
    moveSelectedInDrawOrder(delta);
    reorderCanvas();
    notify();
  };
  const stepBtn = (text: string, title: string, delta: 1 | -1) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.className = 'stacking-step';
    b.disabled = !canMoveSelectedInDrawOrder(delta);
    b.onclick = () => step(delta);
    return b;
  };
  controls.appendChild(stepBtn('▲', 'Bring forward (PageUp)', 1));
  controls.appendChild(stepBtn('▼', 'Send backward (PageDown)', -1));
  row.appendChild(controls);
  el.appendChild(row);
}
