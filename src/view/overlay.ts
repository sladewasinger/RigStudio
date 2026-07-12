/**
 * Overlay chrome: selection boxes, Inkscape-style scale/rotate/skew handles, the pivot
 * crosshair, live joint ghosts + bone lines, bone/group glyphs, the transform-tool and
 * drag gizmos, node-editing handles, and the snap marker.
 *
 * renderOverlay() rebuilds #overlay from scratch each call (innerHTML=''), and carries
 * two deliberate render-time side effects: it resets the Setup handle cycle to 'scale'
 * when the primary selection changes, and renderNodeHandles prunes stale node
 * selections. Overlay strokes use vector-effect: non-scaling-stroke so widths stay
 * screen-constant; radii are in doc units via handleSize().
 */

import { ctx, SVG_NS, round1, nodeKey, parseNodeKey } from './context';
import {
  state, RigPart, selectedPart, selectedParts, chainBonesOfPart, isEffectivelyHidden,
} from '../core/model';
import { parsePath } from '../geometry/paths';
import { applyMat, matrixOfTransform } from '../geometry/transforms';
import { handleSize } from './coords';
import {
  poseTime, effectivePivot, effectiveTip, partRootBoxes, fullPoseTransform, groupUnionBox,
} from './pose';
import { nodeEditSkinSuspendId } from './focus';

/** The 4 corner rotate-handle circles of the Inkscape-style rotate/skew handle set —
 *  shared between Edit's rotate+skew set and Animate's rotate-only set (bug fix: the
 *  second gizmo click must be visible in Animate too, not just internally flip a mode
 *  flag with the box looking unchanged). */
function appendRotateCorners(
  handles: SVGGElement, x0: number, y0: number, x1: number, y1: number, size: number,
): void {
  for (const [name, hx, hy] of [
    ['nw', x0, y0], ['ne', x1, y0], ['se', x1, y1], ['sw', x0, y1],
  ] as [string, number, number][]) {
    const h = document.createElementNS(SVG_NS, 'circle');
    h.setAttribute('cx', String(hx));
    h.setAttribute('cy', String(hy));
    h.setAttribute('r', String(size * 0.9));
    h.setAttribute('class', `rotate-handle handle-${name}`);
    h.dataset.role = 'rotate-handle';
    handles.appendChild(h);
  }
}

// ---- Overlay: selection box, handles, pivots, drag gizmos, node handles ----

export function renderOverlay(): void {
  if (!ctx.overlay || !ctx.svg || !ctx.rootGroup) return;
  ctx.overlay.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

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
      let selectedBoneTip: SVGGElement | null = null;
      for (const bone of chainBonesOfPart(doc.parts, part)) {
        if (isEffectivelyHidden(bone)) continue; // Layers eye
        const tipWrap = appendNullGlyph(bone, t, rootTransform, size, setup);
        if (tipWrap) selectedBoneTip = tipWrap;
      }
      if (selectedBoneTip) ctx.overlay.appendChild(selectedBoneTip);
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

  // Ghost markers: every art part's live joint, so the skeleton is visible at a
  // glance. Bones and groups get interactive glyphs below instead.
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

  // Bone lines: connect each parented part's joint to its parent's joint.
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

  // Highlight the "entered" path, if any (Setup path selection).
  if (setup && state.selectedPathId) {
    const part = selectedPart();
    const g = part ? ctx.partGroups.get(part.id) : null;
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

  // Dashed transform boxes + Inkscape-style handles for every selected part. ART parts
  // use their own rendered bbox (part-local boxTransform); GROUPS are partless (no
  // artwork of their own — CLAUDE.md), so they use the root-space union AABB of their
  // descendants' rendered boxes instead (groupUnionBox — the same box the dashed group
  // outline always drew) and, for the PRIMARY selection, the identical scale/rotate
  // handle sets an art part gets (minus skew — groups have no shear field): first click
  // = 8 scale handles (a DISTRIBUTED rest edit across every descendant, rigOps.ts's
  // applyGroupScale, the flipSelected family generalized to scale), second click = 4
  // rotate corners (the group's OWN rest.rotate, which genuinely propagates through the
  // pose chain). Per the visible-counterpart GOTCHA, the handle-set toggle must render
  // something different for every selectable KIND — groups used to draw only the
  // passive dashed box with no way to tell scale mode from rotate mode.
  for (const part of selectedParts()) {
    // Layers eye: a hidden part stays selectable via Layers (the inspector still shows
    // its fields) but draws NOTHING on canvas — no box, no handles.
    if (isEffectivelyHidden(part)) continue;
    const isGroup = part.kind === 'group';
    const g = ctx.partGroups.get(part.id);
    let box: { x: number; y: number; width: number; height: number };
    let boxTransform: string;
    if (isGroup) {
      const ub = groupUnionBox(part);
      if (!ub) continue; // nothing inside yet — nothing to box or handle
      box = { x: ub.x0, y: ub.y0, width: ub.x1 - ub.x0, height: ub.y1 - ub.y0 };
      boxTransform = rootTransform; // union bbox is already root-space
    } else {
      if (!g || part.paths.length === 0) continue;
      const partTransform = g.getAttribute('transform') ?? '';
      boxTransform = [rootTransform, partTransform].filter(Boolean).join(' ');
      box = g.getBBox();
    }
    const primary = part.id === state.selectedPartId;
    const pad = size * (isGroup ? 0.8 : 0.6);
    const x0 = box.x - pad, y0 = box.y - pad;
    const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;

    const boxHolder = document.createElementNS(SVG_NS, 'g');
    boxHolder.setAttribute('class', 'overlay-passive');
    boxHolder.setAttribute('transform', boxTransform);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x0));
    rect.setAttribute('y', String(y0));
    rect.setAttribute('width', String(x1 - x0));
    rect.setAttribute('height', String(y1 - y0));
    rect.setAttribute('class', primary ? 'select-box' : 'select-box secondary');
    rect.setAttribute('stroke-dasharray', `${size * 0.9} ${size * 0.7}`);
    boxHolder.appendChild(rect);
    ctx.overlay.appendChild(boxHolder);

    if (!primary) continue;

    if (part.skin) {
      // Skinned parts get a box but NO scale/rotate handles — those would be lies, since
      // the geometry follows its bones, not a group transform. A small label says so, so
      // the click never dead-ends silently ("why can't I grab a handle?"). A skinned part
      // renders with an empty group transform, so boxTransform is axis-aligned root space.
      // (Groups are never skinned — bindPartsToBones only ever targets art parts.)
      const hint = document.createElementNS(SVG_NS, 'text');
      hint.setAttribute('x', String(x0));
      hint.setAttribute('y', String(y0 - size * 0.6));
      hint.setAttribute('class', 'skin-hint');
      hint.setAttribute('font-size', String(size * 1.5));
      hint.textContent = 'posed by its bones';
      const wrap = document.createElementNS(SVG_NS, 'g');
      wrap.setAttribute('class', 'overlay-passive');
      wrap.setAttribute('transform', boxTransform);
      wrap.appendChild(hint);
      ctx.overlay.appendChild(wrap);
    }

    if (setup && !part.skin) {
      // Interactive Inkscape-style handles for the primary part.
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (ctx.handleMode === 'scale') {
        const spots: [string, number, number][] = [
          ['nw', x0, y0], ['ne', x1, y0], ['se', x1, y1], ['sw', x0, y1],
          ['n', cx, y0], ['e', x1, cy], ['s', cx, y1], ['w', x0, cy],
        ];
        for (const [name, hx, hy] of spots) {
          const s = size * 1.1;
          const h = document.createElementNS(SVG_NS, 'rect');
          h.setAttribute('x', String(hx - s / 2));
          h.setAttribute('y', String(hy - s / 2));
          h.setAttribute('width', String(s));
          h.setAttribute('height', String(s));
          h.setAttribute('class', `scale-handle handle-${name}`);
          h.dataset.handle = name;
          handles.appendChild(h);
        }
      } else {
        // Inkscape's second handle set: corners rotate, sides SKEW — groups skip the
        // skew sides entirely (no shear field), so their set is rotate-corners-only;
        // still visibly distinct from the 8-square scale set (the GOTCHA's bar).
        appendRotateCorners(handles, x0, y0, x1, y1, size);
        if (!isGroup) {
          for (const [name, hx, hy] of [
            ['n', cx, y0], ['e', x1, cy], ['s', cx, y1], ['w', x0, cy],
          ] as [string, number, number][]) {
            const s = size * 1.0;
            const h = document.createElementNS(SVG_NS, 'rect');
            h.setAttribute('x', String(hx - s / 2));
            h.setAttribute('y', String(hy - s / 2));
            h.setAttribute('width', String(s));
            h.setAttribute('height', String(s));
            h.setAttribute('class', `skew-handle handle-${name}`);
            h.dataset.skewSide = name;
            handles.appendChild(h);
          }
        }
      }
      ctx.overlay.appendChild(handles);
    } else if (!setup && !part.skin && ctx.handleMode === 'rotate') {
      // Animate's second click (bug fix): the mode flip from translate to rotate was
      // invisible — the dashed box looked identical, so the user couldn't tell a body
      // drag now rotates instead of moves. Render the same 4 rotate-handle corners as
      // Edit's rotate set (interactions.ts routes their drag through the same
      // setup-aware rotate pipeline, keying instead of writing rest) but WITHOUT the
      // skew sides — skew has no keyable channel in Animate (groups match art parts
      // here exactly: same corners, keying the group's OWN rotate channel).
      const handles = document.createElementNS(SVG_NS, 'g');
      handles.setAttribute('transform', boxTransform);
      appendRotateCorners(handles, x0, y0, x1, y1, size);
      ctx.overlay.appendChild(handles);
    } else {
      // Animate's first click (translate/scale set) — scale isn't keyable, so this
      // stays the plain dashed box with passive corner markers (drag the body to
      // translate/key); also the fallback for skinned parts in either mode.
      const boxCorners = document.createElementNS(SVG_NS, 'g');
      boxCorners.setAttribute('class', 'overlay-passive');
      boxCorners.setAttribute('transform', boxTransform);
      for (const [hx, hy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        const corner = document.createElementNS(SVG_NS, 'rect');
        const s = size * 0.9;
        corner.setAttribute('x', String(hx - s / 2));
        corner.setAttribute('y', String(hy - s / 2));
        corner.setAttribute('width', String(s));
        corner.setAttribute('height', String(s));
        corner.setAttribute('class', 'select-corner');
        boxCorners.appendChild(corner);
      }
      ctx.overlay.appendChild(boxCorners);
    }
  }

  // PEN-TOOL BONE CHAIN preview: a marker at the pending origin plus a ghost bone to the
  // cursor (once it moves). The girth is screen-constant (boneKitePath derives it from
  // `size`), so the preview obeys the chrome GOTCHA. Committed bones are already real parts
  // drawn by the glyph loop above; only the in-progress segment lives here.
  if (ctx.boneChain) {
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

  renderDragGizmo(holder, size);
  renderToolGizmo(size, t, rootTransform);

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
    const isChildJoint = setup && part.kind === 'bone' && !!part.parentId
      && doc.parts.some((pp) => pp.id === part.parentId && pp.kind === 'bone');
    cross.setAttribute(
      'class',
      setup ? (isChildJoint ? 'pivot-handle joint' : 'pivot-handle') : 'pivot-handle locked',
    );
    if (setup) cross.dataset.role = 'pivot';
    if (rootTransform) cross.setAttribute('transform', rootTransform);
    cross.innerHTML =
      `<circle class="pivot-grab" cx="${px}" cy="${py}" r="${size * 1.6}" />` +
      `<circle class="pivot-ring" cx="${px}" cy="${py}" r="${size * 1.1}" />` +
      `<circle class="pivot-dot" cx="${px}" cy="${py}" r="${size * 0.3}" />` +
      `<line x1="${px - size * 2}" y1="${py}" x2="${px + size * 2}" y2="${py}" />` +
      `<line x1="${px}" y1="${py - size * 2}" x2="${px}" y2="${py + size * 2}" />`;
    ctx.overlay.appendChild(cross);
  }
  drawSnapMarker();
}

/**
 * The classic bone silhouette between two points (joint fat end, pointed tip). The
 * origin→tip SPAN legitimately scales with zoom (it's the true joint positions), but
 * per the screen-constant-chrome GOTCHA the kite's CROSS-SECTION must not: `w` (and the
 * along-axis offset of its widest point) derive only from `size` (handleSize(), already
 * screen-constant), never from `len` (a fixed doc-space quantity whose on-screen size
 * grows with zoom) — that mixed-unit `Math.min(len*k, size*k)` used to win on whichever
 * term was smaller, so the girth crept wider through most of a zoom-in before a
 * high-zoom crossover finally capped it (the reported "bone glyphs not zoom-stable"
 * bug). `len` still bounds where the widest point sits ALONG the segment, purely so a
 * very short bone's kite doesn't overshoot its own tip — that's a shape/proportion
 * clamp, not a girth one, and doesn't reintroduce the bug.
 */
function boneKitePath(p: { x: number; y: number }, q: { x: number; y: number }, size: number): string {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const ux = dx / len, uy = dy / len;
  const w = size * 1.6;
  const off = Math.min(len * 0.5, size * 2);
  const bx = p.x + ux * off;
  const by = p.y + uy * off;
  return (
    `<path d="M ${p.x},${p.y} L ${bx - uy * w},${by + ux * w} L ${q.x},${q.y} ` +
    `L ${bx + uy * w},${by - ux * w} Z" />` +
    `<circle cx="${p.x}" cy="${p.y}" r="${w * 0.5}" />`
  );
}

/**
 * One bone/group's canvas glyph (kite/diamond/square) + its tip-handle wrapper (Setup,
 * when it's the primary selection) — shared by the main overlay loop and the
 * node-editing chain-bone loop (item v2.13 follow-up: bones stay visible/selectable
 * while their owning part is node-edited) so both draw an identical, fully interactive
 * glyph. Returns the tip-handle wrapper (append it AFTER every glyph in the caller's
 * loop — see the loop below for why) or null.
 */
function appendNullGlyph(
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

/**
 * The node-editing equivalent of the `.skin-hint` "posed by its bones" label (item
 * v2.13 follow-up): while this part's deformation is suspended for node editing, say so
 * — the art on screen is its base/bind shape, not its current pose.
 */
function drawSkinSuspendHint(part: RigPart, size: number): void {
  const g = ctx.partGroups.get(part.id);
  if (!g || !ctx.overlay) return;
  const box = g.getBBox();
  const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
  const groupTransform = g.getAttribute('transform') ?? '';
  const hint = document.createElementNS(SVG_NS, 'text');
  hint.setAttribute('x', String(box.x));
  hint.setAttribute('y', String(box.y - size * 0.6));
  hint.setAttribute('class', 'skin-hint');
  hint.setAttribute('font-size', String(size * 1.5));
  hint.textContent = 'editing base shape — bone deformation paused';
  const wrap = document.createElementNS(SVG_NS, 'g');
  wrap.setAttribute('class', 'overlay-passive');
  wrap.setAttribute('transform', [rootTransform, groupTransform].filter(Boolean).join(' '));
  wrap.appendChild(hint);
  ctx.overlay.appendChild(wrap);
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

function renderNodeHandles(part: RigPart): void {
  const g = ctx.partGroups.get(part.id)!;
  // With a path "entered", node editing scopes to it; otherwise every path is editable.
  const paths = state.selectedPathId
    ? part.paths.filter((p) => p.id === state.selectedPathId)
    : part.paths;
  // Prune stale node selections (path gone, or the path shrank under them).
  for (const key of [...ctx.selectedNodes]) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    if (!paths.some((p) => p.id === pathId && cmdIndex < parsePath(p.d).length)) {
      ctx.selectedNodes.delete(key);
    }
  }
  if (ctx.selectedNode && !ctx.selectedNodes.has(nodeKey(ctx.selectedNode.pathId, ctx.selectedNode.cmdIndex))) {
    ctx.selectedNode = null;
  }
  for (const path of paths) {
    const cmds = parsePath(path.d);
    const types = path.nodeTypes ?? '';
    const holder = document.createElementNS(SVG_NS, 'g');
    // Same accumulated transform as the drawn path (root + part + path), so raw path
    // coordinates land exactly on the rendered artwork.
    const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
    const groupTransform = g.getAttribute('transform') ?? '';
    holder.setAttribute(
      'transform',
      [rootTransform, groupTransform, path.transform].filter(Boolean).join(' '),
    );
    const size = handleSize();
    // A control handle "coincides" with its node (retracted, effectively zero-length)
    // when it's within a small on-screen distance through the zoom — hide the dot AND
    // its handle-line rather than clutter the view with a handle sitting on top of the
    // node it belongs to. Expressed via handleSize() like every other radius here, so
    // it scales the same way through the zoom as the handles themselves.
    const zeroLenThreshold = size * 0.4;

    // Handle lines first (underneath): control points connect to their nodes —
    // x1 to the segment's start node, x2 to its end node.
    let prev: { x: number; y: number } | null = null;
    cmds.forEach((c) => {
      if (c.cmd === 'Z') return;
      if (c.cmd === 'C' && prev) {
        if (Math.hypot(c.x1 - prev.x, c.y1 - prev.y) >= zeroLenThreshold) {
          addHandleLine(holder, prev.x, prev.y, c.x1, c.y1);
        }
        if (Math.hypot(c.x2 - c.x, c.y2 - c.y) >= zeroLenThreshold) {
          addHandleLine(holder, c.x, c.y, c.x2, c.y2);
        }
      }
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    });

    let nodeIdx = -1;
    prev = null;
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      nodeIdx++;
      if (c.cmd === 'C') {
        if (prev && Math.hypot(c.x1 - prev.x, c.y1 - prev.y) >= zeroLenThreshold) {
          addHandle(holder, path.id, i, 'x1', c.x1, c.y1, size * 0.6, 'ctrl');
        }
        if (Math.hypot(c.x2 - c.x, c.y2 - c.y) >= zeroLenThreshold) {
          addHandle(holder, path.id, i, 'x2', c.x2, c.y2, size * 0.6, 'ctrl');
        }
      }
      const isSelected = ctx.selectedNodes.has(nodeKey(path.id, i));
      addHandle(
        holder, path.id, i, 'x',
        (c as { x: number }).x, (c as { y: number }).y,
        size * (isSelected ? 1.05 : 0.8), 'node', isSelected,
        types[nodeIdx], // persistent type tints the node
      );
      prev = { x: (c as { x: number }).x, y: (c as { y: number }).y };
    });
    ctx.overlay!.appendChild(holder);
  }
}

function addHandleLine(holder: SVGGElement, x1: number, y1: number, x2: number, y2: number): void {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', 'handle-line');
  holder.appendChild(line);
}

/**
 * A node/control handle. Node endpoints take Inkscape's shape language: corner
 * ('c') = diamond, smooth ('s') = square, symmetric ('z') = circle; untyped nodes
 * are small circles. Control points are always small circles.
 */
function addHandle(
  holder: SVGGElement, pathId: string, cmdIndex: number,
  field: 'x' | 'x1' | 'x2', x: number, y: number, r: number, kind: 'node' | 'ctrl',
  selected = false, typeChar?: string,
): void {
  let c: SVGElement;
  if (kind === 'node' && typeChar === 'c') {
    c = document.createElementNS(SVG_NS, 'rect');
    c.setAttribute('x', String(x - r * 0.9));
    c.setAttribute('y', String(y - r * 0.9));
    c.setAttribute('width', String(r * 1.8));
    c.setAttribute('height', String(r * 1.8));
    c.setAttribute('transform', `rotate(45 ${x} ${y})`); // diamond
  } else if (kind === 'node' && typeChar === 's') {
    c = document.createElementNS(SVG_NS, 'rect');
    c.setAttribute('x', String(x - r * 0.85));
    c.setAttribute('y', String(y - r * 0.85));
    c.setAttribute('width', String(r * 1.7));
    c.setAttribute('height', String(r * 1.7));
  } else {
    c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', String(r));
  }
  const typeClass =
    typeChar === 's' ? ' nt-s' : typeChar === 'z' ? ' nt-z' : typeChar === 'c' ? ' nt-c' : '';
  c.setAttribute(
    'class',
    (kind === 'node' ? 'node-handle' : 'ctrl-handle') +
      (selected ? ' selected' : '') + typeClass,
  );
  c.dataset.role = 'node';
  c.dataset.pathId = pathId;
  c.dataset.cmdIndex = String(cmdIndex);
  c.dataset.field = field;
  holder.appendChild(c);

  // Selected endpoints get a contrasting ring IN ADDITION to the size bump above —
  // a plain fill/size change reads poorly once several nodes are multi-selected.
  // Always a circle (regardless of the underlying type glyph) so it reads the same
  // for every node shape; non-interactive, drawn on top.
  if (selected && kind === 'node') {
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', String(x));
    ring.setAttribute('cy', String(y));
    ring.setAttribute('r', String(r * 1.7));
    ring.setAttribute('class', 'node-handle-ring');
    holder.appendChild(ring);
  }
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
