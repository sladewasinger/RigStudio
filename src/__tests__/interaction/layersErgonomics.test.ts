/**
 * Editing ergonomics wave (ROADMAP.md "Editing ergonomics wave"): Layers hover tooltips
 * (part/path rows carry `title` = the full label) and the Layers panel width splitter
 * (draggable handle on the layers/canvas boundary, persisted to localStorage, applied on
 * boot — `panels/layersResize.ts`, mirroring timeline/tlState.ts's height-splitter
 * pattern: editor pref, never doc state, no checkpoints).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildLayersPanel } from '../../panels';
import { LAYERS_WIDTH_KEY } from '../../panels/layersResize';
import {
  bootRig, resetRig, state, setEditorMode, dragOnElement, expectClose,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function partRow(partId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${partId}"]`);
  if (!row) throw new Error(`no part row for ${partId}`);
  return row;
}

function ensureExpanded(partId: string): void {
  const chevron = partRow(partId).querySelector<HTMLElement>('.chevron')!;
  if (chevron.textContent === '▸') chevron.click(); // notify() inside rebuilds the tree
}

describe('scenario — layers rows carry a full-label tooltip', () => {
  it('part row title == part.label; path row title == path.label', () => {
    setEditorMode('setup');
    const body = state.doc!.parts.find((p) => p.label === 'body' && !p.parentId)!;
    ensureExpanded(body.id);

    const row = partRow(body.id);
    expect(row.title, 'part row title is the full label').toBe(body.label);

    const pathId = body.paths[0].id;
    const pRow = document.querySelector<HTMLElement>(`#layers .layer-row.path[data-path-id="${pathId}"]`);
    expect(pRow, 'path row rendered under the expanded part').toBeTruthy();
    expect(pRow!.title, 'path row title is the full label').toBe(body.paths[0].label);
  });

  it('title is set even when the label is short (always-set, not truncation-conditional)', () => {
    setEditorMode('setup');
    // Every part row gets a title regardless of whether it visually truncates — the spec
    // explicitly rejects truncation detection as pointless complexity.
    const anyPart = state.doc!.parts[0];
    expect(partRow(anyPart.id).title).toBe(anyPart.label);
  });
});

describe('scenario — layers panel is horizontally resizable', () => {
  it('dragging the splitter changes #layers width and persists it to localStorage', () => {
    const layersEl = document.getElementById('layers')!;
    const splitter = document.getElementById('layers-splitter');
    expect(splitter, 'splitter element exists (created by panels/layersResize.ts on boot)').toBeTruthy();

    const before = layersEl.getBoundingClientRect().width;
    const r = splitter!.getBoundingClientRect();
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const growBy = 60;
    dragOnElement(splitter!, from, { x: from.x + growBy, y: from.y });

    const after = layersEl.getBoundingClientRect().width;
    expectClose(after - before, growBy, 1, 'splitter drag grows #layers by the drag distance');

    const stored = Number(localStorage.getItem(LAYERS_WIDTH_KEY));
    expectClose(stored, after, 1, 'width persisted to localStorage on release');
  });

  it('a fresh rebuild re-applies the persisted width from localStorage', () => {
    const layersEl = document.getElementById('layers')!;
    const layout = document.getElementById('layout')!;
    const splitter = document.getElementById('layers-splitter')!;

    // Grow it, then simulate "reload": drop the splitter + the live CSS var (as a fresh
    // page load would start with neither), and rebuild the panel the way main.ts does.
    const r = splitter.getBoundingClientRect();
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    dragOnElement(splitter, from, { x: from.x + 50, y: from.y });
    const stored = Number(localStorage.getItem(LAYERS_WIDTH_KEY));

    document.getElementById('layers-splitter')!.remove();
    layout.style.removeProperty('--layers-width');
    expect(layout.style.getPropertyValue('--layers-width')).toBe('');

    buildLayersPanel(layersEl);

    expect(document.getElementById('layers-splitter'), 'splitter re-created').toBeTruthy();
    expect(
      layout.style.getPropertyValue('--layers-width'),
      'CSS var re-applied from the persisted localStorage width',
    ).toBe(`${Math.round(stored)}px`);
    expectClose(layersEl.getBoundingClientRect().width, stored, 1, 'panel actually renders at that width');
  });

  it('clamps at the min (160px) and max (50% of window width) bounds', () => {
    const layersEl = document.getElementById('layers')!;
    const splitter = document.getElementById('layers-splitter')!;

    const r0 = splitter.getBoundingClientRect();
    const from0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    dragOnElement(splitter, from0, { x: from0.x - 2000, y: from0.y }); // drag far left
    expectClose(layersEl.getBoundingClientRect().width, 160, 1, 'clamped at the 160px minimum');

    const r1 = splitter.getBoundingClientRect();
    const from1 = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
    dragOnElement(splitter, from1, { x: from1.x + 3000, y: from1.y }); // drag far right
    expectClose(
      layersEl.getBoundingClientRect().width,
      window.innerWidth * 0.5,
      2,
      'clamped at the 50%-of-window maximum',
    );
  });
});
