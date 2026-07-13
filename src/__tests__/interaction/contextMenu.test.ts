/**
 * Interaction tests for the Context-menu polish wave:
 *  - the app-wide native-context-menu suppression chokepoint (`ui/contextMenu.ts`'s
 *    document-level capture-phase listener), including the text-entry exception;
 *  - the new path-level context menus (`ui/pathActions.ts`) on Layers path rows and
 *    canvas paths (gated to an already-selected/"entered" part — a second right-click,
 *    mirroring the double-click drill-down convention);
 *  - Extract path → own part and Move to part…, both pure reuse of the existing
 *    render-neutral `movePathToPart`/`pathMoveRefusal`/`addNullPart`/`registerPart`
 *    primitives — no new geometry math anywhere in this wave.
 *
 * Mutation-checked by hand while writing this file (not left in the tree): commenting
 * out `contextMenu.ts`'s `document.addEventListener('contextmenu', ...)` chokepoint made
 * the "blank canvas" and "a part" suppression assertions fail (`prevented` came back
 * `false`) — confirming the assertions actually exercise the listener, not a tautology.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { undo, canUndo } from '../../core/history';
import { closeMenu } from '../../ui/contextMenu';
import { pathMoveRefusal } from '../../view';
import {
  bootRig, resetRig, state, setEditorMode, partByLabel, medialPoints, placeBoneChain,
  clientCenterOf, clientPointOnPart, pathElById, rightClick, viewBox, docToClient,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);
afterEach(() => closeMenu());

function outerBody() {
  const found = state.doc!.parts.find((part) => part.label === 'body' && !part.parentId);
  if (!found) throw new Error('no root-level "body" part');
  return found;
}
function innerBody() {
  const found = state.doc!.parts.find((part) => part.label === 'body' && !!part.parentId);
  if (!found) throw new Error('no nested "body" part');
  return found;
}
function pathRow(pathId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.path[data-path-id="${pathId}"]`);
  if (!row) throw new Error(`no path row for ${pathId}`);
  return row;
}
function partRow(partId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${partId}"]`);
  if (!row) throw new Error(`no part row for ${partId}`);
  return row;
}
function ensureExpanded(partId: string): void {
  const chevron = partRow(partId).querySelector<HTMLElement>('.chevron')!;
  if (chevron.textContent === '▸') chevron.click();
}
function menuItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.ui-context-menu .ui-context-menu-item'));
}
function menuItem(label: string): HTMLButtonElement {
  const btn = menuItems().find((b) => b.textContent === label);
  if (!btn) throw new Error(`no menu item "${label}" (have: ${menuItems().map((b) => b.textContent).join(', ')})`);
  return btn;
}
function pathRect(pathId: string): DOMRect {
  return pathElById(pathId).getBoundingClientRect();
}
function rectDrift(a: DOMRect, b: DOMRect): number {
  return Math.max(
    Math.abs(a.left - b.left), Math.abs(a.top - b.top),
    Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom),
  );
}

describe('scenario — native context menu suppression is app-wide', () => {
  it('blank canvas: native menu suppressed, no in-app menu appears', () => {
    const vb = viewBox();
    const p = docToClient({ x: vb.x + 1, y: vb.y + 1 });
    expect(rightClick(p.x, p.y), 'chokepoint prevents the native menu by default').toBe(true);
    expect(document.querySelector('.ui-context-menu'), 'no app menu claims blank canvas').toBeNull();
  });

  it('right-click on a part: native menu suppressed AND the part menu opens', () => {
    const p = clientPointOnPart('right_arm');
    expect(rightClick(p.x, p.y)).toBe(true);
    expect(document.querySelector('.ui-context-menu'), 'the part menu claims it').not.toBeNull();
    expect(menuItems().some((b) => b.textContent === 'Duplicate')).toBe(true);
  });

  it('the timeline: native menu suppressed, nothing claims it (no app menu wired there)', () => {
    const r = document.getElementById('timeline')!.getBoundingClientRect();
    expect(rightClick(r.left + r.width / 2, r.top + r.height / 2)).toBe(true);
    expect(document.querySelector('.ui-context-menu')).toBeNull();
  });

  it('the AI prompt textarea: native menu is left alone (text-entry exception)', () => {
    setEditorMode('animate');
    const box = document.querySelector<HTMLTextAreaElement>('.ai-panel textarea');
    expect(box, 'AI prompt textarea present in Animate mode').not.toBeNull();
    const c = clientCenterOf(box!);
    expect(rightClick(c.x, c.y), 'text-entry elements keep the native menu for copy/paste').toBe(false);
  });
});

describe('scenario — canvas path context menu (entered-part gating)', () => {
  it('first right-click on an unselected part shows the PART menu; a second shows the PATH menu', () => {
    setEditorMode('setup');
    const p = clientPointOnPart('right_arm');
    rightClick(p.x, p.y);
    expect(menuItems().some((b) => b.textContent === 'Duplicate'), 'first right-click: part menu').toBe(true);
    closeMenu();

    rightClick(p.x, p.y);
    const labels = menuItems().map((b) => b.textContent);
    expect(labels, 'second right-click on the now-selected part: path menu').toContain('Extract path → own part');
    expect(state.selectedPartId).toBe(partByLabel('right_arm').id);
  });
});

describe('scenario — path-row context menu (Layers panel)', () => {
  it('opens with the expected items, selects the part+path, all enabled on a plain art part', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;

    const c = clientCenterOf(pathRow(shadow.id));
    expect(rightClick(c.x, c.y)).toBe(true);
    expect(state.selectedPartId).toBe(body.id);
    expect(state.selectedPathId).toBe(shadow.id);
    expect(menuItems().map((b) => b.textContent)).toEqual([
      'Rename', 'Delete path', 'Raise in part', 'Lower in part', 'Move to part…', 'Extract path → own part',
    ]);
    expect(menuItem('Delete path').disabled).toBe(false);
    expect(menuItem('Extract path → own part').disabled).toBe(false);
    expect(menuItem('Move to part…').disabled, 'other parts exist to move into').toBe(false);
  });

  it('a skinned part\'s path menu disables Delete/Extract/Move but keeps Rename/Raise/Lower', () => {
    setEditorMode('setup');
    const leg = partByLabel('left_leg');
    placeBoneChain(medialPoints('left_leg', 2)); // Bones 2.0 auto-bind
    expect(leg.skin, 'precondition: the chain deformed the leg').toBeTruthy();
    ensureExpanded(leg.id);
    const legPath = leg.paths[0];
    const c = clientCenterOf(pathRow(legPath.id));

    rightClick(c.x, c.y);
    expect(menuItem('Delete path').disabled, 'skinned parts refuse whole-path delete').toBe(true);
    expect(menuItem('Extract path → own part').disabled, 'skinned parts refuse extraction').toBe(true);
    expect(menuItem('Move to part…').disabled, 'pathMoveRefusal blocks moving OUT of a skinned part').toBe(true);
    expect(menuItem('Rename').disabled).toBe(false);
  });
});

describe('scenario — Extract path → own part', () => {
  it('render-neutral, new part is a sibling, selection lands on it, one undo restores', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const rectBefore = pathRect(shadow.id);
    // ID SET DIFFERENCE, not a label match: PIP_MASTER has SEVERAL parts also labeled
    // "shadow" elsewhere (one per limb) besides the "shadow" PATH under the outer body,
    // so a label lookup could resolve to one of those instead of the freshly created part.
    const partIdsBefore = new Set(state.doc!.parts.map((p) => p.id));
    expect(canUndo()).toBe(false);

    const c = clientCenterOf(pathRow(shadow.id));
    rightClick(c.x, c.y);
    menuItem('Extract path → own part').click();

    const newParts = state.doc!.parts.filter((p) => !partIdsBefore.has(p.id));
    expect(newParts.length, 'exactly one new part created').toBe(1);
    const newPart = newParts[0];
    expect(newPart.label, 'label = the extracted path\'s label').toBe('shadow');
    expect(newPart!.parentId, 'sibling of the original part (same parent)').toBe(body.parentId);
    expect(newPart!.kind, 'became an art part the instant it received a path').toBe('art');
    expect(newPart!.paths.map((p) => p.id)).toEqual([shadow.id]);
    expect(outerBody().paths.some((p) => p.id === shadow.id), 'left the original part').toBe(false);
    expect(state.selectedPartId, 'selection lands on the new part').toBe(newPart!.id);
    expect(state.selectedPathId, 'not scoped into a sub-path').toBeNull();
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'render-neutral (pure movePathToPart reuse)')
      .toBeLessThan(0.01);
    expect(canUndo(), 'one checkpoint for the whole op').toBe(true);

    undo();
    expect(state.doc!.parts.some((p) => !partIdsBefore.has(p.id)), 'undo removes the new part').toBe(false);
    expect(outerBody().paths.some((p) => p.id === shadow.id), 'undo restores the path to its part').toBe(true);
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'undo restores the canvas exactly').toBeLessThan(0.01);
  });
});

describe('scenario — Move to part… (picker reuses movePathToPart end-to-end)', () => {
  it('moves the path via the menu, render-neutral, selection follows, one undo restores', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const rectBefore = pathRect(shadow.id);
    const outerBefore = body.paths.map((p) => p.id);
    const innerBefore = inner.paths.map((p) => p.id);

    // Same eligibility filter buildPathContextMenu uses, so the destination button is
    // located by POSITION rather than by (possibly duplicate) label text — the fixture's
    // nested part happens to share the outer part's "body" label.
    const destinations = [...state.doc!.parts].reverse()
      .filter((p) => p.id !== body.id && pathMoveRefusal(body, p) === null);
    const destIdx = destinations.findIndex((p) => p.id === inner.id);
    expect(destIdx, 'the nested body is an eligible destination').toBeGreaterThanOrEqual(0);

    const c = clientCenterOf(pathRow(shadow.id));
    rightClick(c.x, c.y);
    menuItem('Move to part…').click();
    const pickerItems = menuItems(); // the FIRST menu closed; this is the picker's own list
    expect(pickerItems.length).toBe(destinations.length);
    pickerItems[destIdx].click();

    expect(outerBody().paths.map((p) => p.id)).toEqual(outerBefore.filter((id) => id !== shadow.id));
    expect(innerBody().paths.map((p) => p.id)).toEqual([...innerBefore, shadow.id]);
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'render-neutral').toBeLessThan(0.01);
    expect(state.selectedPartId).toBe(inner.id);
    expect(state.selectedPathId).toBe(shadow.id);
    expect(canUndo()).toBe(true);

    undo();
    expect(outerBody().paths.map((p) => p.id)).toEqual(outerBefore);
    expect(innerBody().paths.map((p) => p.id)).toEqual(innerBefore);
  });
});

describe('scenario — Delete path', () => {
  it('deletes an unskinned part\'s path via the menu: model + DOM updated, one undo restores', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    expect(canUndo()).toBe(false);

    const c = clientCenterOf(pathRow(shadow.id));
    rightClick(c.x, c.y);
    menuItem('Delete path').click();

    expect(outerBody().paths.some((p) => p.id === shadow.id), 'path removed from the model').toBe(false);
    expect(document.querySelector(`[data-path-id="${shadow.id}"]`), 'DOM element removed').toBeNull();
    expect(canUndo()).toBe(true);

    undo();
    expect(outerBody().paths.some((p) => p.id === shadow.id), 'undo restores it').toBe(true);
  });

  it('the LAST path can be deleted — the part becomes an empty kind:"art" null (movePathToPart\'s precedent)', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    ensureExpanded(inner.id);
    while (inner.paths.length > 1) {
      const p = inner.paths[0];
      const c = clientCenterOf(pathRow(p.id));
      rightClick(c.x, c.y);
      menuItem('Delete path').click();
    }
    expect(inner.paths.length).toBe(1);

    const last = inner.paths[0];
    const c = clientCenterOf(pathRow(last.id));
    rightClick(c.x, c.y);
    menuItem('Delete path').click();

    expect(inner.paths.length, 'last path removed').toBe(0);
    expect(inner.kind, 'kind stays art, matching movePathToPart\'s own last-path precedent').toBe('art');
  });

  it('a skinned part\'s path cannot be deleted: menu item disabled, no mutation', () => {
    setEditorMode('setup');
    const leg = partByLabel('left_leg');
    placeBoneChain(medialPoints('left_leg', 2));
    expect(leg.skin).toBeTruthy();
    ensureExpanded(leg.id);
    const legPath = leg.paths[0];
    const pristine = JSON.stringify(state.doc);

    const c = clientCenterOf(pathRow(legPath.id));
    rightClick(c.x, c.y);
    const btn = menuItem('Delete path');
    expect(btn.disabled).toBe(true);
    btn.click(); // real <button disabled> — click listeners don't fire; confirm no mutation anyway
    expect(JSON.stringify(state.doc), 'document untouched').toBe(pristine);
  });
});
