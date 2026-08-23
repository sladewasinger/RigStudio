/// <reference types="vite/client" />

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importSvg } from '../../io/importSvg';
import { resetHistory, undo } from '../../core/history';
import { buildCanvas } from '../../view';
import { notify } from '../../core/model';
import { bootRig, resetRig, state } from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="holder">
    <rect id="hidden-object" x="5" y="5" width="20" height="20" style="display:none"/>
    <rect id="visible-object" x="60" y="60" width="20" height="20"/>
  </g>
</svg>`;

function loadVisibilityFixture(): void {
  state.doc = importSvg(SVG, 'visibility.svg');
  state.selectedPartId = null;
  state.selectedPathId = null;
  resetHistory();
  buildCanvas(document.getElementById('canvas')!);
  notify();
}

function pathRow(label: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('#layers .layer-row.path'));
  const row = rows.find((candidate) => candidate.querySelector('.layer-name')?.textContent === label);
  if (!row) throw new Error(`missing path row ${label}`);
  return row;
}

describe('imported SVG object visibility', () => {
  it('renders hidden objects invisible, keeps them in Layers, and eye toggle is undoable', () => {
    loadVisibilityFixture();
    document.querySelector<HTMLElement>('#layers .layer-row.part .chevron')!.click();
    const part = state.doc!.parts[0];
    const hidden = part.paths.find((path) => path.label === 'hidden-object')!;
    const visible = part.paths.find((path) => path.label === 'visible-object')!;
    const hiddenElement = document.querySelector<SVGPathElement>(`#rig-svg path[data-path-id="${hidden.id}"]`)!;
    const visibleElement = document.querySelector<SVGPathElement>(`#rig-svg path[data-path-id="${visible.id}"]`)!;

    expect(hiddenElement.getAttribute('visibility')).toBe('hidden');
    expect(visibleElement.getAttribute('visibility')).toBeNull();
    expect(part.pivot).toEqual({ x: 70, y: 70 });
    expect(pathRow('hidden-object').classList.contains('hidden-part')).toBe(true);

    pathRow('hidden-object').querySelector<HTMLButtonElement>('.layer-eye')!.click();
    expect(hidden.hidden).toBeUndefined();
    expect(hiddenElement.getAttribute('visibility')).toBeNull();

    undo();
    const restored = state.doc!.parts[0].paths.find((path) => path.label === 'hidden-object')!;
    expect(restored.hidden).toBe(true);
    expect(document.querySelector(`#rig-svg path[data-path-id="${restored.id}"]`)?.getAttribute('visibility')).toBe('hidden');

  });
});
