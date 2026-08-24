import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { state } from '../../core/model';
import { canUndo } from '../../core/history';
import {
  bootRig, click, docToClient, gestureDrag, hitAt, medialPoints, moveMouse, overlayCount,
  partByLabel, pressKey, resetRig, selectByLabel, setEditorMode,
} from './harness';
import { effectivePivot } from '../../view/pose';
import { zoomBy } from '../../view';

beforeAll(bootRig);
beforeEach(resetRig);

function buttonWithTitle(prefix: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.title.startsWith(prefix));
  if (!button) throw new Error(`No button titled ${prefix}`);
  return button;
}

function boneCount(): number {
  return state.doc!.parts.filter((part) => part.kind === 'bone').length;
}

function placementSurfaceActive(): boolean {
  return document.getElementById('canvas')!.classList.contains('bone-placement-active');
}

describe('bone tool state stays identical in the toolbar and canvas interaction router', () => {
  it('makes visible origin chrome click-through while armed, then restores pivot dragging', () => {
    selectByLabel('right_arm');
    pressKey('y');
    zoomBy(3);

    const before = partByLabel('right_arm');
    const beforePivot = { ...before.pivot };
    const beforeRest = { ...before.rest };
    const origin = docToClient(effectivePivot(before, null));
    const pivotSelector = `.pivot-handle[data-part-id="${before.id}"]`;
    expect(document.querySelector(pivotSelector), 'origin remains rendered').toBeTruthy();
    expect(hitAt(origin.x, origin.y).closest('[data-role="pivot"]'),
      'mutation guard: before arming, the origin really owns this exact screen point').toBeTruthy();

    buttonWithTitle('Draw a bone chain').click();
    const canvas = document.getElementById('canvas')!;
    expect(canvas.classList.contains('bone-placement-active')).toBe(true);
    expect(document.querySelector(pivotSelector), 'arming does not hide the origin').toBeTruthy();
    expect(getComputedStyle(document.querySelector(pivotSelector)!).pointerEvents).toBe('none');
    expect(getComputedStyle(document.querySelector('.scale-handle')!).pointerEvents,
      'selection handles share the same placement-mode hit priority').toBe('none');
    expect(hitAt(origin.x, origin.y).closest('[data-role="pivot"]'),
      'placement click passes through the visible pivot hit target').toBeNull();
    expect(getComputedStyle(hitAt(origin.x, origin.y)).cursor).toBe('crosshair');

    click(origin.x, origin.y);
    expect(overlayCount('.chain-origin'), 'the exact overlapping click starts a bone').toBe(1);
    expect(partByLabel('right_arm').pivot).toEqual(beforePivot);
    expect(partByLabel('right_arm').rest).toEqual(beforeRest);

    buttonWithTitle('Draw a bone chain').click();
    expect(canvas.classList.contains('bone-placement-active')).toBe(false);
    expect(hitAt(origin.x, origin.y).closest('[data-role="pivot"]'),
      'disarming restores normal origin hit-testing immediately').toBeTruthy();

    gestureDrag(origin, { x: origin.x + 24, y: origin.y - 14 });
    const after = partByLabel('right_arm');
    expect(after.pivot.x !== beforePivot.x || after.pivot.y !== beforePivot.y,
      'the restored origin handle drags normally').toBe(true);
  });

  it('Bone → Translate cancels placement before the next real canvas click', () => {
    const before = boneCount();
    buttonWithTitle('Draw a bone chain').click();

    expect(buttonWithTitle('Draw a bone chain').classList.contains('armed')).toBe(true);
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('true');
    expect(buttonWithTitle('Select (V)').classList.contains('active')).toBe(false);
    expect(buttonWithTitle('Select (V)').getAttribute('aria-pressed')).toBe('false');

    buttonWithTitle('Snapping (%)').click();
    const layer = [...document.querySelectorAll<HTMLElement>('.layer-row.part')]
      .find((row) => row.textContent?.includes('left_leg'))!;
    layer.click();
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed'),
      'non-tool toggles and selection changes preserve both runtime and visible Bone state').toBe('true');

    buttonWithTitle('Translate (T)').click();
    expect(buttonWithTitle('Draw a bone chain').classList.contains('armed')).toBe(false);
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
    expect(buttonWithTitle('Translate (T)').classList.contains('active')).toBe(true);
    expect(buttonWithTitle('Translate (T)').getAttribute('aria-pressed')).toBe('true');
    expect(placementSurfaceActive()).toBe(false);

    const point = medialPoints('left_leg', 1)[0];
    click(point.x, point.y);
    expect(boneCount(), 'the first click belongs only to Translate, never stale Bone').toBe(before);
  });

  it('switching tools discards a lone origin and preview without history or orphan bones', () => {
    const before = boneCount();
    const couldUndoBefore = canUndo();
    const points = medialPoints('left_leg', 1);

    buttonWithTitle('Draw a bone chain').click();
    click(points[0].x, points[0].y);
    moveMouse(points[1].x, points[1].y);
    expect(overlayCount('.chain-origin')).toBe(1);
    expect(overlayCount('.null-glyph.bone.placing')).toBe(1);

    buttonWithTitle('Rotate (R)').click();
    expect(overlayCount('.chain-origin')).toBe(0);
    expect(overlayCount('.null-glyph.bone.placing')).toBe(0);
    expect(boneCount()).toBe(before);
    expect(canUndo()).toBe(couldUndoBefore);
    expect(placementSurfaceActive()).toBe(false);
  });

  it('a second Bone click and Escape both finish the toggle, and B switches it back on', () => {
    buttonWithTitle('Draw a bone chain').click();
    buttonWithTitle('Draw a bone chain').click();
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
    expect(placementSurfaceActive()).toBe(false);

    pressKey('b');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('true');
    pressKey('v');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
    expect(buttonWithTitle('Select (V)').getAttribute('aria-pressed')).toBe('true');
    expect(placementSurfaceActive()).toBe(false);
    pressKey('b');
    pressKey('Escape');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
    expect(placementSurfaceActive()).toBe(false);
    pressKey('b');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('true');
  });

  it('Node editing, Freeze, and Animate transitions visibly and behaviorally disarm Bone', () => {
    buttonWithTitle('Draw a bone chain').click();
    [...document.querySelectorAll<HTMLButtonElement>('.inspector-mode-row button')]
      .find((button) => button.textContent === 'Node editing')!.click();
    expect(state.mode).toBe('nodes');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');

    pressKey('b');
    expect(state.mode, 'Bone returns to the compatible Pose editing mode').toBe('rig');
    buttonWithTitle('Freeze mode').click();
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');

    pressKey('b');
    setEditorMode('animate');
    expect(document.querySelector('[title^="Draw a bone chain"]')).toBeNull();
    setEditorMode('setup');
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
  });

  it('Undo finishes and removes a committed partial chain; Redo restores it disarmed', () => {
    const before = boneCount();
    const points = medialPoints('left_leg', 1);
    buttonWithTitle('Draw a bone chain').click();
    click(points[0].x, points[0].y);
    click(points[1].x, points[1].y);
    expect(boneCount()).toBe(before + 1);

    pressKey('z', { ctrlKey: true });
    expect(boneCount()).toBe(before);
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');

    pressKey('y', { ctrlKey: true });
    expect(boneCount()).toBe(before + 1);
    expect(buttonWithTitle('Draw a bone chain').getAttribute('aria-pressed')).toBe('false');
  });
});
