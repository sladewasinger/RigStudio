/**
 * Overlay chrome orchestration: renderOverlay() rebuilds #overlay from scratch each
 * call (innerHTML=''), sequencing the chrome families implemented across
 * overlayHandles.ts (selection boxes + scale/rotate/skew handle sets), overlayBones.ts
 * (bone/group glyphs, skeleton ghosts/lines, pen-tool chain preview, freeze joint
 * markers), and overlayNodes.ts (node-editing handles + skin-suspend hint) — plus the
 * transform-tool/drag gizmos, the primary pivot crosshair, and the snap marker, which
 * stay here.
 *
 * renderOverlay() carries two deliberate render-time side effects: it resets the Setup
 * handle cycle to 'scale' when the primary selection changes, and renderNodeHandles
 * (overlayNodes.ts) prunes stale node selections. Overlay strokes use
 * vector-effect: non-scaling-stroke so widths stay screen-constant; radii are in doc
 * units via handleSize().
 */

import { ctx, SVG_NS, round1 } from './context';
import {
  state, selectedPart, chainBonesOfPart, isEffectivelyHidden,
} from '../core/model';
import { applyMat, matrixOfTransform } from '../geometry/transforms';
import { handleSize } from './coords';
import {
  poseTime, effectivePivot, partRootBoxes, fullPoseTransform,
} from './pose';
import { nodeEditSkinSuspendId } from './focus';
import { jointDotHtml } from './glyphs';
import {
  appendNullGlyph, renderPivotGhosts, renderBoneLines, renderBoneChainPreview,
  renderFreezeJointMarkers,
} from './overlayBones';
import { renderSelectionHandles } from './overlayHandles';
import { renderNodeHandles, drawSkinSuspendHint } from './overlayNodes';

// ---- Overlay: selection box, handles, pivots, drag gizmos, node handles ----

export function renderOverlay(): void {
  if (!ctx.overlay || !ctx.svg || !ctx.rootGroup) return;
  ctx.overlay.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  // Clean-preview (Animate-mode "watch the final animation" toggle, AI Animate System
  // v2 A0): every one of this function's remaining lines draws editor-only chrome
  // (selection boxes, handles, pivots, bone/group glyphs+lines, gizmos, snap markers,
  // hints, node handles) — none of it is part of the actual rendered animation, which
  // lives entirely in the doc.parts loop in render.ts, outside #overlay. The innerHTML
  // clear above already ran, so a stale overlay from before the toggle flipped ON
  // can't linger; bail out and draw nothing else. Setup mode is unaffected (the toggle
  // only ever applies in Animate — see canvasTools.ts).
  if (state.cleanPreview && state.editorMode === 'animate') return;

  const setup = state.editorMode === 'setup';

  // Reset the handle cycle when the primary selection changes.
  if (state.selectedPartId !== ctx.handlePartId) {
    ctx.handlePartId = state.selectedPartId;
    ctx.handleMode = 'scale';
  }

  const size = handleSize();
  const t = poseTime();
  const rootTransform = ctx.rootGroup.getAttribute('transform') ?? '';

  if (state.mode === 'nodes' && setup) {
    const part = selectedPart();
    if (part) {
      renderNodeHandles(part);
      // Bones of the edited part's own chain are its binding context, not "everything
      // else" that node editing dims away — draw them (undimmed, still selectable via
      // Layers) exactly like the main loop below does. Also surface the skin-suspend
      // hint (render.ts) so it's clear the art is showing its base shape right now.
      const chainBones = chainBonesOfPart(doc.parts, part);
      let selectedBoneTip: SVGGElement | null = null;
      for (const bone of chainBones) {
        if (isEffectivelyHidden(bone)) continue; // Layers eye
        const tipWrap = appendNullGlyph(bone, t, rootTransform, size, setup);
        if (tipWrap) selectedBoneTip = tipWrap;
      }
      if (selectedBoneTip) ctx.overlay.appendChild(selectedBoneTip);
      // FREEZE FIX (regression): this branch used to skip renderFreezeJointMarkers
      // entirely, so freeze-editing a bone's origin while node-editing its owning part
      // (a real workflow — see the chain-bones comment above) had no marker to claim
      // the press; it fell through to the node-bend/marquee pipeline and warped the
      // mesh instead of moving the joint. Scoped to this part's own chain, matching the
      // glyph loop just above (every other bone in the rig stays non-interactive here).
      if (state.freezeMode) {
        renderFreezeJointMarkers(doc, t, size, rootTransform, chainBones);
      }
      if (nodeEditSkinSuspendId() === part.id) drawSkinSuspendHint(part, size);
    }
    drawSnapMarker();
    return;
  }

  // Everything positioned in root coordinates rides in one passive holder.
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'overlay-passive');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  ctx.overlay.appendChild(holder);

  // Ghost markers (every art part's live joint) + dashed bone lines — the passive
  // skeleton visibility chrome, overlayBones.ts. Bones/groups get interactive glyphs
  // (appendNullGlyph, below) instead of a ghost marker.
  renderPivotGhosts(doc, t, size, holder);
  renderBoneLines(doc, t, size, holder);

  // Highlight the "entered" path, if any — Edit and Animate alike (user ruling
  // 2026-07-13: path selection is navigation, not posing, so it isn't Setup-gated).
  if (state.selectedPathId) {
    const part = selectedPart();
    // Any one of the part's run groups works — they share the same transform (U2).
    const g = part ? ctx.partGroups.get(part.id)?.[0] : null;
    const path = part?.paths.find((p) => p.id === state.selectedPathId);
    if (part && g && path) {
      const hl = document.createElementNS(SVG_NS, 'path');
      hl.setAttribute('d', path.d);
      hl.setAttribute('class', 'path-highlight');
      hl.setAttribute('stroke-dasharray', `${size * 0.8} ${size * 0.6}`);
      const wrap = document.createElementNS(SVG_NS, 'g');
      wrap.setAttribute('class', 'overlay-passive');
      wrap.setAttribute(
        'transform',
        [rootTransform, g.getAttribute('transform') ?? '', path.transform]
          .filter(Boolean)
          .join(' '),
      );
      wrap.appendChild(hl);
      ctx.overlay.appendChild(wrap);
    }
  }

  // Bone/group glyphs: partless parts have no artwork to click, so they get an
  // interactive diamond (bone) or square (group) at their live joint. Carrying
  // data-part-id makes the normal part hit-testing, drags and auto-key work on them.
  // Glyphs render into #overlay, a SEPARATE element from the bone's own (flat, hidden
  // via CSS) part group — so a hidden ancestor's `visibility:hidden` does NOT hide a
  // descendant bone's glyph on its own; skip it explicitly ("a hidden limb's rig
  // shouldn't float").
  let selectedBoneTip: SVGGElement | null = null;
  for (const part of doc.parts) {
    if (part.paths.length > 0) continue;
    if (isEffectivelyHidden(part)) continue;
    const tipWrap = appendNullGlyph(part, t, rootTransform, size, setup);
    if (tipWrap) selectedBoneTip = tipWrap;
  }
  if (selectedBoneTip) ctx.overlay.appendChild(selectedBoneTip);

  // Unified select-tool gizmo (rotate circle + move cross). Drawn BEFORE the per-part
  // boxes/handles so Edit's interactive scale/rotate handles stay on top and clickable.
  renderSelectGizmo(size, t, rootTransform);

  // Dashed transform boxes + Inkscape-style scale/rotate/skew handles for every
  // selected part (art bbox or group union box) — overlayHandles.ts.
  renderSelectionHandles(rootTransform, size, setup);

  // PEN-TOOL BONE CHAIN preview (overlayBones.ts) — committed bones are already drawn
  // by the glyph loop above; only the in-progress segment lives here.
  renderBoneChainPreview(holder, size);

  renderDragGizmo(holder, size);
  renderToolGizmo(size, t, rootTransform);

  // FREEZE FIX (Post-A "origin-drag rotates unselected bones"): outside freeze, only the
  // selected part gets a pivot marker (below) — origin/joint handles on every OTHER bone
  // stay invisible, matching the existing "select first" affordance. In freeze mode EVERY
  // bone's origin gets one too (overlayBones.ts's renderFreezeJointMarkers), each carrying
  // data-part-id so interactions.ts's pivotEl branch can select + start the joint drag in
  // one press without requiring pre-selection. The primary/selected bone still gets its
  // own richer crosshair (below), so it's excluded there to avoid a doubled marker.
  if (setup && state.freezeMode) {
    renderFreezeJointMarkers(doc, t, size, rootTransform);
  }

  // The selected pivot: crosshair + ring, with a generous invisible grab circle.
  // Drawn last (and in its own interactive group) so it stays on top; draggable only in
  // Setup mode — moving a joint is a rig edit, not an animation edit. Layers eye: a
  // hidden part draws NOTHING on canvas, this crosshair included.
  const part = selectedPart();
  if (part && !isEffectivelyHidden(part)) {
    const ep = effectivePivot(part, t);
    const px = ep.x, py = ep.y;
    const cross = document.createElementNS(SVG_NS, 'g');
    // A CHILD bone's origin is the shared joint with its parent's tip — draggable in BOTH
    // modes (not freeze-gated), so it carries the `joint` class to keep its move cursor.
    // UNIFIED SKELETON: an `attachedRoot` bone is never a child joint (its origin is a
    // deliberately LOOSE cross-chain link, not the parent's tip) — mirrors pivot.ts's
    // identical exemption, so the cursor affordance matches the actual gesture gating.
    const isChildJoint = setup && part.kind === 'bone' && !!part.parentId && !part.attachedRoot
      && doc.parts.some((pp) => pp.id === part.parentId && pp.kind === 'bone');
    cross.setAttribute(
      'class',
      setup ? (isChildJoint ? 'pivot-handle joint' : 'pivot-handle') : 'pivot-handle locked',
    );
    if (setup) { cross.dataset.role = 'pivot'; cross.dataset.partId = part.id; }
    if (rootTransform) cross.setAttribute('transform', rootTransform);
    cross.innerHTML =
      jointDotHtml(px, py, size) +
      `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
      `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
    ctx.overlay.appendChild(cross);
  }
  drawSnapMarker();
}

/**
 * Unified select-tool gizmo, shown in BOTH Edit and Animate whenever the V/select tool
 * has a (non-skinned) part selected: a rotate CIRCLE around the effective pivot and a
 * move CROSS at the selection centre. Reuses the tool-gizmo hit semantics — the ring
 * carries data-role="gizmo-ring" (a rotate drag around the pivot) and the cross
 * data-gizmo-axis="xy" (a free translate) — so the existing pointerdown handlers drive
 * them, writing rest in Edit and keys in Animate. Hover highlights each affordance.
 */
function renderSelectGizmo(size: number, t: number | null, rootTransform: string): void {
  if (!ctx.overlay || state.mode !== 'rig' || state.tool !== 'select') return;
  const part = selectedPart();
  if (!part || part.skin) return;
  if (isEffectivelyHidden(part)) return; // Layers eye — canvas draws nothing for it

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'select-gizmo');
  if (rootTransform) g.setAttribute('transform', rootTransform);

  // Rotate circle around the joint (annulus hit — the centre stays free for the pivot).
  const piv = effectivePivot(part, t);
  const r = size * 3.2;
  const rotG = document.createElementNS(SVG_NS, 'g');
  rotG.setAttribute('class', 'sg-rotate');
  rotG.innerHTML =
    `<circle class="sg-ring" cx="${piv.x}" cy="${piv.y}" r="${r}" />` +
    `<circle class="sg-hit" data-role="gizmo-ring" cx="${piv.x}" cy="${piv.y}" r="${r}" />`;
  g.appendChild(rotG);

  // Move cross at the primary part's rendered centre (partless parts have no box).
  const box = partRootBoxes([part.id]).get(part.id);
  if (box) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const a = size * 1.5;
    const movG = document.createElementNS(SVG_NS, 'g');
    movG.setAttribute('class', 'sg-move');
    movG.innerHTML =
      `<path class="sg-cross" d="M ${cx - a},${cy} H ${cx + a} M ${cx},${cy - a} V ${cy + a}" />` +
      `<rect class="sg-hit" data-gizmo-axis="xy" x="${cx - a}" y="${cy - a}" width="${a * 2}" height="${a * 2}" />`;
    g.appendChild(movG);
  }
  ctx.overlay.appendChild(g);
}

/** Rive/Blender-style axis gizmo for the translate/rotate tools, at the live pivot. */
function renderToolGizmo(size: number, t: number | null, rootTransform: string): void {
  if (!ctx.overlay || state.mode !== 'rig') return;
  if (state.tool !== 'translate' && state.tool !== 'rotate') return;
  const part = selectedPart();
  if (!part || part.skin) return;
  if (isEffectivelyHidden(part)) return; // Layers eye
  const p = effectivePivot(part, t);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'tool-gizmo');
  if (rootTransform) g.setAttribute('transform', rootTransform);

  if (state.tool === 'translate') {
    const len = size * 8;
    const head = size * 1.4;
    const box = size * 1.5;
    g.innerHTML =
      // X axis (red): line, arrow head, invisible fat hit line
      `<line class="gizmo-axis-x" x1="${p.x}" y1="${p.y}" x2="${p.x + len}" y2="${p.y}" />` +
      `<path class="gizmo-axis-x head" d="M ${p.x + len + head},${p.y} L ${p.x + len},${p.y - head * 0.6} L ${p.x + len},${p.y + head * 0.6} Z" />` +
      `<line class="gizmo-hit" data-gizmo-axis="x" x1="${p.x + box}" y1="${p.y}" x2="${p.x + len + head}" y2="${p.y}" />` +
      // Y axis (green)
      `<line class="gizmo-axis-y" x1="${p.x}" y1="${p.y}" x2="${p.x}" y2="${p.y + len}" />` +
      `<path class="gizmo-axis-y head" d="M ${p.x},${p.y + len + head} L ${p.x - head * 0.6},${p.y + len} L ${p.x + head * 0.6},${p.y + len} Z" />` +
      `<line class="gizmo-hit" data-gizmo-axis="y" x1="${p.x}" y1="${p.y + box}" x2="${p.x}" y2="${p.y + len + head}" />` +
      // Free-move square in the middle
      `<rect class="gizmo-free" data-gizmo-axis="xy" x="${p.x - box}" y="${p.y - box}" width="${box * 2}" height="${box * 2}" />`;
  } else {
    const r = size * 7;
    g.innerHTML =
      `<circle class="gizmo-ring-visual" cx="${p.x}" cy="${p.y}" r="${r}" />` +
      `<circle class="gizmo-ring-hit" data-role="gizmo-ring" cx="${p.x}" cy="${p.y}" r="${r}" />`;
  }
  ctx.overlay.appendChild(g);
}

/** Rotation arc + angle readout, translation deltas, or scale % while a drag is live. */
function renderDragGizmo(holder: SVGGElement, size: number): void {
  if (!ctx.drag || ctx.drag.kind === 'pan' || ctx.drag.kind === 'nodeMarquee') return;
  if (!ctx.drag.active) return;

  if (ctx.drag.kind === 'rotate' && ctx.drag.current) {
    const p = { x: ctx.drag.pivotX, y: ctx.drag.pivotY };
    const r = size * 5;
    const a0 = ctx.drag.startAngle;
    const a1 = Math.atan2(ctx.drag.current.y - p.y, ctx.drag.current.x - p.x);
    let delta = a1 - a0;
    // Normalize the drawn arc into (-2π, 2π) so multi-turn wind-ups stay readable.
    while (delta > Math.PI * 2) delta -= Math.PI * 2;
    while (delta < -Math.PI * 2) delta += Math.PI * 2;

    const sx = p.x + r * Math.cos(a0), sy = p.y + r * Math.sin(a0);
    const ex = p.x + r * Math.cos(a0 + delta), ey = p.y + r * Math.sin(a0 + delta);
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const sweep = delta > 0 ? 1 : 0;

    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute(
      'd',
      `M ${p.x},${p.y} L ${sx},${sy} A ${r} ${r} 0 ${largeArc} ${sweep} ${ex},${ey} Z`,
    );
    arc.setAttribute('class', 'gizmo-arc');
    holder.appendChild(arc);

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(p.x));
    line.setAttribute('y1', String(p.y));
    line.setAttribute('x2', String(ctx.drag.current.x));
    line.setAttribute('y2', String(ctx.drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);

    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `${ctx.drag.currentDelta.toFixed(1)}°${ctx.drag.snapped ? ' (snap)' : ''}`,
      size,
    );
  } else if (ctx.drag.kind === 'translate' && ctx.drag.current) {
    const dx = ctx.drag.current.x - ctx.drag.startX;
    const dy = ctx.drag.current.y - ctx.drag.startY;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(ctx.drag.startX));
    line.setAttribute('y1', String(ctx.drag.startY));
    line.setAttribute('x2', String(ctx.drag.current.x));
    line.setAttribute('y2', String(ctx.drag.current.y));
    line.setAttribute('class', 'gizmo-line');
    line.setAttribute('stroke-dasharray', `${size * 0.7} ${size * 0.5}`);
    holder.appendChild(line);
    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `Δ ${round1(dx)}, ${round1(dy)}`,
      size,
    );
  } else if (ctx.drag.kind === 'scale' && ctx.drag.current) {
    addGizmoText(
      holder,
      ctx.drag.current.x + size * 1.5,
      ctx.drag.current.y - size * 1.5,
      `${Math.round(ctx.drag.part.rest.sx * 100)}% × ${Math.round(ctx.drag.part.rest.sy * 100)}%`,
      size,
    );
  } else if (ctx.drag.kind === 'groupScale' && ctx.drag.current) {
    // Same readout as a single part's scale drag, recomputed from the live pointer
    // (no single `part.rest.sx` to read back — the factor is distributed).
    const current = ctx.drag.current;
    const d = ctx.drag;
    const denX = d.grabRoot.x - d.pivotRoot.x;
    const denY = d.grabRoot.y - d.pivotRoot.y;
    const fx = Math.abs(denX) > 1e-6 ? (current.x - d.pivotRoot.x) / denX : 1;
    const fy = Math.abs(denY) > 1e-6 ? (current.y - d.pivotRoot.y) / denY : 1;
    addGizmoText(
      holder,
      current.x + size * 1.5,
      current.y - size * 1.5,
      `${Math.round(fx * 100)}% × ${Math.round(fy * 100)}%`,
      size,
    );
  } else if (ctx.drag.kind === 'ik' && ctx.drag.current) {
    // Target line: effector (the grabbed point, recomputed live off the just-solved
    // pose) → pointer. At full reach the two coincide; a visible gap explains an
    // out-of-reach clamp instead of leaving the drag looking unresponsive.
    const current = ctx.drag.current;
    const m = matrixOfTransform(fullPoseTransform(ctx.drag.grabbed, poseTime()));
    const eff = applyMat(m, ctx.drag.grabLocal.x, ctx.drag.grabLocal.y);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(eff.x));
    line.setAttribute('y1', String(eff.y));
    line.setAttribute('x2', String(current.x));
    line.setAttribute('y2', String(current.y));
    line.setAttribute('class', 'ik-target-line');
    holder.appendChild(line);
  }
}

function addGizmoText(holder: SVGGElement, x: number, y: number, text: string, size: number): void {
  const bg = document.createElementNS(SVG_NS, 'text');
  bg.setAttribute('x', String(x));
  bg.setAttribute('y', String(y));
  bg.setAttribute('class', 'gizmo-text-halo');
  bg.setAttribute('font-size', String(size * 2));
  bg.textContent = text;
  holder.appendChild(bg);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('class', 'gizmo-text');
  t.setAttribute('font-size', String(size * 2));
  t.textContent = text;
  holder.appendChild(t);
}

/** Draw the snap-target marker (a small non-scaling ring + crosshair) if one is live. */
function drawSnapMarker(): void {
  if (!ctx.overlay || !ctx.snapMarker) return;
  const size = handleSize();
  const r = size * 1.3;
  const { x, y } = ctx.snapMarker;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'snap-marker');
  g.style.pointerEvents = 'none';
  g.innerHTML =
    `<circle class="gizmo-line" fill="none" cx="${x}" cy="${y}" r="${r}" />` +
    `<line class="gizmo-line" x1="${x - r}" y1="${y}" x2="${x + r}" y2="${y}" />` +
    `<line class="gizmo-line" x1="${x}" y1="${y - r}" x2="${x}" y2="${y + r}" />`;
  ctx.overlay.appendChild(g);
}
