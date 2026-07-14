// ---- Draw order (rest stacking) ----
import {
  state, notify, RigPart, canMoveSelectedInDrawOrder, moveSelectedInDrawOrder, drawOrder,
  channelValue, effectiveChildOrder,
} from '../../core/model';
import { refreshSelectedStackingDom } from '../../view';
import { checkpoint } from '../../core/history';

/**
 * Edit-mode stacking row: the selected part's (or entered path's) position in the paint
 * order + ▲/▼ that run the EXACT same op as PageUp/PageDown (moveSelectedInDrawOrder →
 * refreshSelectedStackingDom). The buttons always edit the AUTHORED rest stacking, in
 * both editor modes — that part of the UI is unchanged by editor mode. Since U4 a step
 * is SLOT-scoped (`core/slotReorder.ts` via structuralOps' stepScope): one Layers row per
 * press, crossing sibling paths and parts alike within ONE parent's mixed child list.
 *
 * The READOUT differs by mode so it never lies about what the canvas actually shows
 * (CLAUDE.md "Layer order IS z-order"): Edit reports the row's position in its parent's
 * SLOT list — exactly what the buttons step through (an entered path counts its part's
 * mixed rows, a parented part its parent's, a root part the root siblings). Animate
 * reports the EFFECTIVE position in the full, flat z-SORTED canvas order at the playhead
 * (structuralOps.ts's drawOrder, the same sort render.ts's applyDrawOrder uses via
 * channelValue(part,'z',t)) with an "(animated)" hint, since a keyed z offset can lift a
 * part far from its authored/sibling position on canvas — the panel's own DOM order
 * never re-sorts, only this text differs.
 */
export function buildStackingRow(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const pathEntered = !!state.selectedPathId;
  const animated = !pathEntered && state.editorMode === 'animate';

  let idx: number;
  let total: number;
  const what = pathEntered ? 'object' : 'layer';
  if (animated) {
    const sorted = drawOrder(doc.parts, (p) => channelValue(p, 'z', state.currentTime));
    idx = sorted.findIndex((p) => p.id === part.id);
    total = sorted.length;
  } else {
    // The step scope's own slot list (pure read — never materializes a lazy childOrder):
    // the entered path counts within its part, a parented part within its parent, a root
    // part among the root siblings (roots have no containing slot list).
    const container = pathEntered
      ? part
      : part.parentId ? doc.parts.find((p) => p.id === part.parentId) ?? null : null;
    const slotId = pathEntered ? state.selectedPathId! : part.id;
    if (container) {
      const order = effectiveChildOrder(container, doc.parts);
      idx = order.findIndex((s) => s.id === slotId);
      total = order.length;
    } else {
      const sibs = doc.parts.filter((p) => !p.parentId);
      idx = sibs.indexOf(part);
      total = sibs.length;
    }
  }

  const row = document.createElement('div');
  row.className = 'field';
  row.title = animated
    ? 'Effective front-to-back position at the playhead, including any keyed z offset — ' +
      'the canvas order, not the authored one. ▲/▼ still edit the AUTHORED order (same as ' +
      'PageUp/PageDown); a keyed z offset only overrides it during Animate playback.'
    : 'Authored draw order (last = topmost) among this row\'s siblings in the Layers ' +
      'tree — paths and parts interleave, one row per step. ▲ brings forward, ▼ sends ' +
      'back — same as PageUp/PageDown. Animate a per-part z offset to change stacking ' +
      'over time.';
  const span = document.createElement('span');
  span.textContent = 'stacking';
  row.appendChild(span);

  const controls = document.createElement('span');
  controls.className = 'stacking-controls';
  const readout = document.createElement('span');
  readout.className = 'stacking-pos';
  readout.textContent = idx >= 0
    ? `${what} ${idx + 1} of ${total}${animated ? ' (animated)' : ''}`
    : '—';
  controls.appendChild(readout);

  const step = (delta: 1 | -1) => {
    if (!canMoveSelectedInDrawOrder(delta)) return;
    checkpoint();
    moveSelectedInDrawOrder(delta);
    refreshSelectedStackingDom();
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
