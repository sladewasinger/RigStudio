/**
 * Interaction tests for the Category B UX wave (ROADMAP.md "Category B — nice-to-have"):
 * Layers search/filter, doc.fps + the timeline ms/frames readout toggle, quick-save vs
 * Save As, invert selection / select none, and the empty-state call-to-action. Recent
 * files (item, deferred to D1) is intentionally NOT covered here.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { selectPart as modelSelectPart, selectAllParts } from '../../core/model';
import { checkpoint } from '../../core/history';
import {
  bootRig, resetRig, state, notify, partByLabel, selectByLabel, setEditorMode,
  pressKey, enterNodeMode, waitFor,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

// ---- Item 1: Layers search/filter ----

describe('scenario — Layers search/filter', () => {
  it('typing filters to matches + their ancestors (auto-expanded); an unrelated part disappears', () => {
    const target = partByLabel('left_arm');
    const ancestorIds: string[] = [];
    let cur = target.parentId ? state.doc!.parts.find((p) => p.id === target.parentId) : undefined;
    while (cur) {
      ancestorIds.push(cur.id);
      cur = cur.parentId ? state.doc!.parts.find((p) => p.id === cur!.parentId) : undefined;
    }
    const unrelated = state.doc!.parts.find((p) => p.label === 'left_leg' && !ancestorIds.includes(p.id))!;
    expect(document.querySelector(`#layers [data-part-id="${unrelated.id}"]`), 'sanity: unrelated part visible pre-search').toBeTruthy();

    const input = document.querySelector<HTMLInputElement>('.layers-search input')!;
    input.focus();
    input.value = 'left_arm';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const matchRow = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${target.id}"]`);
    expect(matchRow, 'match renders').toBeTruthy();
    expect(matchRow!.classList.contains('search-match'), 'match is highlighted').toBe(true);
    for (const aid of ancestorIds) {
      expect(document.querySelector(`#layers [data-part-id="${aid}"]`), `ancestor ${aid} stays visible for context`).toBeTruthy();
    }
    expect(document.querySelector(`#layers [data-part-id="${unrelated.id}"]`), 'unrelated part filtered out').toBeNull();

    // Escape (with an active query) clears the search and restores the full tree.
    const liveInput = document.querySelector<HTMLInputElement>('.layers-search input')!;
    liveInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector<HTMLInputElement>('.layers-search input')!.value, 'query cleared').toBe('');
    expect(document.querySelector(`#layers [data-part-id="${unrelated.id}"]`), 'full tree restored').toBeTruthy();
  });

  it('is case-insensitive and matches a substring anywhere in the label', () => {
    const target = partByLabel('left_arm');
    const input = document.querySelector<HTMLInputElement>('.layers-search input')!;
    input.value = 'LEFT_A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const matchRow = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${target.id}"]`);
    expect(matchRow).toBeTruthy();
  });

  it('clearing the input (not via Escape) also restores the full tree', () => {
    const unrelated = partByLabel('left_leg');
    const input = document.querySelector<HTMLInputElement>('.layers-search input')!;
    input.value = 'left_arm';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector(`#layers [data-part-id="${unrelated.id}"]`)).toBeNull();

    const liveInput = document.querySelector<HTMLInputElement>('.layers-search input')!;
    liveInput.value = '';
    liveInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector(`#layers [data-part-id="${unrelated.id}"]`)).toBeTruthy();
  });
});

// ---- Item 2: doc.fps field + timeline ms/frames toggle ----

describe('scenario — fps field + timeline ms/frames toggle', () => {
  it('editing the fps field updates doc.fps, and the timeline readout toggles ms <-> frames at that fps', () => {
    setEditorMode('setup');
    modelSelectPart(null);
    notify();

    const fpsRow = Array.from(document.querySelectorAll('#inspector .field'))
      .find((f) => f.querySelector('span')?.textContent === 'fps') as HTMLElement;
    expect(fpsRow, 'fps field present in the Document section').toBeTruthy();
    const fpsInput = fpsRow.querySelector('input') as HTMLInputElement;
    expect(Number(fpsInput.value)).toBe(60); // normalizeDoc's default

    fpsInput.value = '30';
    fpsInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.doc!.fps).toBe(30);

    setEditorMode('animate');
    state.currentTime = 500;
    notify();

    const timeEl = document.querySelector<HTMLElement>('.tl-time')!;
    expect(timeEl.textContent, 'default readout is ms').toBe('500 ms');

    timeEl.click(); // toggles to frames + persists the preference
    const afterToggle = document.querySelector<HTMLElement>('.tl-time')!;
    expect(afterToggle.textContent, 'round(500 * 30 / 1000) = 15').toBe('15f');

    afterToggle.click(); // toggles back
    const backToMs = document.querySelector<HTMLElement>('.tl-time')!;
    expect(backToMs.textContent).toBe('500 ms');
  });
});

// ---- Item 3: quick-save vs Save As ----

describe('scenario — quick-save vs Save As', () => {
  beforeEach(() => {
    localStorage.removeItem('rig-studio-last-filename:pip');
  });

  it('Ctrl+S prompts once, remembers the filename, then quick-saves silently; Ctrl+Shift+S always prompts', async () => {
    expect(document.querySelector('.ui-dialog')).toBeNull();

    pressKey('s', { ctrlKey: true });
    await waitFor(() => document.querySelector('.ui-dialog'), { message: 'first Ctrl+S prompts (no remembered filename)' });
    const input1 = document.querySelector<HTMLInputElement>('.ui-dialog input')!;
    input1.value = 'pip_v1.rig.json';
    document.querySelector<HTMLButtonElement>('.ui-dialog-primary')!.click();
    // Wait for the actual side effect, not just the dialog closing: the dialog's promise
    // resolution and doSave()'s async continuation (download + the localStorage write)
    // need a few more microtask hops than "the backdrop element is gone" guarantees.
    await waitFor(() => localStorage.getItem('rig-studio-last-filename:pip'), { message: 'first save completes' });
    expect(localStorage.getItem('rig-studio-last-filename:pip')).toBe('pip_v1.rig.json');

    // Second Ctrl+S: the filename is remembered now, so it quick-saves with no prompt.
    pressKey('s', { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('.ui-dialog'), 'quick-save skips the dialog').toBeNull();

    // Ctrl+Shift+S (Save As) ALWAYS prompts, even with a filename already remembered —
    // and pre-fills the box with it.
    pressKey('s', { ctrlKey: true, shiftKey: true });
    await waitFor(() => document.querySelector('.ui-dialog'), { message: 'Save As always prompts' });
    const input2 = document.querySelector<HTMLInputElement>('.ui-dialog input')!;
    expect(input2.value, 'pre-filled with the remembered name').toBe('pip_v1.rig.json');
    input2.value = 'pip_v2.rig.json';
    document.querySelector<HTMLButtonElement>('.ui-dialog-primary')!.click();
    await waitFor(() => localStorage.getItem('rig-studio-last-filename:pip') === 'pip_v2.rig.json', { message: 'Save As completes' });
    expect(localStorage.getItem('rig-studio-last-filename:pip')).toBe('pip_v2.rig.json');
  });

  it('Cancelling the first Ctrl+S prompt leaves no filename remembered', async () => {
    pressKey('s', { ctrlKey: true });
    await waitFor(() => document.querySelector('.ui-dialog'));
    document.querySelector<HTMLElement>('.ui-dialog-close')!.click();
    await waitFor(() => !document.querySelector('.ui-dialog'));
    expect(localStorage.getItem('rig-studio-last-filename:pip')).toBeNull();
  });
});

// ---- Item 4: Invert selection / Select None ----

describe('scenario — Select None (Ctrl+Shift+A) / Invert selection (Ctrl+I)', () => {
  it('Ctrl+Shift+A deselects every part', () => {
    selectByLabel('left_arm');
    expect(state.selectedPartIds.length).toBeGreaterThan(0);

    pressKey('a', { ctrlKey: true, shiftKey: true });

    expect(state.selectedPartIds).toEqual([]);
    expect(state.selectedPartId).toBeNull();
  });

  it('Ctrl+I inverts to every non-hidden part not currently selected', () => {
    modelSelectPart(null);
    notify();
    selectByLabel('left_arm');
    const before = new Set(state.selectedPartIds);

    pressKey('i', { ctrlKey: true });

    const after = state.selectedPartIds;
    expect(after).not.toContain(partByLabel('left_arm').id);
    const expected = state.doc!.parts.filter((p) => !p.hidden && !before.has(p.id)).map((p) => p.id);
    expect(new Set(after)).toEqual(new Set(expected));
  });

  it('Ctrl+I excludes hidden parts', () => {
    modelSelectPart(null);
    notify();
    const part = partByLabel('left_leg');
    checkpoint();
    part.hidden = true;
    notify();

    pressKey('i', { ctrlKey: true });

    expect(state.selectedPartIds).not.toContain(part.id);
  });

  it('inverting twice restores the original selection (involution)', () => {
    selectByLabel('left_arm');
    const original = [...state.selectedPartIds];
    pressKey('i', { ctrlKey: true });
    pressKey('i', { ctrlKey: true });
    expect(state.selectedPartIds).toEqual(original);
  });

  it('both are a no-op in node-editing mode (out of scope this wave)', () => {
    enterNodeMode('left_leg');
    const before = [...state.selectedPartIds];
    pressKey('i', { ctrlKey: true });
    expect(state.selectedPartIds).toEqual(before);
    pressKey('a', { ctrlKey: true, shiftKey: true });
    expect(state.selectedPartIds).toEqual(before);
  });

  it('does not collide with the existing IK tool key (I) or select-all (Ctrl+A)', () => {
    expect(state.tool).not.toBe('ik');
    pressKey('i', { ctrlKey: true }); // invert, NOT the IK tool
    expect(state.tool).not.toBe('ik');

    modelSelectPart(null);
    notify();
    selectAllParts();
    notify();
    const all = [...state.selectedPartIds];
    pressKey('a', { ctrlKey: true }); // plain select-all, NOT select-none
    expect(state.selectedPartIds).toEqual(all);
  });
});

// ---- Item 5: Empty-state call-to-action ----

describe('scenario — empty-state call-to-action when no document is loaded', () => {
  it('Layers/Inspector/canvas each show a CTA; the CTA\'s "Load sample" button repopulates them', async () => {
    state.doc = null;
    notify();

    const layersEmpty = document.querySelector('#layers .empty-state');
    const inspectorEmpty = document.querySelector('#inspector .empty-state');
    const canvasEmpty = document.querySelector('#canvas .empty-state');
    expect(layersEmpty, 'Layers CTA present').toBeTruthy();
    expect(inspectorEmpty, 'Inspector CTA present').toBeTruthy();
    expect(canvasEmpty, 'canvas CTA present').toBeTruthy();

    const canvasLabels = Array.from(canvasEmpty!.querySelectorAll('button')).map((b) => b.textContent);
    expect(canvasLabels).toEqual(['Open…', 'Load sample', 'New project']);

    const loadSampleBtn = Array.from(canvasEmpty!.querySelectorAll('button'))
      .find((b) => b.textContent === 'Load sample') as HTMLButtonElement;
    loadSampleBtn.click();

    await waitFor(() => state.doc !== null && document.getElementById('rig-svg'), { message: 'sample reloaded via the CTA' });
    notify();
    expect(document.querySelector('#canvas .empty-state'), 'canvas CTA gone once a doc loads').toBeNull();
    expect(document.querySelector('#layers .empty-state'), 'Layers CTA gone once a doc loads').toBeNull();
    expect(document.querySelector('#inspector .empty-state'), 'Inspector CTA gone once a doc loads').toBeNull();

    resetRig(); // restore the pristine fixture for later tests in this file
  });

  it('does not stack duplicate CTAs across repeated notify() calls while doc stays null', () => {
    state.doc = null;
    notify();
    notify();
    notify();
    expect(document.querySelectorAll('#canvas .empty-state').length).toBe(1);
    resetRig();
  });
});
