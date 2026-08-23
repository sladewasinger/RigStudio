/**
 * Regression coverage for imported, partless SVG container groups. These groups have no
 * paint run of their own, so their import-time bbox pivot must be resolved from descendant
 * geometry before the canvas is built. Their origin remains a normal Freeze-mode pivot.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importSvg } from '../../io/importSvg';
import { buildCanvas, resetView } from '../../view';
import {
  bootRig, resetRig, state, notify, repaint, pressKey, gestureDrag, clientCenterOf,
  overlayEl, pathElById, rawToClient, expectClose,
} from './harness';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const NESTED_GROUP_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="${INKSCAPE_NS}"
       viewBox="0 0 200 160">
    <g inkscape:label="pip" transform="translate(10 20)">
      <g inkscape:label="body" transform="translate(30 40)">
        <rect inkscape:label="body_fill" x="0" y="0" width="20" height="10" fill="#f66"/>
      </g>
    </g>
  </svg>`;

beforeAll(bootRig);
beforeEach(resetRig);

describe('imported group pivots', () => {
  it('centres top-level and nested partless groups, then Freeze-drags the top origin without moving art', () => {
    state.doc = importSvg(NESTED_GROUP_SVG, 'nested-groups.svg');
    state.editorMode = 'setup';
    state.mode = 'rig';
    state.freezeMode = false;
    state.selectedPartId = null;
    state.selectedPartIds = [];
    buildCanvas(document.getElementById('canvas')!);
    resetView();

    const pip = state.doc.parts.find((p) => p.label === 'pip')!;
    const body = state.doc.parts.find((p) => p.label === 'body')!;
    const bodyPath = body.paths[0];
    expect(pip.kind).toBe('group');
    expect(pip.paths).toHaveLength(0);
    expectClose(body.pivot.x, 50, 0.001, 'nested group pivot x');
    expectClose(body.pivot.y, 65, 0.001, 'nested group pivot y');
    expectClose(pip.pivot.x, 50, 0.001, 'top-level group pivot x');
    expectClose(pip.pivot.y, 65, 0.001, 'top-level group pivot y');
    expect(pip.pivotHint).toBeNull();
    expect(body.pivotHint).toBeNull();

    // Exercise the compensation path, not only the trivial unrotated case: descendants
    // inherit this container pose and must remain visually fixed while its origin moves.
    pip.rest.rotate = 18;
    state.selectedPartId = pip.id;
    state.selectedPartIds = [pip.id];
    notify();
    repaint();
    pressKey('y');
    repaint();

    const before = rawToClient(bodyPath.id, 0, 0);
    const marker = overlayEl().querySelector(
      `[data-role="pivot"][data-part-id="${pip.id}"] .pivot-grab`,
    )!;
    const from = clientCenterOf(marker);
    gestureDrag(from, { x: from.x + 35, y: from.y - 24 });

    const after = rawToClient(bodyPath.id, 0, 0);
    expect(Math.hypot(pip.pivot.x - 50, pip.pivot.y - 65)).toBeGreaterThan(1);
    expectClose(after.x, before.x, 0.05, 'root-group pivot edit preserves artwork x');
    expectClose(after.y, before.y, 0.05, 'root-group pivot edit preserves artwork y');
    expect(pathElById(bodyPath.id)).toBeTruthy();
  });
});
