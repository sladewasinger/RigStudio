/**
 * Interaction tests for the keyboard-shortcut registry (Pattern-driven redesign pass,
 * ROADMAP.md item 1). `pressKey` dispatches a REAL `document` keydown event — the exact
 * listener `ui/shortcuts.ts`'s `installShortcuts()` wires — so these tests exercise the
 * actual dispatcher, not a hand-picked handler function. The audit that motivated this
 * file found only 2 of ~30 bindings were EVER exercised through the real dispatcher
 * (Y/freeze, Escape); this suite covers the bindings named in the redesign brief plus
 * both priority cascades, tier by tier.
 *
 * MUTATION CHECK (performed manually, matching this codebase's existing convention —
 * e.g. freeze.test.ts / gesturePriority.test.ts's header comments — rather than a
 * permanent assertion). First attempt swapped ESCAPE_HANDLERS' tiers 1/2 (freezeMode ↔
 * aiPreview): the full interaction suite stayed 193/193 GREEN — freeze and an active AI
 * preview never co-occur in any covered scenario, so that pair's order isn't actually
 * load-bearing today (a real finding, not a broken check — recorded rather than
 * discarded). Swapping tiers 4/5 instead (boneChain ↔ stepOut — tier 5 is the
 * UNCONDITIONAL fallback, so putting it first means it always wins and boneChain can
 * never run) DID break things: 3 FAILED / 190 passed (of 193) — this file's own "tier 4:
 * boneChain" scenario (Escape no longer commits the chain — the fallback stepOut fires
 * instead, so the expected bone is never created) plus bones.test.ts's B26 ("3 clicks +
 * Escape makes 2 connected bones... auto-bound") and B28 (the placing-ghost/chain-origin
 * marker scenario), both of which also finish a chain via Escape. Restored the original
 * order; suite back to 193/193.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  selectPart as modelSelectPart, notify, newStateMachine, setKeyframeAt,
} from '../../core/model';
import { checkpoint, canUndo, canRedo } from '../../core/history';
import { zoomBy, startBonePlacement, hasSelectedNode, selectAllNodes } from '../../view';
import { hasKeySelection } from '../../timeline/timeline';
import { setLogicVisible } from '../../panels/smPanel';
import { animateWithClaude, AnimateResult } from '../../ai/claude';
import { __setAnimateCallForTest } from '../../panels/ai';
import {
  bootRig, resetRig, state, partByLabel, selectByLabel, setEditorMode, clipTrack,
  medialPoints, click, svgEl, viewBox, expectClose, clientCenterOf, enterNodeMode, waitFor,
} from './harness';

interface SmPanelHook {
  isPreviewActive: () => boolean;
  startPreviewByMachineId: (id: string) => void;
  selectMachine: (id: string | null) => void;
  selectState: (id: string | null) => void;
}
function smHook(): SmPanelHook {
  return (window as unknown as { __smPanel: SmPanelHook }).__smPanel;
}

interface AiPreviewHook {
  isActive: () => boolean;
  discard: () => void;
}
function aiHook(): AiPreviewHook {
  return (window as unknown as { __aiPreview: AiPreviewHook }).__aiPreview;
}

function fabricateResult(): AnimateResult {
  return {
    clip: {
      name: 'ignored',
      clipName: 'shortcuts_ai_test',
      duration: 1000,
      tracks: [{
        target: 'left_arm',
        channel: 'rotate',
        keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 1000, value: 30, easing: 'linear' }],
      }],
    },
    rig: null,
    clampedCount: 0,
  };
}

/** Drives the real AI panel to enter a preview (mirrors aiPreview.test.ts's runCreate),
 *  used only to arrange the Escape cascade's aiPreview tier. */
async function enterAiPreview(): Promise<void> {
  setEditorMode('animate');
  __setAnimateCallForTest(async () => fabricateResult());
  const panel = document.querySelector('.ai-panel')!;
  const apiKeyInput = panel.querySelector('input[type="password"]') as HTMLInputElement;
  apiKeyInput.value = 'sk-test-key';
  apiKeyInput.dispatchEvent(new Event('change', { bubbles: true }));
  const snapshotCb = panel.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
  if (snapshotCb.checked) {
    snapshotCb.checked = false;
    snapshotCb.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const textarea = panel.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'wave the arm';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  const createBtn = Array.from(panel.querySelectorAll('button'))
    .find((b) => b.textContent === 'Create new animation') as HTMLButtonElement;
  createBtn.click();
  await waitFor(() => aiHook().isActive(), { message: 'AI preview entered' });
}

/** Direct pointerdown+up dispatch ON a timeline keyframe diamond (not through the
 *  canvas-routed `click()` helper, which targets the svg for pointerup — the diamond
 *  has its own listeners). Selection happens synchronously on pointerdown. */
function clickKeyDiamond(el: Element): void {
  const c = clientCenterOf(el);
  const opts = {
    bubbles: true, cancelable: true, clientX: c.x, clientY: c.y,
    button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
}

beforeAll(bootRig);
beforeEach(resetRig);

// ---- Flat bindings ----

describe('undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y)', () => {
  it('drives the real undo/redo stack through the dispatcher', () => {
    const partId = partByLabel('left_arm').id;
    checkpoint();
    state.doc!.parts.find((p) => p.id === partId)!.rest.tx = 42;
    notify();
    expect(canUndo()).toBe(true);

    pressKeyEv('z', { ctrlKey: true });
    expect(state.doc!.parts.find((p) => p.id === partId)!.rest.tx).not.toBe(42);
    expect(canRedo()).toBe(true);

    pressKeyEv('z', { ctrlKey: true, shiftKey: true }); // Ctrl+Shift+Z redo
    expect(state.doc!.parts.find((p) => p.id === partId)!.rest.tx).toBe(42);

    pressKeyEv('z', { ctrlKey: true }); // undo again
    expect(state.doc!.parts.find((p) => p.id === partId)!.rest.tx).not.toBe(42);
    pressKeyEv('y', { ctrlKey: true }); // Ctrl+Y redo (the alternate binding)
    expect(state.doc!.parts.find((p) => p.id === partId)!.rest.tx).toBe(42);
  });
});

describe('tool keys V/T/R/I', () => {
  it('each sets state.tool through the dispatcher', () => {
    pressKeyEv('t');
    expect(state.tool).toBe('translate');
    pressKeyEv('r');
    expect(state.tool).toBe('rotate');
    pressKeyEv('i');
    expect(state.tool).toBe('ik');
    pressKeyEv('v');
    expect(state.tool).toBe('select');
  });
});

describe('the NEW B key (bone tool)', () => {
  it('Setup mode: arms placement (cursor + ctx state) and a real 2-click chain commits a bone', () => {
    modelSelectPart(null);
    notify();
    const pts = medialPoints('left_arm', 1);
    const before = state.doc!.parts.length;

    pressKeyEv('b');
    expect(svgEl().style.cursor, 'B arms the pen tool (crosshair cursor)').toBe('crosshair');

    click(pts[0].x, pts[0].y); // origin
    click(pts[1].x, pts[1].y); // commits bone 1
    pressKeyEv('Escape'); // finishes the chain (same as canvas-tools flow)

    expect(state.doc!.parts.length, 'exactly one bone committed').toBe(before + 1);
    const newPart = state.doc!.parts[state.doc!.parts.length - 1];
    expect(newPart.kind).toBe('bone');
  });

  it('Animate mode: does NOT arm placement (Setup-gated, unlike V/T/R/I)', () => {
    setEditorMode('animate');
    const cursorBefore = svgEl().style.cursor;
    const before = state.doc!.parts.length;
    pressKeyEv('b');
    expect(svgEl().style.cursor).toBe(cursorBefore);
    expect(state.doc!.parts.length).toBe(before);
  });
});

describe('Tab mode toggle', () => {
  it('flips state.editorMode both ways', () => {
    expect(state.editorMode).toBe('setup');
    pressKeyEv('Tab');
    expect(state.editorMode).toBe('animate');
    pressKeyEv('Tab');
    expect(state.editorMode).toBe('setup');
  });
});

describe('F fit-view', () => {
  it('changes the viewBox back to the fit rect after zooming away from it', () => {
    const fit = viewBox();
    zoomBy(3);
    const zoomed = viewBox();
    expect(zoomed.w).toBeLessThan(fit.w * 0.9);
    pressKeyEv('f');
    const restored = viewBox();
    expectClose(restored.w, fit.w, 0.5, 'F restores the fit width');
    expectClose(restored.h, fit.h, 0.5, 'F restores the fit height');
  });
});

describe('+/- zoom', () => {
  it('zooms in/out by exactly 1.25x, symmetric', () => {
    const before = viewBox();
    pressKeyEv('=');
    const zoomedIn = viewBox();
    expectClose(zoomedIn.w, before.w / 1.25, 0.01, 'Zoom-in ratio');
    pressKeyEv('-');
    const back = viewBox();
    expectClose(back.w, before.w, 0.01, 'Zoom-out restores exactly');
  });
});

describe('Space play toggle', () => {
  it('toggles state.playing in Animate mode', () => {
    setEditorMode('animate');
    expect(state.playing).toBe(false);
    pressKeyEv(' ');
    expect(state.playing).toBe(true);
    pressKeyEv(' ');
    expect(state.playing).toBe(false);
  });
});

describe('Ctrl+A select-all', () => {
  it('selects every part in Setup pose mode', () => {
    modelSelectPart(null);
    notify();
    pressKeyEv('a', { ctrlKey: true });
    expect(state.selectedPartIds.length).toBeGreaterThan(1);
  });
});

describe('PageUp / PageDown draw-order step', () => {
  it('moves the selected part exactly one slot each way', () => {
    const doc = state.doc!;
    const idx = Math.floor(doc.parts.length / 2);
    const part = doc.parts[idx];
    modelSelectPart(part.id);
    state.selectedPathId = null;
    notify();

    pressKeyEv('PageUp');
    expect(state.doc!.parts[idx + 1]?.id).toBe(part.id);

    pressKeyEv('PageDown');
    expect(state.doc!.parts[idx]?.id).toBe(part.id);

    pressKeyEv('PageDown');
    expect(state.doc!.parts[idx - 1]?.id).toBe(part.id);
  });
});

describe('% snapping toggle', () => {
  it('flips state.snapEnabled', () => {
    expect(state.snapEnabled).toBe(false); // resetRig sets it false
    pressKeyEv('%');
    expect(state.snapEnabled).toBe(true);
    pressKeyEv('%');
    expect(state.snapEnabled).toBe(false);
  });
});

describe('Shift+H / Shift+V flips (Setup only)', () => {
  it('negate rest.sx / rest.sy', () => {
    selectByLabel('left_arm');
    const before = state.doc!.parts.find((p) => p.label === 'left_arm')!.rest;
    const sx0 = before.sx;
    pressKeyEv('h', { shiftKey: true });
    expect(state.doc!.parts.find((p) => p.label === 'left_arm')!.rest.sx).toBe(-sx0);

    const sy0 = state.doc!.parts.find((p) => p.label === 'left_arm')!.rest.sy;
    pressKeyEv('v', { shiftKey: true });
    expect(state.doc!.parts.find((p) => p.label === 'left_arm')!.rest.sy).toBe(-sy0);
  });
});

describe('C clean-preview toggle (Animate only)', () => {
  it('flips state.cleanPreview', () => {
    setEditorMode('animate');
    expect(state.cleanPreview).toBe(false);
    pressKeyEv('c');
    expect(state.cleanPreview).toBe(true);
    pressKeyEv('c');
    expect(state.cleanPreview).toBe(false);
  });
});

describe('?/F1 help overlay', () => {
  it('both open it; Escape (help-open guard tier) closes it', () => {
    expect(document.getElementById('help-overlay')).toBeNull();
    pressKeyEv('?');
    expect(document.getElementById('help-overlay')).not.toBeNull();
    pressKeyEv('?'); // toggles closed
    expect(document.getElementById('help-overlay')).toBeNull();

    pressKeyEv('F1');
    expect(document.getElementById('help-overlay')).not.toBeNull();
    pressKeyEv('Escape');
    expect(document.getElementById('help-overlay')).toBeNull();
  });
});

// ---- DELETE_HANDLERS cascade, tier by tier ----

describe('Delete cascade', () => {
  afterEach(() => setLogicVisible(false));

  it('tier 1 (stateMachine): deletes the selected SM state before anything else applies', () => {
    setEditorMode('animate');
    const sm = newStateMachine('shortcuts_delete_sm');
    const animState = {
      id: 'shortcuts_test_anim_state', name: 'anim', kind: 'animation' as const,
      clipName: state.doc!.clips[0].name,
    };
    sm.states.push(animState);
    state.doc!.stateMachines = [sm];
    notify();
    setLogicVisible(true);
    smHook().selectMachine(sm.id);
    smHook().selectState(animState.id);

    pressKeyEv('Delete');

    const reloaded = state.doc!.stateMachines!.find((m) => m.id === sm.id)!;
    expect(reloaded.states.find((s) => s.id === animState.id)).toBeUndefined();
  });

  it('tier 2 (animateKeys): deletes the selected keyframe in Animate mode', () => {
    setEditorMode('animate');
    const partId = partByLabel('left_arm').id;
    setKeyframeAt(partId, 'rotate', 200, 30);
    notify();
    const diamond = document.querySelector('#timeline .tl-key')!;
    clickKeyDiamond(diamond);
    expect(hasKeySelection()).toBe(true);

    pressKeyEv('Delete');

    expect(hasKeySelection()).toBe(false);
    expect(clipTrack(partId, 'rotate')?.keyframes.length ?? 0).toBe(0);
  });

  it('tier 3 (nodes): deletes the selected path node in node-editing mode', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    enterNodeMode('left_leg', path.id);
    expect(hasSelectedNode()).toBe(false);
    selectAllNodes();
    expect(hasSelectedNode()).toBe(true);
    const before = state.doc!.parts.find((p) => p.id === part.id)!.paths.find((p) => p.id === path.id)!.d;

    pressKeyEv('Delete');

    const after = state.doc!.parts.find((p) => p.id === part.id)?.paths.find((p) => p.id === path.id)?.d;
    expect(after).not.toBe(before); // structure changed (nodes removed) — proves tier 3, not a no-op
    expect(hasSelectedNode()).toBe(false);
  });

  it('tier 4 (setupParts): deletes the selected layer(s) in Setup pose mode', () => {
    const before = state.doc!.parts.length;
    selectByLabel('left_arm');
    expect(state.mode).toBe('rig');

    pressKeyEv('Delete');

    expect(state.doc!.parts.length).toBe(before - 1);
    expect(state.doc!.parts.find((p) => p.label === 'left_arm')).toBeUndefined();
  });
});

// ---- ESCAPE_HANDLERS cascade, tier by tier ----

describe('Escape cascade', () => {
  afterEach(() => {
    if (aiHook()?.isActive()) aiHook().discard();
    __setAnimateCallForTest(animateWithClaude);
    setLogicVisible(false);
  });

  it('tier 1 (freezeMode): exits freeze WITHOUT falling through to stepOut', () => {
    selectByLabel('left_arm');
    pressKeyEv('y'); // enter freeze
    expect(state.freezeMode).toBe(true);
    expect(state.selectedPartId).not.toBeNull();

    pressKeyEv('Escape');

    expect(state.freezeMode).toBe(false);
    // If stepOut had ALSO run, the selected part would have been cleared — it wasn't,
    // proving the freezeMode tier alone consumed this press.
    expect(state.selectedPartId).not.toBeNull();
  });

  it('tier 2 (aiPreview): discards an active AI preview', async () => {
    await enterAiPreview();
    expect(aiHook().isActive()).toBe(true);

    pressKeyEv('Escape');

    expect(aiHook().isActive()).toBe(false);
  });

  it('tier 3 (stateMachine): stops a running SM preview', () => {
    setEditorMode('animate');
    const sm = newStateMachine('shortcuts_escape_sm');
    state.doc!.stateMachines = [sm];
    notify();
    smHook().startPreviewByMachineId(sm.id);
    expect(smHook().isPreviewActive()).toBe(true);

    pressKeyEv('Escape');

    expect(smHook().isPreviewActive()).toBe(false);
  });

  it('tier 4 (boneChain): finishes an in-progress chain (commits the bone, resets the cursor)', () => {
    modelSelectPart(null);
    notify();
    const pts = medialPoints('left_arm', 1);
    const before = state.doc!.parts.length;
    startBonePlacement();
    click(pts[0].x, pts[0].y); // origin
    click(pts[1].x, pts[1].y); // commits bone 1, arms the (still in-progress) next segment

    pressKeyEv('Escape'); // finishes the chain — no additional bone, just ends the tool

    expect(svgEl().style.cursor).toBe('');
    expect(state.doc!.parts.length).toBe(before + 1);
  });

  it('tier 5 (stepOut, the fallback): deselects the current part when nothing else is active', () => {
    selectByLabel('left_arm');
    expect(state.selectedPartId).not.toBeNull();

    pressKeyEv('Escape');

    expect(state.selectedPartId).toBeNull();
  });
});

// ---- Local dispatch helper (kept at file end so scenarios read top-to-bottom) ----

function pressKeyEv(
  key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
    ctrlKey: !!mods.ctrlKey, shiftKey: !!mods.shiftKey, altKey: !!mods.altKey, metaKey: !!mods.metaKey,
  }));
}
