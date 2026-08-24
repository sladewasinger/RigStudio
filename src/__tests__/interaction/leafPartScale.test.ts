import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canUndo, undo } from '../../core/history';
import {
  bootRig, resetRig, state, overlayCount, overlayEl, clientCenterOf, gestureDrag,
  setEditorMode, clipTrack, partGroupEl, expectClose,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function input(label: string): HTMLInputElement {
  const row = Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'))
    .find((candidate) => candidate.querySelector('span')?.textContent === label);
  const field = row?.querySelector<HTMLInputElement>('input');
  if (!field) throw new Error(`missing inspector field ${label}`);
  return field;
}

function selectLeftEyePath() {
  const owner = state.doc!.parts.find((part) =>
    part.paths.some((path) => path.label.toLowerCase() === 'left_eye'))!;
  const path = owner.paths.find((candidate) => candidate.label.toLowerCase() === 'left_eye')!;
  const chain = [];
  let current: typeof owner | null = owner;
  while (current) {
    chain.unshift(current);
    current = current.parentId
      ? state.doc!.parts.find((candidate) => candidate.id === current!.parentId) ?? null
      : null;
  }
  for (const part of chain) {
    const row = document.querySelector<HTMLElement>(`.layer-row.part[data-part-id="${part.id}"]`)!;
    const chevron = row.querySelector<HTMLElement>('.chevron')!;
    if (chevron.textContent === '▸') chevron.click();
  }
  const row = document.querySelector<HTMLElement>(`.layer-row.path[data-path-id="${path.id}"]`)!;
  row.click();
  expect(overlayCount('.scale-handle')).toBe(8);
  return { ownerId: owner.id, pathId: path.id };
}

describe('independent imported leaf transforms', () => {
  it('promotes on Edit numeric scale and canvas scaling affects only that eye around its own pivot', () => {
    const { ownerId, pathId } = selectLeftEyePath();
    const sibling = state.doc!.parts.find((part) => part.id === ownerId)!.paths[0];
    const ownerGroup = partGroupEl('eyes');
    const siblingEl = ownerGroup.querySelector<SVGPathElement>(`[data-path-id="${sibling.id}"]`)!;
    const siblingBefore = siblingEl.getBoundingClientRect();
    const boxBefore = ownerGroup.querySelector<SVGPathElement>(`[data-path-id="${pathId}"]`)!
      .getBoundingClientRect();

    const sx = input('rest scale x');
    sx.value = '1.5';
    sx.dispatchEvent(new Event('change', { bubbles: true }));

    const leaf = state.doc!.parts.find((part) => part.id === state.selectedPartId)!;
    expect(leaf.id).not.toBe(ownerId);
    expect(leaf.label).toBe('left_eye');
    expect(leaf.paths.map((candidate) => candidate.id)).toEqual([pathId]);
    expect(state.doc!.parts.find((part) => part.id === leaf.id)!.rest.sx).toBe(1.5);
    expect(state.doc!.parts.find((part) => part.id === ownerId)!.rest.sx).toBe(1);
    const numericBox = partGroupEl('left_eye').getBoundingClientRect();
    expectClose(numericBox.width / boxBefore.width, 1.5, 0.04, 'only the selected eye widens');

    const east = clientCenterOf(overlayEl().querySelector('[data-handle="e"]')!);
    gestureDrag(east, { x: east.x + 8, y: east.y });
    const draggedBox = partGroupEl('left_eye').getBoundingClientRect();
    expect(draggedBox.width, 'Edit scale handle further changes the leaf bounds')
      .toBeGreaterThan(numericBox.width);
    const siblingAfter = siblingEl.getBoundingClientRect();
    expectClose(siblingAfter.width, siblingBefore.width, 0.05, 'the sibling eye stays unchanged');
  });

  it('Animate scale handle keys only the leaf and scrubs through its own sx/sy tracks', () => {
    setEditorMode('animate');
    const { ownerId, pathId } = selectLeftEyePath();
    const leaf = state.doc!.parts.find((part) => part.id === state.selectedPartId)!;
    expect(leaf.id).not.toBe(ownerId);
    expect(leaf.paths.map((candidate) => candidate.id)).toEqual([pathId]);
    state.currentTime = 1000;
    document.getElementById('right-dock-tab-inspector')!.click();
    expect(overlayCount('.scale-handle')).toBe(8);
    const se = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const nw = clientCenterOf(overlayEl().querySelector('[data-handle="nw"]')!);
    gestureDrag(se, {
      x: se.x + 0.3 * (se.x - nw.x),
      y: se.y + 0.3 * (se.y - nw.y),
    }, { ctrlKey: true });

    expect(clipTrack(leaf.id, 'sx')?.keyframes).toHaveLength(1);
    expect(clipTrack(leaf.id, 'sy')?.keyframes).toHaveLength(1);
    expect(clipTrack(ownerId, 'sx')).toBeUndefined();
    expect(state.doc!.clips[0].tracks.filter((track) => track.target !== leaf.id)).toHaveLength(0);
    expect(canUndo()).toBe(true);
    undo();
    expect(clipTrack(leaf.id, 'sx')).toBeUndefined();
    expect(clipTrack(leaf.id, 'sy')).toBeUndefined();
  });
});
