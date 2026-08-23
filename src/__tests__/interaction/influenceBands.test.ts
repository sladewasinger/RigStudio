import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redo, undo } from '../../core/history';
import { notify, selectPart } from '../../core/model';
import { activeInfluenceTarget, cancelInfluenceEditing, renderPose } from '../../view';
import {
  bootRig, clientCenterOf, gestureDrag, medialPoints, overlayEl, partByLabel,
  pathElById, placeBoneChain, resetRig, state, assertScreenConstant, svgEl,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function inspectorButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#inspector button'))
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`no inspector button ${label}`);
  return button;
}

function preparePipLeg() {
  cancelInfluenceEditing();
  const leg = partByLabel('left_leg');
  selectPart(leg.id);
  notify();
  renderPose();
  const bones = placeBoneChain(medialPoints('left_leg', 3));
  bones[1].rest.rotate = 42;
  renderPose();
  selectPart(leg.id);
  notify();
  renderPose();
  return { leg, bones, painted: leg.paths.filter((path) => ['leg', 'shadow'].includes(path.label)) };
}

describe('group influence-band authoring', () => {
  it('discovers a shared bound subtree and previews every painted path without moving bones', () => {
    const { bones, painted } = preparePipLeg();
    expect(painted.map((path) => path.label).sort()).toEqual(['leg', 'shadow']);
    const skeleton = bones.map((bone) => ({ pivot: { ...bone.pivot }, tip: { ...bone.boneTip! }, rest: { ...bone.rest } }));
    inspectorButton('Edit group weights').click();

    expect(overlayEl().querySelectorAll('.influence-band')).toHaveLength(2);
    expect(overlayEl().querySelectorAll('[data-band-handle="center"]')).toHaveLength(2);
    expect(overlayEl().querySelector('[data-role="bone-tip"]')).toBeNull();
    expect(overlayEl().querySelectorAll('.influence-band-callout')).toHaveLength(1);
    expect(overlayEl().querySelectorAll('.influence-band-badge').length).toBeGreaterThan(0);
    const callout = overlayEl().querySelector('.influence-band-callout') as SVGElement;
    expect(callout.getBoundingClientRect().width).toBeLessThan(75);
    expect(callout.getBoundingClientRect().height).toBeLessThan(28);
    const before = painted.map((path) => pathElById(path.id).getAttribute('d'));

    const width = overlayEl().querySelector('[data-band-handle="widthEnd"]') as SVGElement;
    const center = overlayEl().querySelector('[data-band-handle="center"]') as SVGElement;
    const from = clientCenterOf(width);
    expect((document.elementFromPoint(from.x, from.y) as SVGElement)?.dataset.role).toBe('influence-band');
    const centerPoint = clientCenterOf(center);
    const dx = from.x - centerPoint.x, dy = from.y - centerPoint.y;
    const length = Math.hypot(dx, dy) || 1;
    const centerBefore = activeInfluenceTarget()!.profile.bands.map((band) => band.center);
    gestureDrag(centerPoint, {
      x: centerPoint.x + dx / length * 80,
      y: centerPoint.y + dy / length * 80,
    }, { steps: 7 });
    expect(activeInfluenceTarget()!.profile.bands.map((band) => band.center)).not.toEqual(centerBefore);
    const after = painted.map((path) => pathElById(path.id).getAttribute('d'));
    for (let i = 0; i < painted.length; i++) expect(after[i], painted[i].label).not.toBe(before[i]);
    expect(bones.map((bone) => ({ pivot: bone.pivot, tip: bone.boneTip, rest: bone.rest }))).toEqual(skeleton);
    assertScreenConstant('.influence-band-callout', 10);
    const calloutRect = (overlayEl().querySelector('.influence-band-callout') as SVGElement)
      .getBoundingClientRect();
    const viewport = svgEl().getBoundingClientRect();
    expect(calloutRect.left).toBeGreaterThanOrEqual(viewport.left - 1);
    expect(calloutRect.right).toBeLessThanOrEqual(viewport.right + 1);
    expect(calloutRect.top).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(calloutRect.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
  });

  it('Cancel restores entry state; Apply is one undoable edit and redo restores it', () => {
    const { leg } = preparePipLeg();
    inspectorButton('Edit group weights').click();
    const center = overlayEl().querySelector('[data-band-handle="center"]') as SVGElement;
    const from = clientCenterOf(center);
    gestureDrag(from, { x: from.x + 30, y: from.y + 10 });
    expect(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile).toBeFalsy();
    inspectorButton('Cancel').click();
    expect(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile).toBeFalsy();

    inspectorButton('Edit group weights').click();
    const nextCenter = overlayEl().querySelector('[data-band-handle="center"]') as SVGElement;
    const nextFrom = clientCenterOf(nextCenter);
    gestureDrag(nextFrom, { x: nextFrom.x + 25, y: nextFrom.y + 12 });
    inspectorButton('Apply / Done').click();
    const applied = structuredClone(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile);
    expect(applied?.bands.length).toBe(2);
    undo();
    expect(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile).toBeFalsy();
    redo();
    expect(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile).toEqual(applied);
  });

  it('Reset Auto is deterministic and switching canvas tools cancels a draft without history', () => {
    const { leg } = preparePipLeg();
    inspectorButton('Edit group weights').click();
    const center = overlayEl().querySelector('[data-band-handle="center"]') as SVGElement;
    const from = clientCenterOf(center);
    gestureDrag(from, { x: from.x + 35, y: from.y });
    inspectorButton('Reset Auto').click();
    inspectorButton('Apply / Done').click();
    expect(state.doc!.parts.find((part) => part.id === leg.id)!.influenceProfile?.bands.every(
      (band) => band.center === 0,
    )).toBe(true);

    inspectorButton('Edit group weights').click();
    const rotateTool = document.querySelectorAll<HTMLButtonElement>('#canvas-tools .tool-switch button')[2];
    rotateTool.click();
    expect(overlayEl().querySelector('.influence-band')).toBeNull();
  });
});
