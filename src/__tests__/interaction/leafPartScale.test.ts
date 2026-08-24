import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canUndo, redo, undo } from '../../core/history';
import { exportRiv } from '../../io/riv';
import { decodeRiv, PROP, TYPE } from '../rivDecoder';
import { ctx } from '../../view/context';
import {
  bootRig, resetRig, state, overlayCount, overlayEl, clientCenterOf, gestureDrag,
  setEditorMode, clipTrack, partGroupEl, expectClose, notify, repaint, fullDblClick,
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

function revealPathRow(ownerId: string, pathId: string): HTMLElement {
  const owner = state.doc!.parts.find((part) => part.id === ownerId)!;
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
  return document.querySelector<HTMLElement>(`.layer-row.path[data-path-id="${pathId}"]`)!;
}

function prepareMouth() {
  const face = state.doc!.parts.find((part) => part.label === 'face')!;
  const mouth = face.paths[0];
  mouth.label = 'mouth';
  notify();
  return { face, mouth, eyes: state.doc!.parts.find((part) => part.label === 'eyes')! };
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
    expect(state.selectedPartId).toBe(ownerId);
    expect(state.selectedPathId).toBe(pathId);
    state.currentTime = 1000;
    document.getElementById('right-dock-tab-inspector')!.click();
    expect(overlayCount('.scale-handle')).toBe(8);
    const se = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const nw = clientCenterOf(overlayEl().querySelector('[data-handle="nw"]')!);
    gestureDrag(se, {
      x: se.x + 0.3 * (se.x - nw.x),
      y: se.y + 0.3 * (se.y - nw.y),
    }, { ctrlKey: true });

    const leaf = state.doc!.parts.find((part) => part.id === state.selectedPartId)!;
    expect(leaf.id).not.toBe(ownerId);
    expect(leaf.paths.map((candidate) => candidate.id)).toEqual([pathId]);
    expect(clipTrack(leaf.id, 'sx')?.keyframes).toHaveLength(1);
    expect(clipTrack(leaf.id, 'sy')?.keyframes).toHaveLength(1);
    expect(clipTrack(ownerId, 'sx')).toBeUndefined();
    expect(state.doc!.clips[0].tracks.filter((track) => track.target !== leaf.id)).toHaveLength(0);
    expect(canUndo()).toBe(true);
    undo();
    expect(state.doc!.parts.some((part) => part.id === leaf.id)).toBe(false);
    expect(state.doc!.parts.find((part) => part.id === ownerId)!.paths.some((path) => path.id === pathId))
      .toBe(true);
  });

  it('carries a Setup mouth path selection into Animate and numeric scale keys the promoted mouth, never face', () => {
    const { face, mouth, eyes } = prepareMouth();
    const originalSlot = face.childOrder!.findIndex((slot) => slot.kind === 'path' && slot.id === mouth.id);
    revealPathRow(face.id, mouth.id).click();
    expect(state.selectedPartId).toBe(face.id);
    expect(state.selectedPathId).toBe(mouth.id);

    const mouthBefore = partGroupEl('face').querySelector<SVGPathElement>(`[data-path-id="${mouth.id}"]`)!
      .getBoundingClientRect();
    const eyesBefore = partGroupEl(eyes.label).getBoundingClientRect();
    setEditorMode('animate');
    state.currentTime = 700;
    notify(); repaint();
    document.getElementById('right-dock-tab-inspector')!.click();
    expect(document.querySelector('#inspector h3')?.textContent).toContain('mouth');
    const sx = input('scale x');
    sx.value = '1.5';
    sx.dispatchEvent(new Event('change', { bubbles: true }));

    const leaf = state.doc!.parts.find((part) => part.id === state.selectedPartId)!;
    expect(leaf.label).toBe('mouth');
    expect(leaf.parentId).toBe(face.id);
    expect(leaf.paths.map((path) => path.id)).toEqual([mouth.id]);
    expect(state.selectedPathId).toBeNull();
    expect(clipTrack(leaf.id, 'sx')?.keyframes.map((key) => [key.time, key.value]))
      .toEqual([[700, 1.5]]);
    expect(clipTrack(face.id, 'sx'), 'ancestor fallback must never receive the key').toBeUndefined();
    expect([...document.querySelectorAll('.tl-lane-label')].map((label) => label.textContent))
      .toContain('mouth.sx');
    expect(face.childOrder![originalSlot]).toEqual({ kind: 'part', id: leaf.id });

    const mouthAfter = partGroupEl('mouth').getBoundingClientRect();
    expectClose(mouthAfter.width / mouthBefore.width, 1.5, 0.04, 'mouth alone scales');
    const eyesAfter = partGroupEl(eyes.label).getBoundingClientRect();
    expectClose(eyesAfter.width, eyesBefore.width, 0.02, 'eyes width stays invariant');
    expectClose(eyesAfter.height, eyesBefore.height, 0.02, 'eyes height stays invariant');

    const decoded = decodeRiv(exportRiv(state.doc!));
    const mouthNode = decoded.objects.find((object) =>
      object.typeKey === TYPE.NODE && object.props[PROP.NAME] === 'mouth')!;
    const faceNode = decoded.objects.find((object) =>
      object.typeKey === TYPE.NODE && object.props[PROP.NAME] === 'face')!;
    const animation = decoded.animations.find((candidate) =>
      candidate.name === state.doc!.clips[state.activeClipIndex].name)!;
    expect(animation.objects.find((object) => object.objectId === mouthNode.index)?.props
      .some((property) => property.propertyKey === PROP.SCALE_X)).toBe(true);
    expect(animation.objects.find((object) => object.objectId === faceNode.index)?.props
      .some((property) => property.propertyKey === PROP.SCALE_X) ?? false).toBe(false);

    undo();
    expect(state.doc!.parts.some((part) => part.id === leaf.id)).toBe(false);
    expect(state.doc!.parts.find((part) => part.id === face.id)!.paths.some((path) => path.id === mouth.id))
      .toBe(true);
    redo();
    expect(state.doc!.parts.find((part) => part.id === leaf.id)).toBeTruthy();
    const serialized = (window as any).__rigStudio.serializeDoc(state.doc!);
    expect((window as any).__rigStudio.loadProjectText(serialized)).toBe(true);
    expect(state.doc!.parts.find((part) => part.id === leaf.id)?.parentId).toBe(face.id);
    expect(clipTrack(leaf.id, 'sx')?.keyframes[0].value).toBe(1.5);
  });

  it('canvas path drill-down and a scale handle use the same mouth leaf ownership', () => {
    const { face, mouth, eyes } = prepareMouth();
    revealPathRow(face.id, mouth.id);
    const faceRow = document.querySelector<HTMLElement>(`.layer-row.part[data-part-id="${face.id}"]`)!;
    faceRow.click();
    setEditorMode('animate');
    const mouthEl = partGroupEl('face').querySelector<SVGPathElement>(`[data-path-id="${mouth.id}"]`)!;
    const rect = mouthEl.getBoundingClientRect();
    fullDblClick(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(state.selectedPartId).toBe(face.id);
    expect(state.selectedPathId).toBe(mouth.id);
    const eyesBefore = partGroupEl(eyes.label).getBoundingClientRect();
    state.currentTime = 900;
    ctx.handleMode = 'scale';
    repaint();
    const se = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const nw = clientCenterOf(overlayEl().querySelector('[data-handle="nw"]')!);
    gestureDrag(se, { x: se.x + 0.25 * (se.x - nw.x), y: se.y + 0.25 * (se.y - nw.y) }, { ctrlKey: true });
    const leaf = state.doc!.parts.find((part) => part.id === state.selectedPartId)!;
    expect(leaf.label).toBe('mouth');
    expect(clipTrack(leaf.id, 'sx')).toBeTruthy();
    expect(clipTrack(face.id, 'sx')).toBeUndefined();
    const eyesAfter = partGroupEl(eyes.label).getBoundingClientRect();
    expectClose(eyesAfter.width, eyesBefore.width, 0.02, 'canvas route leaves eyes unchanged');
  });

  it('selecting face itself keys face scale and the inherited keyed scale grows its whole subtree', () => {
    const { face, mouth, eyes } = prepareMouth();
    revealPathRow(face.id, mouth.id);
    document.querySelector<HTMLElement>(`.layer-row.part[data-part-id="${face.id}"]`)!.click();
    expect(state.selectedPathId).toBeNull();
    setEditorMode('animate');
    state.currentTime = 600;
    notify(); repaint();
    document.getElementById('right-dock-tab-inspector')!.click();
    const eyesBefore = partGroupEl(eyes.label).getBoundingClientRect();
    const mouthBefore = partGroupEl(face.label).querySelector<SVGPathElement>(`[data-path-id="${mouth.id}"]`)!
      .getBoundingClientRect();
    const sx = input('scale x');
    sx.value = '1.4';
    sx.dispatchEvent(new Event('change', { bubbles: true }));

    expect(clipTrack(face.id, 'sx')?.keyframes[0].value).toBe(1.4);
    const eyesAfter = partGroupEl(eyes.label).getBoundingClientRect();
    const mouthAfter = partGroupEl(face.label).querySelector<SVGPathElement>(`[data-path-id="${mouth.id}"]`)!
      .getBoundingClientRect();
    expectClose(eyesAfter.width / eyesBefore.width, 1.4, 0.04, 'face key scales child eyes');
    expectClose(mouthAfter.width / mouthBefore.width, 1.4, 0.04, 'face key scales its mouth');
    expect([...document.querySelectorAll('.tl-lane-label')].map((label) => label.textContent))
      .toContain('face.sx');
  });
});
