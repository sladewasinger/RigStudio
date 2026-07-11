/**
 * Pose rendering: apply the sampled pose to every part group each frame, plus the
 * onion-skin ghost layers and the state-machine preview hook.
 *
 * renderPose() is the single repaint entry point — it sets the root transform, poses
 * (or skin-deforms) each part group, toggles drill-down dimming, then redraws the
 * onion ghosts and the overlay. `setPoseSampler` swaps channel sampling to the running
 * SMInstance (smPanel's only hook) and repaints.
 */

import { state, activeClip, Channel } from '../core/model';
import { ctx, SVG_NS } from './context';
import { poseTime, rootPoseTransform, groupTransformOf } from './pose';
import { focusContext } from './focus';
import { renderSkinnedPart } from './skinRender';
import { renderOverlay } from './overlay';

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return;
  const t = poseTime();

  ctx.rootGroup.setAttribute('transform', rootPoseTransform(t));
  const focus = focusContext();
  for (const part of doc.parts) {
    const g = ctx.partGroups.get(part.id);
    if (!g) continue;
    // Drill-down focus: parts outside the editing context fade and stop catching
    // pointer events (clicks fall through; node marquees sweep right over them).
    g.classList.toggle('dimmed', !!focus && !focus.has(part.id));
    if (part.skin) {
      // Skinned parts deform by their bones, not by a group transform.
      g.setAttribute('transform', '');
      renderSkinnedPart(part, g, t);
    } else {
      g.setAttribute('transform', groupTransformOf(part, t));
    }
  }
  renderOnion();
  renderOverlay();
}

// ---- Onion skinning ----

/** Ghost silhouettes of the previous/next keyed poses while animating. */
function renderOnion(): void {
  if (!ctx.onionGroup) return;
  ctx.onionGroup.innerHTML = '';
  const doc = state.doc;
  if (!doc || !state.onionSkin || state.editorMode !== 'animate') return;
  const clip = activeClip();
  if (!clip) return;

  const times = [...new Set(clip.tracks.flatMap((tr) => tr.keyframes.map((k) => k.time)))]
    .sort((a, b) => a - b);
  const t = state.currentTime;
  const prev = times.filter((k) => k < t - 1).pop();
  const next = times.find((k) => k > t + 1);

  for (const [ghostTime, cls] of [
    [prev, 'onion-prev'],
    [next, 'onion-next'],
  ] as const) {
    if (ghostTime === undefined) continue;
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', `onion-ghost ${cls}`);
    layer.setAttribute('transform', rootPoseTransform(ghostTime));
    for (const part of doc.parts) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', groupTransformOf(part, ghostTime));
      for (const p of part.paths) {
        const el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', p.d);
        if (p.transform) el.setAttribute('transform', p.transform);
        g.appendChild(el);
      }
      layer.appendChild(g);
    }
    ctx.onionGroup.appendChild(layer);
  }
}

/** Route renderPose's channel sampling through fn (state-machine preview), or null to restore. */
export function setPoseSampler(fn: ((target: string, channel: Channel) => number) | null): void {
  ctx.poseSampler = fn;
  renderPose();
}
