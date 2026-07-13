/**
 * The two "nothing else claimed this" pipelines, at opposite ends of the priority table:
 * PAN (row 4) claims a middle-click regardless of what's under the cursor — it runs
 * BEFORE the handle/node/pivot/artwork rows below (their DOM checks don't gate on
 * button, so this must intercept a middle-click before any of them could misfire), while
 * BLANK (last row) is the universal fallback when nothing above matched at all.
 */

import { notify } from '../../../core/model';
import { ctx, DragState } from '../../context';
import { applyViewRect } from '../../camera';
import { renderPose } from '../../render';
import { stepOutFocus } from '../../focus';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const PAN_PIPELINE: GesturePipeline = {
  name: 'pan',
  claim(_hit, ev) {
    if (ev.button !== 1) return null;
    ev.preventDefault(); // no middle-click autoscroll
    const d: DragState = {
      kind: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, startRect: { ...ctx.viewRect! },
    };
    ctx.svg!.style.cursor = 'grabbing';
    capturePointer(ev);
    return d;
  },
  move(ev, d) {
    if (d.kind !== 'pan') return;
    if (!ctx.svg || !ctx.viewRect) return;
    const ctm = ctx.svg.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    ctx.viewRect.x = d.startRect.x - (ev.clientX - d.startClient.x) / scale;
    ctx.viewRect.y = d.startRect.y - (ev.clientY - d.startClient.y) / scale;
    applyViewRect();
  },
  release(_ev, d) {
    if (d.kind !== 'pan') return;
    ctx.svg!.style.cursor = '';
  },
};

export const BLANK_PIPELINE: GesturePipeline = {
  name: 'blank',
  claim() {
    // Blank canvas (incl. a click-through fall from dimmed artwork): step out ONE
    // drill-down level — leave an entered path → deselect → pop the innermost entered
    // group — Inkscape parity. renderPose (not just renderOverlay) because popping a
    // group changes the drill-down dimming, and no drag follows a blank click to
    // otherwise repaint it.
    stepOutFocus();
    notify();
    renderPose();
    return 'handled';
  },
};
