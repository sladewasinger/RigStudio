/**
 * Direct-manipulation wiring for the editing canvas — public entry point of the
 * `view/interactions/` package (deleting the old `interactions.ts` file lets this
 * `index.ts` resolve for the existing `./interactions` import specifier, so canvas.ts
 * needs zero edits).
 *
 * `wireInteractions` installs the wheel-zoom, the drill-down dblclick (`dblclick.ts`),
 * and the pointerdown/move/up router: pointerdown resolves the press ONCE into a shared
 * `HitContext` (`hit.ts`) and walks the STATIC priority table (`priority.ts`,
 * `GESTURE_PIPELINES`) until a pipeline's `claim()` returns non-null; the router then
 * routes pointermove/pointerup/pointercancel to that CLAIMANT only, applying the shared
 * gesture mechanics (`lifecycle.ts`) uniformly around it: the drag-threshold +
 * checkpoint-once-per-gesture deferral and the freeze bind-refresh bracket before each
 * move, the handle-toggle-on-click and freeze weight-refresh after release.
 */

import { notify } from '../../core/model';
import { ctx } from '../context';
import { svgPoint } from '../coords';
import { zoomAround } from '../camera';
import { renderPose } from '../render';
import { resolveHit } from './hit';
import { wireDblClick } from './dblclick';
import { GESTURE_PIPELINES, GesturePipeline } from './priority';
import {
  activateDrag, captureFreezeBaselineIfNeeded, refreshFreezeWeightsAfterDrag,
  applyToggleOnClick,
} from './lifecycle';
import { updateBoneChainPreview } from './pipelines/boneChain';

export function wireInteractions(): void {
  if (!ctx.svg) return;

  // Middle-drag pan + wheel zoom (navigation, not editing — no checkpoints).
  ctx.svg.addEventListener('wheel', (ev) => {
    if (!ctx.viewRect || !ctx.svg) return;
    ev.preventDefault();
    const m = ctx.svg.getScreenCTM();
    if (!m) return;
    const p = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomAround(p.x, p.y, factor);
  }, { passive: false });

  // Double-click steps INTO things, SVG-editor style — a separate listener from the
  // pointerdown cascade (a double-click is two full clicks, each already resolved by
  // the pipeline table below, plus this dblclick event on top).
  wireDblClick(ctx.svg);

  let activeClaimant: GesturePipeline | null = null;

  ctx.svg.addEventListener('pointerdown', (ev) => {
    const hit = resolveHit(ev);
    if (!hit) return;
    for (const pipeline of GESTURE_PIPELINES) {
      const result = pipeline.claim(hit, ev);
      if (result === null) continue;
      // 'handled': the press was consumed. Some claims (IK) set ctx.drag themselves via
      // a side-effecting call (ikDrag.ts's startIkDrag) rather than returning it — track
      // this pipeline as the claimant regardless, so a drag it started still routes here.
      activeClaimant = pipeline;
      if (result !== 'handled') ctx.drag = result;
      return;
    }
  });

  ctx.svg.addEventListener('pointermove', (ev) => {
    // Pen-tool chain: no drag is in flight (a click isn't a drag), so update the live
    // preview segment from the pending origin to the cursor. A middle-drag pan sets
    // ctx.drag, so this is skipped during a pan (panning stays available while chaining).
    if (ctx.boneChain && !ctx.drag) {
      updateBoneChainPreview(ev);
      return;
    }
    if (!ctx.drag || !activeClaimant) return;

    // Pan and the node marquee are navigation/selection chrome, not pose/geometry edits:
    // neither goes through the checkpoint-deferral threshold or the freeze baseline.
    if (ctx.drag.kind === 'pan' || ctx.drag.kind === 'nodeMarquee') {
      activeClaimant.move?.(ev, ctx.drag);
      return;
    }

    const wasActive = 'active' in ctx.drag ? ctx.drag.active : true;
    if (!activateDrag(ctx.drag, ev)) return;
    captureFreezeBaselineIfNeeded(wasActive, ctx.drag);
    activeClaimant.move?.(ev, ctx.drag);
  });

  // Shared gesture-end tail — identical for every drag kind regardless of which
  // pipeline claimed it (mirrors the old file's single `end()`): the claimant's own
  // release() runs first for anything genuinely kind-specific (pan's cursor reset,
  // the node marquee's selection finalize), then the two generic, DragState-keyed
  // post-drag hooks (toggle-on-click, freeze weight refresh), then the universal
  // cleanup + repaint.
  const end = (ev: PointerEvent) => {
    if (!ctx.drag) return;
    activeClaimant?.release?.(ev, ctx.drag);
    applyToggleOnClick(ctx.drag);
    refreshFreezeWeightsAfterDrag(ctx.drag);
    ctx.drag = null;
    ctx.snapMarker = null; // drop any snap marker before the final repaint
    activeClaimant = null;
    notify();
    renderPose(); // clears gizmos + snap marker
  };
  ctx.svg.addEventListener('pointerup', end);
  ctx.svg.addEventListener('pointercancel', end);
}
