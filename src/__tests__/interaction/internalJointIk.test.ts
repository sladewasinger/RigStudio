import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canRedo, canUndo, redo, undo } from '../../core/history';
import { notify, selectPart as modelSelectPart } from '../../core/model';
import { effectivePivot, effectiveTip } from '../../geometry/pose';
import { renderPose } from '../../view';
import {
  bootRig, clientCenterOf, clientToDoc, docToClient, expectClose, gestureDrag, hitAt,
  medialPoints, overlayEl, partGroupEl, placeBoneChain, repaint, resetRig, state,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const LIMB = 'left_leg';

function placeChain(count: number) {
  modelSelectPart(null);
  notify();
  renderPose();
  return placeBoneChain(medialPoints(LIMB, count));
}

function current(id: string) {
  return state.doc!.parts.find((part) => part.id === id)!;
}

function tip(id: string) {
  return effectiveTip(current(id), null)!;
}

function pivot(id: string) {
  return effectivePivot(current(id), null);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function renderedPath() {
  return Array.from(partGroupEl(LIMB).querySelectorAll('path'))
    .map((path) => path.getAttribute('d') ?? '').join('|');
}

function poseSnapshot(ids: string[]) {
  return ids.map((id) => ({
    rotate: current(id).rest.rotate,
    pivot: pivot(id),
    tip: tip(id),
  }));
}

function expectSamePose(actual: ReturnType<typeof poseSnapshot>, expected: ReturnType<typeof poseSnapshot>) {
  actual.forEach((pose, index) => {
    expectClose(pose.rotate, expected[index].rotate, 0.15, `bone ${index + 1} rotation`);
    expectClose(distance(pose.pivot, expected[index].pivot), 0, 0.15, `bone ${index + 1} pivot`);
    expectClose(distance(pose.tip, expected[index].tip), 0, 0.15, `bone ${index + 1} tip`);
  });
}

afterEach(() => {
  for (const bone of state.doc!.parts.filter((part) => part.kind === 'bone')) {
    if (!bone.parentId || bone.attachedRoot) continue;
    const parent = state.doc!.parts.find((part) => part.id === bone.parentId);
    if (!parent || parent.kind !== 'bone') continue;
    expectClose(distance(pivot(bone.id), tip(parent.id)), 0, 0.35, 'connected joint has no gap');
  }
});

describe('internal-joint IK direct manipulation', () => {
  it('tracks the grabbed joint and rigidly carries its downstream pose without a tip snap', () => {
    const [root, parent, child, terminal] = placeChain(4);
    const ids = [root.id, parent.id, child.id, terminal.id];
    const lengths = ids.map((id) => {
      const bone = current(id);
      return distance(bone.pivot, bone.boneTip!);
    });
    const jointBefore = tip(parent.id);
    const terminalBefore = tip(terminal.id);
    const childDirectionBefore = {
      x: tip(child.id).x - pivot(child.id).x,
      y: tip(child.id).y - pivot(child.id).y,
    };
    const terminalDirectionBefore = {
      x: terminalBefore.x - pivot(terminal.id).x,
      y: terminalBefore.y - pivot(terminal.id).y,
    };
    const artworkBefore = renderedPath();

    state.tool = 'ik';
    modelSelectPart(parent.id);
    repaint();
    const handle = overlayEl().querySelector<SVGCircleElement>('.bone-tip-handle')!;
    const fromClient = clientCenterOf(handle);
    const rootClient = docToClient(pivot(root.id));
    const towardRoot = { x: rootClient.x - fromClient.x, y: rootClient.y - fromClient.y };
    const magnitude = Math.hypot(towardRoot.x, towardRoot.y) || 1;
    const targetClient = {
      x: fromClient.x + (towardRoot.x / magnitude) * 12 - (towardRoot.y / magnitude) * 7,
      y: fromClient.y + (towardRoot.y / magnitude) * 12 + (towardRoot.x / magnitude) * 7,
    };
    const target = clientToDoc(targetClient.x, targetClient.y);

    gestureDrag(fromClient, targetClient, { steps: 12 });

    const jointAfter = tip(parent.id);
    const terminalAfter = tip(terminal.id);
    const jointDelta = { x: jointAfter.x - jointBefore.x, y: jointAfter.y - jointBefore.y };
    const terminalDelta = {
      x: terminalAfter.x - terminalBefore.x,
      y: terminalAfter.y - terminalBefore.y,
    };
    expectClose(distance(jointAfter, target), 0, 1.5, 'grabbed internal joint follows pointer');
    expectClose(terminalDelta.x, jointDelta.x, 0.45, 'terminal x rides the joint');
    expectClose(terminalDelta.y, jointDelta.y, 0.45, 'terminal y rides the joint');
    expect(distance(terminalAfter, terminalBefore), 'small drag produces bounded terminal motion')
      .toBeLessThan(distance(target, jointBefore) * 1.25);

    const childDirectionAfter = {
      x: tip(child.id).x - pivot(child.id).x,
      y: tip(child.id).y - pivot(child.id).y,
    };
    const terminalDirectionAfter = {
      x: terminalAfter.x - pivot(terminal.id).x,
      y: terminalAfter.y - pivot(terminal.id).y,
    };
    expectClose(distance(childDirectionAfter, childDirectionBefore), 0, 0.45, 'child axis does not whip');
    expectClose(
      distance(terminalDirectionAfter, terminalDirectionBefore), 0, 0.45,
      'terminal axis does not flip',
    );
    ids.forEach((id, index) => {
      const bone = current(id);
      expectClose(distance(bone.pivot, bone.boneTip!), lengths[index], 0.001, 'bone length preserved');
    });
    expect(renderedPath(), 'the skinned limb deforms with the joint').not.toBe(artworkBefore);

    expect(canUndo()).toBe(true);
    undo();
    expectClose(distance(tip(parent.id), jointBefore), 0, 0.001, 'undo restores joint');
    expectClose(distance(tip(terminal.id), terminalBefore), 0, 0.001, 'undo restores terminal');
    expect(canRedo()).toBe(true);
    redo();
    expectClose(distance(tip(parent.id), jointAfter), 0, 0.001, 'redo restores joint drag');
    expectClose(distance(tip(terminal.id), terminalAfter), 0, 0.001, 'redo restores carried pose');
  });

  it('keeps terminal-tip IK as a full-chain solve', () => {
    const bones = placeChain(4);
    const terminal = bones[bones.length - 1];
    const rotations = bones.map((bone) => bone.rest.rotate);
    state.tool = 'ik';
    modelSelectPart(terminal.id);
    repaint();
    const from = docToClient(tip(terminal.id));
    const root = docToClient(pivot(bones[0].id));
    const dx = root.x - from.x;
    const dy = root.y - from.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const target = {
      x: from.x + dx * 0.45 - (dy / magnitude) * 35,
      y: from.y + dy * 0.45 + (dx / magnitude) * 35,
    };

    gestureDrag(from, target, { steps: 12 });

    bones.forEach((bone, index) => {
      expect(Math.abs(current(bone.id).rest.rotate - rotations[index]), `bone ${index + 1} solves`)
        .toBeGreaterThan(0.2);
    });
    expectClose(distance(tip(terminal.id), clientToDoc(target.x, target.y)), 0, 2, 'terminal tracks pointer');
  });

  it('makes a selected child origin and its parent tip the same shared-joint control', () => {
    const [root, parent, child, terminal] = placeChain(4);
    const ids = [root.id, parent.id, child.id, terminal.id];
    current(root.id).rest.rotate = 8;
    current(parent.id).rest.rotate = -13;
    current(child.id).rest.rotate = 19;
    current(terminal.id).rest.rotate = -7;
    repaint();
    state.tool = 'ik';
    const sharedClient = docToClient(tip(parent.id));
    const rootClient = docToClient(pivot(root.id));
    const dx = rootClient.x - sharedClient.x;
    const dy = rootClient.y - sharedClient.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const target1 = {
      x: sharedClient.x + (dx / magnitude) * 10 - (dy / magnitude) * 6,
      y: sharedClient.y + (dy / magnitude) * 10 + (dx / magnitude) * 6,
    };
    const target2 = {
      x: target1.x + (dx / magnitude) * 4 + (dy / magnitude) * 3,
      y: target1.y + (dy / magnitude) * 4 - (dx / magnitude) * 3,
    };

    // Route A: select the CHILD, then grab its origin through the real hit stack.
    modelSelectPart(child.id);
    repaint();
    let from = clientCenterOf(
      overlayEl().querySelector(`[data-role="pivot"][data-part-id="${child.id}"]`)! as Element,
    );
    const childHit = hitAt(from.x, from.y).closest('[data-role="pivot"]') as SVGElement | null;
    expect(childHit?.dataset.partId, 'actual hit is the selected child origin').toBe(child.id);
    gestureDrag(from, target1, { steps: 8 });
    expectClose(distance(tip(parent.id), clientToDoc(target1.x, target1.y)), 0, 1.5, 'child-origin first drag tracks');
    const childPose1 = poseSnapshot(ids);
    from = clientCenterOf(
      overlayEl().querySelector(`[data-role="pivot"][data-part-id="${child.id}"]`)! as Element,
    );
    gestureDrag(from, target2, { steps: 8 });
    expectClose(distance(tip(parent.id), clientToDoc(target2.x, target2.y)), 0, 1.5, 'child-origin second drag tracks');
    const childPose2 = poseSnapshot(ids);
    const childArtwork2 = renderedPath();

    undo();
    undo();

    // Route B: select the PARENT, grab the exact same joint as its tip, and compare the
    // complete pose after each identical pointer gesture.
    modelSelectPart(parent.id);
    repaint();
    from = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    expect((hitAt(from.x, from.y) as SVGElement).dataset.role, 'actual hit is parent tip')
      .toBe('bone-tip');
    gestureDrag(from, target1, { steps: 8 });
    expectSamePose(poseSnapshot(ids), childPose1);
    from = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(from, target2, { steps: 8 });
    expectSamePose(poseSnapshot(ids), childPose2);
    expect(renderedPath(), 'selection-independent skin deformation').toBe(childArtwork2);

    undo();
    undo();
    redo();
    redo();
    expectSamePose(poseSnapshot(ids), childPose2);
  });
});
