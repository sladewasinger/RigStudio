// ---- Align & distribute ----
import { state, notify } from '../../core/model';
import { partRootBoxes, applyRootDeltas } from '../../view';
import { alignDeltas, distributeDeltas, AlignEdge, AlignReference } from '../../geometry/align';
import { checkpoint } from '../../core/history';
import { iconButton, ICON_PATHS } from '../icons';

let alignReference: AlignReference = 'selection';

export function buildAlignSection(el: HTMLElement): void {
  const doc = state.doc!;
  const ids = state.selectedPartIds;
  if (ids.length < 1) return;

  const title = document.createElement('h3');
  title.textContent = 'Align & distribute';
  el.appendChild(title);

  const refRow = document.createElement('label');
  refRow.className = 'field';
  const refSpan = document.createElement('span');
  refSpan.textContent = 'relative to';
  const refSel = document.createElement('select');
  for (const [value, label] of [
    ['selection', 'selection bounds'],
    ['first', 'first selected'],
    ['last', 'last selected'],
    ['canvas', 'canvas'],
  ] as [AlignReference, string][]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (alignReference === value) opt.selected = true;
    refSel.appendChild(opt);
  }
  refSel.onchange = () => {
    alignReference = refSel.value as AlignReference;
  };
  refRow.appendChild(refSpan);
  refRow.appendChild(refSel);
  el.appendChild(refRow);

  const apply = (edge: AlignEdge) => {
    const boxes = partRootBoxes(ids);
    const deltas = alignDeltas(ids, boxes, edge, alignReference, doc.viewBox);
    if ([...deltas.values()].every((d) => d.dx === 0 && d.dy === 0)) return;
    checkpoint();
    applyRootDeltas(deltas);
    notify();
  };
  const distribute = (mode: 'horizontal' | 'vertical') => {
    const boxes = partRootBoxes(ids);
    const deltas = distributeDeltas(ids, boxes, mode);
    if ([...deltas.values()].every((d) => d.dx === 0 && d.dy === 0)) return;
    checkpoint();
    applyRootDeltas(deltas);
    notify();
  };

  const grid = document.createElement('div');
  grid.className = 'align-grid';
  const alignBtn = (ic: keyof typeof ICON_PATHS, title: string, edge: AlignEdge) => {
    grid.appendChild(iconButton(ic, '', title, () => apply(edge)));
  };
  alignBtn('alignL', 'Align left edges', 'left');
  alignBtn('alignCH', 'Center horizontally', 'centerH');
  alignBtn('alignR', 'Align right edges', 'right');
  alignBtn('alignT', 'Align top edges', 'top');
  alignBtn('alignM', 'Center vertically', 'middleV');
  alignBtn('alignB', 'Align bottom edges', 'bottom');
  el.appendChild(grid);

  const dist = document.createElement('div');
  dist.className = 'align-grid';
  const distBtn = (ic: keyof typeof ICON_PATHS, title: string, mode: 'horizontal' | 'vertical') => {
    const b = iconButton(ic, 'gaps', title, () => distribute(mode));
    b.disabled = ids.length < 3;
    dist.appendChild(b);
  };
  distBtn('distH', 'Equalize horizontal gaps (needs 3+)', 'horizontal');
  distBtn('distV', 'Equalize vertical gaps (needs 3+)', 'vertical');
  el.appendChild(dist);
}
