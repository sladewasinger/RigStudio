/**
 * Bone/group glyph chrome: the interactive diamond/square/kite glyph each partless
 * part (bone or group) draws at its live joint (since it has no artwork of its own to
 * click), the passive skeleton markers (pivot ghosts + dashed bone lines) that make the
 * whole rig visible at a glance, the pen-tool bone-chain placement preview, and the
 * freeze-mode per-bone origin markers. Split out of overlay.ts's render loop (CLAUDE.md
 * "Small, focused files") — pure chrome-building, no top-level orchestration.
 */

import { ctx, SVG_NS } from './context';
import { state, RigDoc, RigPart, isEffectivelyHidden } from '../core/model';
import { effectivePivot, effectiveTip } from './pose';
import { boneKitePath, jointDotHtml } from './glyphs';

/**
 * One bone/group's canvas glyph (kite/diamond/square) + its tip-handle wrapper (Setup,
 * when it's the primary selection) — shared by the main overlay loop and the
 * node-editing chain-bone loop (item v2.13 follow-up: bones stay visible/selectable
 * while their owning part is node-edited) so both draw an identical, fully interactive
 * glyph. Returns the tip-handle wrapper (append it AFTER every glyph in the caller's
 * loop — see the loop below for why) or null.
 */
export function appendNullGlyph(
  part: RigPart, t: number | null, rootTransform: string, size: number, setup: boolean,
): SVGGElement | null {
  const doc = state.doc!;
  const p = effectivePivot(part, t);
  const s = size * 1.6;
  const glyph = document.createElementNS(SVG_NS, 'g');
  glyph.dataset.partId = part.id;
  const sel = state.selectedPartIds.includes(part.id) ? ' selected' : '';
  const drag = ctx.drag;
  // Highlight EVERY bone FABRIK is solving (root→effector), so the whole participating
  // chain lights up — not just two ancestors.
  const ikActive = !!drag && drag.kind === 'ik' && drag.active
    && drag.chain.some((c) => c.id === part.id);
  glyph.setAttribute('class', `null-glyph ${part.kind}${sel}${ikActive ? ' ik-active' : ''}`);
  if (rootTransform) glyph.setAttribute('transform', rootTransform);
  const tip = effectiveTip(part, t);
  if (part.kind === 'group') {
    glyph.innerHTML =
      `<rect x="${p.x - s * 0.8}" y="${p.y - s * 0.8}" width="${s * 1.6}" height="${s * 1.6}" />`;
  } else if (tip) {
    // Classic bone: a kite from the joint to the tip, widest near the joint.
    glyph.innerHTML = boneKitePath(p, tip, size);
  } else {
    glyph.innerHTML =
      `<path d="M ${p.x},${p.y - s} L ${p.x + s * 0.7},${p.y} L ${p.x},${p.y + s} ` +
      `L ${p.x - s * 0.7},${p.y} Z" />`;
  }
  ctx.overlay!.appendChild(glyph);

  // The selected bone's tip is editable in Setup (re-aim / re-length). Build it here
  // but return it for the caller to append AFTER the whole glyph loop, so a connected
  // child bone's glyph (which sits on the shared joint == this tip) can't occlude it —
  // otherwise the parent-tip drag is unreachable and only the child's pivot moves the
  // shared joint.
  if (setup && tip && part.id === state.selectedPartId) {
    const th = document.createElementNS(SVG_NS, 'circle');
    th.setAttribute('cx', String(tip.x));
    th.setAttribute('cy', String(tip.y));
    th.setAttribute('r', String(size * 0.9));
    // A tip with a child bone hanging off it is a shared JOINT (origin editing) —
    // freeze-gated, so mark it so the cursor drops its move affordance outside freeze.
    const tipIsJoint = doc.parts.some((pp) => pp.kind === 'bone' && pp.parentId === part.id);
    th.setAttribute('class', `bone-tip-handle${tipIsJoint ? ' joint' : ''}`);
    th.dataset.role = 'bone-tip';
    const wrap = document.createElementNS(SVG_NS, 'g');
    if (rootTransform) wrap.setAttribute('transform', rootTransform);
    wrap.appendChild(th);
    return wrap;
  }
  return null;
}

/** Ghost markers: every art part's live joint, so the skeleton is visible at a glance.
 *  Bones and groups get interactive glyphs (appendNullGlyph) instead. */
export function renderPivotGhosts(
  doc: RigDoc, t: number | null, size: number, holder: SVGGElement,
): void {
  for (const part of doc.parts) {
    if (part.id === state.selectedPartId || part.paths.length === 0) continue;
    if (isEffectivelyHidden(part)) continue; // Layers eye — no floating joint marker
    const p = effectivePivot(part, t);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(p.x));
    dot.setAttribute('cy', String(p.y));
    dot.setAttribute('r', String(size * 0.55));
    dot.setAttribute('class', 'pivot-ghost');
    holder.appendChild(dot);
  }
}

/** Bone lines: connect each parented part's joint to its parent's joint. */
export function renderBoneLines(
  doc: RigDoc, t: number | null, size: number, holder: SVGGElement,
): void {
  for (const part of doc.parts) {
    if (!part.parentId) continue;
    if (isEffectivelyHidden(part)) continue; // Layers eye
    const parent = doc.parts.find((p) => p.id === part.parentId);
    if (!parent) continue;
    const a = effectivePivot(parent, t);
    const b = effectivePivot(part, t);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('class', 'bone-line');
    line.setAttribute('stroke-dasharray', `${size * 0.5} ${size * 0.5}`);
    holder.appendChild(line);
  }
}

/**
 * PEN-TOOL BONE CHAIN preview: a marker at the pending origin plus a ghost bone to the
 * cursor (once it moves). The girth is screen-constant (boneKitePath derives it from
 * `size`), so the preview obeys the chrome GOTCHA. Committed bones are already real parts
 * drawn by the glyph loop (appendNullGlyph); only the in-progress segment lives here.
 */
export function renderBoneChainPreview(holder: SVGGElement, size: number): void {
  if (!ctx.boneChain) return;
  const o = ctx.boneChain.origin;
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(o.x));
  dot.setAttribute('cy', String(o.y));
  dot.setAttribute('r', String(size * 0.6));
  dot.setAttribute('class', 'chain-origin');
  holder.appendChild(dot);
  if (ctx.boneChain.cursor) {
    const ghost = document.createElementNS(SVG_NS, 'g');
    ghost.setAttribute('class', 'null-glyph bone placing');
    ghost.innerHTML = boneKitePath(o, ctx.boneChain.cursor, size);
    holder.appendChild(ghost);
  }
}

/**
 * FREEZE FIX (Post-A "origin-drag rotates unselected bones"): outside freeze, only the
 * selected part gets a pivot marker (overlay.ts's primary crosshair) — origin/joint
 * handles on every OTHER bone stay invisible, matching the existing "select first"
 * affordance. In freeze mode EVERY bone's origin gets one too (visible counterpart for
 * the joint-drag interaction), each carrying data-part-id so interactions.ts's pivotEl
 * branch can select + start the joint drag in one press without requiring pre-selection.
 * The primary/selected bone still gets its own richer crosshair, so it's skipped here to
 * avoid a doubled marker. Caller guards this to freeze mode + Setup.
 */
export function renderFreezeJointMarkers(
  doc: RigDoc, t: number | null, size: number, rootTransform: string,
): void {
  if (!ctx.overlay) return;
  for (const bone of doc.parts) {
    if (bone.kind !== 'bone' || bone.id === state.selectedPartId) continue;
    if (isEffectivelyHidden(bone)) continue;
    const op = effectivePivot(bone, t);
    const dot = document.createElementNS(SVG_NS, 'g');
    dot.setAttribute('class', 'pivot-handle other');
    dot.dataset.role = 'pivot';
    dot.dataset.partId = bone.id;
    if (rootTransform) dot.setAttribute('transform', rootTransform);
    dot.innerHTML = jointDotHtml(op.x, op.y, size);
    ctx.overlay.appendChild(dot);
  }
}
