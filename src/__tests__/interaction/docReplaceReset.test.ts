/**
 * Interaction tests for the doc-replace reset (hardening wave, class 3): main.ts's
 * afterDocReplaced is the SINGLE doc-swap path (New / Open / Load sample /
 * loadProjectText). A confirmed live bug had `state.mode` ('nodes') and
 * `state.selectedPathId` survive Load Sample into the fresh doc — stale ids left over
 * from the OLD doc. These tests build up a pile of session-only editing state (node
 * mode + node selection, freeze, an entered group, an armed bone placement, a running
 * SM preview) THEN drive the real replace path (`hook().loadProjectText` — the exact
 * call New/Open/Load-sample make) and assert every piece of it comes back clean.
 *
 * resetRig() itself pre-clears most of this state before calling loadProjectText (so
 * beforeEach starts every test from a known-clean slate), which is why these tests
 * build state up AFTER boot and replace on top of it, deliberately exercising the
 * production reset path rather than the test harness's own belt-and-suspenders reset.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { selectPart as modelSelectPart, notify, newStateMachine } from '../../core/model';
import { selectedNodeCount, selectAllNodes, startBonePlacement } from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, click, fullDblClick, clientPointOnPart,
  count, enterNodeMode,
} from './harness';

interface RigStudioHook {
  loadProjectText: (text: string) => boolean;
  serializeDoc: (doc: NonNullable<typeof state.doc>) => string;
}
interface SmPanelHook {
  isPreviewActive: () => boolean;
  startPreviewByMachineId: (id: string) => void;
}
function hook(): RigStudioHook {
  return (window as unknown as { __rigStudio: RigStudioHook }).__rigStudio;
}
function smHook(): SmPanelHook {
  return (window as unknown as { __smPanel: SmPanelHook }).__smPanel;
}

/** Serialize the CURRENT doc so "replace" is a real doc swap, not a no-op reload. */
function currentProjectText(): string {
  return hook().serializeDoc(state.doc!);
}

beforeAll(bootRig);
beforeEach(resetRig);

describe('doc replace resets session-only editing state (hardening wave, class 3)', () => {
  it('node mode, selected path/part, and node selection do not survive a replace', () => {
    const pathId = partByLabel('left_leg').paths.find((p) => p.nodeTypes === 'cssssscc')!.id;
    enterNodeMode('left_leg', pathId);
    selectAllNodes();
    expect(state.mode).toBe('nodes');
    expect(state.selectedPathId).toBe(pathId);
    expect(state.selectedPartId).toBe(partByLabel('left_leg').id);
    expect(selectedNodeCount()).toBeGreaterThan(0);

    hook().loadProjectText(currentProjectText());

    expect(state.mode).toBe('rig');
    expect(state.selectedPathId).toBeNull();
    expect(state.selectedPartId).toBeNull();
    expect(selectedNodeCount()).toBe(0);
  });

  it('freeze mode does not survive a replace', () => {
    state.freezeMode = true;
    hook().loadProjectText(currentProjectText());
    expect(state.freezeMode).toBe(false);
  });

  it('clean preview does not survive a replace (AI Animate System v2 A0)', () => {
    // cleanPreview has no explicit reset call in main.ts's afterDocReplaced (see the
    // field's doc comment on AppState) — render.ts's renderPose() detects the replace
    // itself via the history stacks resetHistory() just emptied. Set it directly (no
    // canvas-tools button needed — Animate mode isn't even required for this check)
    // exactly like the freeze-mode case above.
    state.cleanPreview = true;
    hook().loadProjectText(currentProjectText());
    expect(state.cleanPreview).toBe(false);
  });

  it('an entered group (drill-down dimming) does not survive a replace', () => {
    // Build + dive into a group (mirrors selection-focus.test.ts scenario 9).
    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    groupAction();
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y); // dives in without selecting

    expect(count('.dimmed')).toBeGreaterThan(0); // other top-level parts fade while entered

    hook().loadProjectText(currentProjectText());

    expect(count('.dimmed')).toBe(0); // a fresh load never auto-enters anything
  });

  it('an armed bone placement is cancelled by a replace — a plain click selects, no stray bone appears', () => {
    modelSelectPart(null);
    notify();
    startBonePlacement();
    const before = state.doc!.parts.filter((pt) => pt.kind === 'bone').length;

    hook().loadProjectText(currentProjectText());

    const p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(partByLabel('right_arm').id); // ordinary selection click
    const after = state.doc!.parts.filter((pt) => pt.kind === 'bone').length;
    expect(after).toBe(before); // the armed placement never completed a bone drop
  });

  it('a running SM preview is stopped by a replace, restoring normal canvas clicks', () => {
    state.doc!.stateMachines = [newStateMachine('resilience_test_sm')];
    notify();
    const sm = state.doc!.stateMachines[0];
    smHook().startPreviewByMachineId(sm.id);
    expect(smHook().isPreviewActive(), 'preview armed').toBe(true);

    hook().loadProjectText(currentProjectText());

    expect(smHook().isPreviewActive(), 'preview stopped by the replace').toBe(false);
    // The strongest possible regression check: preview's capture-phase #canvas
    // listeners, left installed, swallow every click before selection ever sees it.
    const p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(partByLabel('right_arm').id);
  });
});
