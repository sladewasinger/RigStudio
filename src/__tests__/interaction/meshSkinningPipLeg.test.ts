/**
 * Pip leg regression for the vector-mesh skinning workflow. The imported leg is one
 * art part with two painted paths (the leg and its inner shadow). A two-bone chain
 * must bind both paths to the same skin, and moving the shared knee must deform both
 * rendered outlines without mutating their bind-pose path data.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notify, selectPart } from '../../core/model';
import { renderPose } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, medialPoints, placeBoneChain,
  overlayEl, clientCenterOf, gestureDrag, pathElById,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

describe('Pip leg vector-mesh skinning', () => {
  it('moving the knee deforms the leg and its shadow together', () => {
    const leg = partByLabel('left_leg');
    const painted = leg.paths.filter((path) => path.label === 'leg' || path.label === 'shadow');
    expect(painted.map((path) => path.label).sort()).toEqual(['leg', 'shadow']);
    selectPart(leg.id);
    notify();
    renderPose();
    const bones = placeBoneChain(medialPoints('left_leg', 2));

    const boundLeg = state.doc!.parts.find((part) => part.id === leg.id)!;
    expect(boundLeg.skin?.bones.map((bone) => bone.id)).toEqual(bones.map((bone) => bone.id));
    const bindPose = new Map(boundLeg.paths.map((path) => [path.id, path.d]));
    const renderedAtBind = new Map(
      painted.map((path) => [path.id, pathElById(path.id).getAttribute('d')]),
    );

    selectPart(bones[0].id);
    notify();
    renderPose();
    const knee = overlayEl().querySelector('[data-role="bone-tip"]') as SVGElement;
    expect(knee).toBeTruthy();
    const from = clientCenterOf(knee);
    gestureDrag(from, { x: from.x + 28, y: from.y - 18 }, { steps: 10 });

    for (const path of painted) {
      expect(pathElById(path.id).getAttribute('d'), `${path.label} rendered outline deformed`)
        .not.toBe(renderedAtBind.get(path.id));
      expect(
        state.doc!.parts.find((part) => part.id === leg.id)!.paths.find((item) => item.id === path.id)!.d,
        `${path.label} bind-pose geometry stayed immutable`,
      ).toBe(bindPose.get(path.id));
    }
  });
});
