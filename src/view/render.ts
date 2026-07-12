/**
 * Pose rendering: apply the sampled pose to every part group each frame, plus the
 * onion-skin ghost layers and the state-machine preview hook.
 *
 * renderPose() is the single repaint entry point — it sets the root transform, poses
 * (or skin-deforms) each part group, toggles drill-down dimming, then redraws the
 * onion ghosts and the overlay. `setPoseSampler` swaps channel sampling to the running
 * SMInstance (smPanel's only hook) and repaints.
 */

import {
  state, activeClip, Channel, RigDoc, RigPart, drawOrder, isEffectivelyHidden,
} from '../core/model';
import { ctx, SVG_NS } from './context';
import { poseTime, rootPoseTransform, groupTransformOf, effectiveZ, effectiveOpacity } from './pose';
import { focusContext, nodeEditSkinSuspendId } from './focus';
import { renderSkinnedPart } from './skinRender';
import { renderOverlay } from './overlay';

/**
 * Part ids currently rendering broken (skin deformation threw, or produced non-finite
 * output) that have already been warned about — suppresses per-FRAME console spam while
 * a part stays broken (renderPose runs every frame during playback/dragging). Cleared
 * per part the moment it renders cleanly again, so a re-break re-warns; cleared
 * wholesale by resetSkinRenderWarnings() on a document swap (main.ts's
 * afterDocReplaced) so a freshly loaded doc's parts always get their own first warning
 * rather than silently inheriting suppression from a same-id part in a prior session.
 */
const warnedSkinParts = new Set<string>();

/** Doc-replace hook: see the module comment above warnedSkinParts. */
export function resetSkinRenderWarnings(): void {
  warnedSkinParts.clear();
}

function warnSkinFailure(part: RigPart, err?: unknown): void {
  const msg = `[rig-studio] skin deformation failed for part "${part.label}" (${part.id}) — rendering rigid rest geometry as a fallback.`;
  if (err !== undefined) console.warn(msg, err);
  else console.warn(msg);
}

/**
 * Render a part with its own transform and REST path data — no skin deformation. Used
 * both for the node-editing suspend case (handles must sit on the geometry node ops
 * actually edit) and as the render-resilience fallback when renderSkinnedPart fails
 * (exception or non-finite output): never mutates `path.d`, DOM `d` attribute only.
 */
function renderPartRigid(part: RigPart, g: SVGGElement, t: number | null): void {
  // A SKINNED part's rest geometry is ROOT-space (bind baked its full chain into path.d),
  // so it renders with an identity transform exactly like the deformed path — its live
  // parent chain (a preserved group, since bind no longer hoists the art out) must NOT be
  // re-applied here or the art double-transforms. For FLAT skinned art the chain is already
  // identity, so this is byte-identical to the old groupTransformOf. Non-skinned parts keep
  // their full composed transform.
  g.setAttribute('transform', part.skin ? '' : groupTransformOf(part, t));
  for (const p of part.paths) {
    g.querySelector(`[data-path-id="${p.id}"]`)?.setAttribute('d', p.d);
  }
}

/**
 * Set/remove the `opacity` presentation attribute on a part's own group from its
 * effective (rest-or-keyed) opacity, clamped to 0..1 — but only TOUCH the DOM when the
 * value actually changed, since this runs every part every frame during playback. Full
 * opacity (>=1, the overwhelming common case) REMOVES the attribute instead of writing
 * "1" so a doc that never uses this channel stays byte-identical in the DOM to before it
 * existed. Composes with `.dimmed`'s CSS opacity by ordinary cascade precedence (a
 * stylesheet class rule beats a presentation attribute) — dimming still wins outright
 * while a part is drilled-into-away-from, no extra multiplication logic needed here.
 */
function applyOpacity(part: RigPart, g: SVGGElement, t: number | null): void {
  const val = Math.min(1, Math.max(0, effectiveOpacity(part, t)));
  const cur = g.getAttribute('opacity');
  if (val >= 1) {
    if (cur !== null) g.removeAttribute('opacity');
  } else if (cur === null || Number(cur) !== val) {
    g.setAttribute('opacity', String(val));
  }
}

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
      // Skinned parts deform by their bones, not by a group transform. RENDER
      // RESILIENCE: one part's poisoned/malformed skin data (dangling bone, NaN bind
      // matrix, a live mutation that bypassed normalizeDoc's healing) must never abort
      // the whole renderPose — that reads as "the entire canvas is dead" to the user.
      // renderSkinnedPart never throws on bad NUMBERS by design (returns false instead);
      // the try/catch below is the net for a genuinely STRUCTURAL failure (e.g.
      // malformed path `d`). Either way, fall back to this one part's rigid rest render
      // and warn exactly once while it stays broken.
      g.setAttribute('transform', '');
      let ok = false;
      let err: unknown;
      try {
        ok = renderSkinnedPart(part, g, t);
      } catch (e) {
        err = e;
      }
      if (!ok) {
        if (!warnedSkinParts.has(part.id)) {
          warnSkinFailure(part, err);
          warnedSkinParts.add(part.id);
        }
        renderPartRigid(part, g, t);
      } else {
        warnedSkinParts.delete(part.id);
      }
    } else if (part.skin) {
      // Node-editing target (suspended): render the RIGID bind/rest geometry — the same
      // data node ops actually edit — so handles sit exactly on the drawn outline
      // instead of a stale deformed pose. Bind zeroed this part's own pose, so the rigid
      // transform is the identity `groupTransformOf` would compute anyway.
      renderPartRigid(part, g, t);
    } else {
      g.setAttribute('transform', groupTransformOf(part, t));
    }
    applyOpacity(part, g, t);
    // Layers eye (editor-only, never keyable — see RigPart.hidden's doc comment):
    // visibility:hidden rather than display:none so getBBox() (align/distribute,
    // selection boxes, snapping candidates, node-editing suspend hints — several call
    // sites outside this module) keeps working on a hidden-but-still-selected part
    // instead of throwing; it's equally dead to elementFromPoint/hit-testing. Computed
    // per part (not inherited) because the canvas is a FLAT list of part groups, not a
    // nested DOM tree, so a hidden ancestor's state can't cascade through CSS alone.
    g.classList.toggle('part-hidden', isEffectivelyHidden(part));
  }
  applyDrawOrder(doc, t);
  renderOnion();
  renderOverlay();
}

// ---- Keyframeable z-order (paint order) ----
//
// doc.parts array order is the AUTHORED (rest) stacking; on top of it every part carries a
// keyable `z` OFFSET (stepped, absolute, rest 0 — see model.ts's Channel doc). The rendered
// paint order sorts parts by (effective z ascending, doc.parts index ascending), so an
// unkeyed doc paints in pure doc.parts order exactly as before, and a keyed z lifts a part
// forward/back relative to that. This is EDITOR-side only; the .riv exporter maps animated
// draw order separately (phase 2), and Lottie can't animate layer order at all.

/**
 * Reconcile the canvas part-group paint order with the current effective z-order, moving
 * groups only when it actually changed. rootGroup's children ARE the part groups (onion +
 * overlay are separate sibling groups), so the live child order is read back cheaply and
 * compared to the desired order — self-correcting across buildCanvas rebuilds and
 * reorderCanvas (no external cache to invalidate). appendChild MOVES existing nodes, so a
 * reorder is a handful of DOM moves, never a rebuild; an unchanged order does zero DOM work,
 * which matters because this runs every frame during playback.
 */
function applyDrawOrder(doc: RigDoc, t: number | null): void {
  const root = ctx.rootGroup;
  if (!root) return;
  const desired = drawOrder(doc.parts, (part) => effectiveZ(part, t))
    .map((part) => part.id)
    .filter((id) => ctx.partGroups.has(id));
  const current: string[] = [];
  for (const child of Array.from(root.children)) {
    const id = (child as SVGElement).dataset?.partId;
    if (id) current.push(id);
  }
  if (sameOrder(desired, current)) return;
  for (const id of desired) root.appendChild(ctx.partGroups.get(id)!);
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
      if (isEffectivelyHidden(part)) continue; // a hidden part has no ghost either
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', groupTransformOf(part, ghostTime));
      // Each ghost is built FRESH (never cloned from the live part group), so sampling
      // opacity at ghostTime and setting it once here is a SINGLE application, composed
      // multiplicatively with the ghost layer's own fixed 0.16 CSS opacity above — not a
      // double-application of the live/current-time value. A part fading out reads as a
      // fainter ghost at the time it's more transparent, which is the correct look.
      const op = Math.min(1, Math.max(0, effectiveOpacity(part, ghostTime)));
      if (op < 1) g.setAttribute('opacity', String(op));
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
