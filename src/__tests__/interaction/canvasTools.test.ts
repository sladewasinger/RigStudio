/**
 * Interaction test for the canvas-tools bar layout (v2.13 follow-up): long hint text
 * (the IK tool's, especially) must never push tool buttons out of the visible bar — the
 * hint gets its own slim, ellipsis-overflowing row instead (`panels/canvasTools.ts`,
 * `style.css`'s `.ct-controls` / `.ct-hint`).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { state, notify } from '../../core/model';
import { bootRig, resetRig, selectByLabel } from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

describe('scenario CT1 — canvas-tools buttons never get pushed out by the hint', () => {
  it('every tool-switch/action button stays fully inside the bar with the IK hint active', () => {
    selectByLabel('right_arm');
    state.tool = 'ik'; // the longest hint in the bar
    notify(); // rebuilds every panel, including canvas-tools (main.ts's subscribe)

    const bar = document.getElementById('canvas-tools')!;
    const barRect = bar.getBoundingClientRect();
    const buttons = Array.from(bar.querySelectorAll('.ct-controls button'));
    expect(buttons.length, 'the controls row actually has buttons to check').toBeGreaterThan(3);
    for (const b of buttons) {
      const r = (b as HTMLElement).getBoundingClientRect();
      expect(r.width, `${b.textContent || b.className} has nonzero width (not collapsed to 0)`)
        .toBeGreaterThan(0);
      expect(r.left, `${b.textContent || b.className} left edge inside the bar`)
        .toBeGreaterThanOrEqual(barRect.left - 0.5);
      expect(r.right, `${b.textContent || b.className} right edge inside the bar`)
        .toBeLessThanOrEqual(barRect.right + 0.5);
    }

    // The hint lives on its OWN row below the controls, with the concise IK text.
    const hint = bar.querySelector('.ct-hint')!;
    expect(hint.textContent).toContain('IK');
    const hintRect = hint.getBoundingClientRect();
    const controlsRect = bar.querySelector('.ct-controls')!.getBoundingClientRect();
    expect(hintRect.top, 'hint row sits below the controls row, not sharing it')
      .toBeGreaterThanOrEqual(controlsRect.bottom - 0.5);
  });

  it('switching away from IK restores the mode-appropriate hint on the same slim row', () => {
    state.tool = 'select';
    notify();
    const hint = document.querySelector('#canvas-tools .ct-hint')!;
    expect(hint.textContent).not.toContain('IK:');
  });
});
