/**
 * Pose rendering: apply the sampled pose to every part group each frame, plus the
 * onion-skin ghost layers and the state-machine preview hook.
 *
 * renderPose() is the single repaint entry point — it sets the root transform, poses
 * (or skin-deforms) each part group, toggles drill-down dimming, then redraws the
 * onion ghosts and the overlay. `setPoseSampler` swaps channel sampling to the running
 * SMInstance (smPanel's only hook) and repaints.
 */

import { state, activeClip, Channel, RigDoc } from '../core/model';
import { ctx, SVG_NS } from './context';
import { poseTime, rootPoseTransform, groupTransformOf } from './pose';
import { focusContext, nodeEditSkinSuspendId } from './focus';
import { renderSkinnedPart } from './skinRender';
import { renderOverlay } from './overlay';

/** Applies the sampled pose at the current time to every part group. */
export function renderPose(): void {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return;
  const t = poseTime();

  updateArtboardRect(doc);
  // Freeze (origin-editing) mode: toggle the class that drives the canvas banner + tint
  // and the pivot/joint-handle cursor affordances (style.css). The #canvas container is
  // the svg's parent (buildCanvas appends it there).
  ctx.svg?.parentElement?.classList.toggle('freeze-mode', state.freezeMode);
  ctx.rootGroup.setAttribute('transform', rootPoseTransform(t));
  const focus = focusContext();
  const suspendSkinId = nodeEditSkinSuspendId();
  for (const part of doc.parts) {
    const g = ctx.partGroups.get(part.id);
    if (!g) continue;
    // Drill-down focus: parts outside the editing context fade and stop catching
    // pointer events (clicks fall through; node marquees sweep right over them).
    g.classList.toggle('dimmed', !!focus && !focus.has(part.id));
    if (part.skin && part.id !== suspendSkinId) {
      // Skinned parts deform by their bones, not by a group transform.
      g.setAttribute('transform', '');
      renderSkinnedPart(part, g, t);
    } else if (part.skin) {
      // Node-editing target (suspended): render the RIGID bind/rest geometry — the same
      // data node ops actually edit — so handles sit exactly on the drawn outline
      // instead of a stale deformed pose (never mutates path.d; DOM `d` only, same rule
      // as the deformed path). Bind zeroed this part's own pose, so the rigid transform
      // is the identity `groupTransformOf` would compute anyway.
      g.setAttribute('transform', groupTransformOf(part, t));
      for (const p of part.paths) {
        g.querySelector(`[data-path-id="${p.id}"]`)?.setAttribute('d', p.d);
      }
    } else {
      g.setAttribute('transform', groupTransformOf(part, t));
    }
  }
  renderOnion();
  renderOverlay();
}

// ---- Artboard (page) rect ----

/**
 * Keep the artboard backdrop rect's geometry/visibility in sync with doc.artboard.
 * The element itself (styling, pointer-events:none) is created once by buildCanvas;
 * this only touches x/y/width/height/display, cheaply, every render.
 */
function updateArtboardRect(doc: RigDoc): void {
  const rect = ctx.svg?.querySelector<SVGRectElement>('#rig-artboard-rect');
  if (!rect) return;
  const ab = doc.artboard;
  if (!ab || !ab.enabled) {
    rect.style.display = 'none';
    return;
  }
  rect.style.display = '';
  rect.setAttribute('x', String(ab.x));
  rect.setAttribute('y', String(ab.y));
  rect.setAttribute('width', String(Math.max(0, ab.w)));
  rect.setAttribute('height', String(Math.max(0, ab.h)));
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
