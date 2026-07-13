// ---- Part hierarchy ----

import { applyMat, multiply, rotationMat } from '../geometry/transforms';
import { Channel, Easing, RigPart, Track, Vec2 } from './docTypes';
import { selectPart, state } from './appState';
import { sampleKeyList } from './channels';
import { freshId } from './idGen';

export function partById(id: string): RigPart | null {
  return state.doc?.parts.find((p) => p.id === id) ?? null;
}

/** Ancestors of a part, outermost first. Cycle-safe (stops on repeat). */
export function ancestorChain(part: RigPart): RigPart[] {
  const chain: RigPart[] = [];
  const seen = new Set<string>([part.id]);
  let cur = part.parentId ? partById(part.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? partById(cur.parentId) : null;
  }
  return chain;
}

export function isAncestorOf(maybeAncestor: RigPart, part: RigPart): boolean {
  return ancestorChain(part).some((p) => p.id === maybeAncestor.id);
}

/**
 * Whether a part behaves like a GROUP for selection/dive-down/handle-chrome purposes: a
 * genuine partless `kind: 'group'` null, OR an ART part carrying at least one non-bone
 * child part — the recursive SVG importer's normal shape for a container that ALSO draws
 * its own geometry (Pip's `face`: its own mouth path plus a nested `eyes` part — the
 * reported bug: every group behavior keyed on `kind === 'group'` alone, so `face` got
 * none of them). Bones are excluded on the child side: an art part whose only children
 * are its OWN bone chain (hierarchy-as-assignment parents a limb's rig under its art on
 * purpose) must NOT start behaving like a container — clicking the art, or dragging it,
 * has to stay a normal single-part gesture, not a group substitution/distributed scale.
 */
export function isGroupLike(part: RigPart, parts: RigPart[]): boolean {
  if (part.kind === 'group') return true;
  if (part.kind !== 'art') return false;
  return parts.some((p) => p.parentId === part.id && p.kind !== 'bone');
}

/**
 * Whether a part should render/hit-test as invisible right now: hidden itself, or riding
 * a hidden ancestor (the Layers eye cascades down the bone hierarchy like a design tool's
 * layer visibility — "a hidden limb's rig shouldn't float"). The doc stores only the flag
 * on the part it was toggled on (`RigPart.hidden`); this derives the effective state per
 * part at render/export time. Parts are a FLAT list (no DOM/JSON nesting), so callers must
 * apply this per part rather than relying on any kind of inheritance.
 */
export function isEffectivelyHidden(part: RigPart): boolean {
  return !!part.hidden || ancestorChain(part).some((a) => !!a.hidden);
}

/**
 * Invert the part selection (Ctrl+I, Category B item 4): every non-hidden part NOT
 * currently selected, replacing the selection wholesale — the exact complement of
 * `selectAllParts`'s "select every part". Scope: TOP-LEVEL selectable parts, i.e. all of
 * `doc.parts` flat, the same target space `selectAllParts` already uses — group-like
 * membership (`isGroupLike`) is a canvas CLICK-time affordance for resolving what a
 * pointer press selects, not a stored grouping the model tracks, so inverting doesn't
 * try to reconstruct or respect it beyond "a selected child stays independently
 * selectable" (already true of the existing selection state). Hidden parts are excluded
 * deliberately (unlike selectAllParts, which does no hidden filtering) — inverting is a
 * "select what I probably want to work on next" gesture, and an invisible part is never
 * that. Lives here (not appState.ts) because it needs `isEffectivelyHidden`, defined in
 * this same file — appState.ts must not import this module back (partHierarchy already
 * imports `state`/`selectPart` FROM appState.ts).
 */
export function invertSelection(): void {
  if (!state.doc) return;
  const current = new Set(state.selectedPartIds);
  const next = state.doc.parts.filter((p) => !isEffectivelyHidden(p) && !current.has(p.id));
  state.selectedPartIds = next.map((p) => p.id);
  state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1] ?? null;
  state.selectedPathId = null;
}

/**
 * Every id in `part`'s subtree: itself plus every recursive descendant, walked purely
 * through the `parentId` field — independent of `parts`' current ARRAY position, which is
 * the point: this stays correct even mid-repair, while `parts` is transiently non-
 * canonical (see moveSubtreeAfter below). Used anywhere a structural op must move a
 * part's WHOLE paint-order block together (CLAUDE.md/ROADMAP.md "Layer order IS z-order")
 * instead of just the part's own single array slot — leaving children behind at their old
 * position is exactly the bug this wave fixes.
 */
export function subtreeIds(part: RigPart, parts: RigPart[]): Set<string> {
  const ids = new Set<string>([part.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parts) {
      if (!ids.has(p.id) && p.parentId != null && ids.has(p.parentId)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Move `part`'s whole subtree (current relative order preserved) to sit immediately after
 * `after`'s current whole subtree, or to the very end (new topmost overall) when `after`
 * is null. The single place a reparent decides ARRAY position (see setParent) — always
 * leaves `part`'s subtree contiguous with `part` itself at its minimum index, regardless
 * of how scrambled `parts` was walking in (subtreeIds reads the parentId graph, not
 * existing array contiguity, so a temporarily-split block self-heals through this call).
 */
function moveSubtreeAfter(part: RigPart, after: RigPart | null, parts: RigPart[]): RigPart[] {
  const moveIds = subtreeIds(part, parts);
  const block = parts.filter((p) => moveIds.has(p.id));
  const rest = parts.filter((p) => !moveIds.has(p.id));
  if (!after) return [...rest, ...block];
  const afterIds = subtreeIds(after, parts);
  let insertAt = rest.length;
  for (let i = 0; i < rest.length; i++) if (afterIds.has(rest[i].id)) insertAt = i + 1;
  rest.splice(insertAt, 0, ...block);
  return rest;
}

/**
 * Reparent a part; refuses cycles. On success, moves the part's WHOLE SUBTREE to become
 * the new TOPMOST child of its new parent (or the new topmost root, when detaching to
 * null) — see moveSubtreeAfter — so doc.parts stays in canonical paint order (CLAUDE.md
 * "Layer order IS z-order"). Every reparent path funnels through here (the Layers drag,
 * the inspector's parent dropdown, Unified Skeleton's reattachRootBone, AI structural
 * edits), so this one chokepoint keeps all of them canonical without each caller having
 * to know about array position. A no-op call (already the requested parent) never
 * reshuffles order. Returns whether the change was applied.
 */
export function setParent(childId: string, parentId: string | null): boolean {
  const doc = state.doc;
  const child = partById(childId);
  if (!child) return false;
  if (parentId === null) {
    if (child.parentId === null) return true;
    if (doc) doc.parts = moveSubtreeAfter(child, null, doc.parts);
    child.parentId = null;
    return true;
  }
  if (parentId === childId) return false;
  const parent = partById(parentId);
  if (!parent) return false;
  if (isAncestorOf(child, parent)) return false; // would create a cycle
  if (child.parentId === parentId) return true;
  if (doc) doc.parts = moveSubtreeAfter(child, parent, doc.parts);
  child.parentId = parentId;
  return true;
}

// ---- Bones, groups, structural edits ----

/**
 * Create a partless bone/group part, positioned as the new TOPMOST child of `parentId`
 * (immediately after its current whole subtree — see moveSubtreeAfter) or the new topmost
 * root when parentId is null/unresolved — so a freshly placed part is canonical from
 * birth, regardless of what else has been drawn since its parent was created (the old
 * unconditional tail-push only stayed correct when the parent happened to already be the
 * very last thing in doc.parts).
 */
export function addNullPart(
  kind: 'bone' | 'group', pivot: Vec2, parentId: string | null, label?: string,
): RigPart {
  const doc = state.doc!;
  const part: RigPart = {
    id: freshId('part'),
    label: label ?? freshId(kind),
    kind,
    transform: '',
    pivot: { ...pivot },
    pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    parentId,
    paths: [],
  };
  const parent = parentId ? partById(parentId) : null;
  if (!parent) {
    doc.parts.push(part);
    return part;
  }
  const parentIds = subtreeIds(parent, doc.parts);
  let insertAt = doc.parts.length;
  for (let i = 0; i < doc.parts.length; i++) if (parentIds.has(doc.parts[i].id)) insertAt = i + 1;
  doc.parts.splice(insertAt, 0, part);
  return part;
}

/**
 * Wrap the outermost of the given parts in a new group null pivoted at `pivot`.
 * Members whose ancestor is also selected stay attached to that ancestor. The group
 * adopts the members' common parent (or none); it starts just above the topmost member's
 * own slot (roughly preserving where the grouped content read in the stack), then each
 * outer member folds in via setParent, which pulls its WHOLE subtree in canonically —
 * self-healing the group's cosmetic starting position even when it temporarily lands
 * inside an existing block (setParent moves by the parentId graph, not array position).
 */
export function groupParts(ids: string[], pivot: Vec2): RigPart | null {
  const doc = state.doc;
  if (!doc) return null;
  const members = doc.parts.filter((p) => ids.includes(p.id));
  const outer = members.filter((p) => !ancestorChain(p).some((a) => ids.includes(a.id)));
  if (outer.length === 0) return null;

  const parents = new Set(outer.map((p) => p.parentId));
  const parentId = parents.size === 1 ? [...parents][0] : null;
  const group = addNullPart('group', pivot, parentId);
  doc.parts = doc.parts.filter((p) => p.id !== group.id);
  const topmostIdx = Math.max(...outer.map((p) => doc.parts.indexOf(p)));
  doc.parts.splice(topmostIdx + 1, 0, group);
  for (const p of outer) setParent(p.id, group.id);
  return group;
}

/**
 * Dissolve a partless group/bone: children re-adopt its parent and absorb its rest
 * pose so nothing moves on canvas. The absorption is exact for the rest pose and for
 * keyed rotations (+= group rotation); keyed child translations are remapped through
 * the group's rigid transform — when the group is rotated and a child has tx/ty keys,
 * both tracks are resampled on the union of their key times (values exact at keys).
 * Refuses when the null itself is animated in any clip (remove its tracks first) or
 * when the part has artwork.
 *
 * CANONICAL ORDER is preserved BY CONSTRUCTION and needs no explicit fix-up: this only
 * ever removes the dissolved part's own single array slot (children keep their current
 * position, just re-parented one level up) — deleting one interior node from an already-
 * contiguous, parent-first sequence can never introduce a gap or interleave a foreign
 * subtree, on a canonical starting doc.
 */
export function ungroupPart(id: string): boolean {
  const doc = state.doc;
  const part = partById(id);
  if (!doc || !part || part.paths.length > 0) return false;
  for (const clip of doc.clips) {
    if (clip.tracks.some((t) => t.target === id && t.keyframes.length > 0)) return false;
  }

  const gr = part.rest.rotate;
  const gp = part.pivot;
  const gt = { x: part.rest.tx, y: part.rest.ty };

  for (const child of doc.parts.filter((p) => p.parentId === id)) {
    const oldRest = { tx: child.rest.tx, ty: child.rest.ty };
    // Composing two rigid poses: angles add, and the child's translation maps
    // affinely — t' = gt + A·t + k, where A rotates by the group angle and k is the
    // constant translation of R(gr,gp)·R(−gr,cp). Exact for rest AND every keyframe.
    const cp = child.pivot;
    const a = rotationMat(gr, 0, 0);
    const kMat = multiply(rotationMat(gr, gp.x, gp.y), rotationMat(-gr, cp.x, cp.y));
    const k = { x: kMat.e, y: kMat.f };
    const mapT = (x: number, y: number) => {
      const rotated = applyMat(a, x, y);
      return { x: gt.x + rotated.x + k.x, y: gt.y + rotated.y + k.y };
    };

    const newRest = mapT(oldRest.tx, oldRest.ty);
    child.rest.rotate += gr;
    child.rest.tx = newRest.x;
    child.rest.ty = newRest.y;
    child.parentId = part.parentId;

    for (const clip of doc.clips) {
      const rot = clip.tracks.find((t) => t.target === child.id && t.channel === 'rotate');
      if (rot) for (const key of rot.keyframes) key.value += gr;

      const txT = clip.tracks.find((t) => t.target === child.id && t.channel === 'tx');
      const tyT = clip.tracks.find((t) => t.target === child.id && t.channel === 'ty');
      if (!txT && !tyT) continue;

      if (gr === 0) {
        // No rotation: axes stay independent, keys just shift.
        if (txT) for (const key of txT.keyframes) key.value += gt.x + k.x;
        if (tyT) for (const key of tyT.keyframes) key.value += gt.y + k.y;
        continue;
      }
      // Rotation mixes x and y, so both channels must exist and share key times:
      // resample on the union of times (exact at every original key time).
      const times = [...new Set([
        ...(txT?.keyframes ?? []).map((key) => key.time),
        ...(tyT?.keyframes ?? []).map((key) => key.time),
      ])].sort((x, y) => x - y);
      const easingAt = (track: Track | undefined, time: number): Easing | null =>
        track?.keyframes.find((key) => key.time === time)?.easing ?? null;
      const remapped = times.map((time) => {
        const x = sampleKeyList(txT?.keyframes ?? [], time, oldRest.tx);
        const y = sampleKeyList(tyT?.keyframes ?? [], time, oldRest.ty);
        const p = mapT(x, y);
        return {
          time, x: p.x, y: p.y,
          ex: easingAt(txT, time) ?? easingAt(tyT, time) ?? ('easeInOut' as Easing),
          ey: easingAt(tyT, time) ?? easingAt(txT, time) ?? ('easeInOut' as Easing),
        };
      });
      const writeTrack = (channel: Channel, existing: Track | undefined, pick: 'x' | 'y') => {
        const keyframes = remapped.map((r) => ({
          time: r.time, value: r[pick], easing: pick === 'x' ? r.ex : r.ey,
        }));
        if (existing) existing.keyframes = keyframes;
        else clip.tracks.push({ target: child.id, channel, keyframes });
      };
      writeTrack('tx', txT, 'x');
      writeTrack('ty', tyT, 'y');
    }
  }

  doc.parts = doc.parts.filter((p) => p !== part);
  for (const clip of doc.clips) {
    clip.tracks = clip.tracks.filter((t) => t.target !== id);
  }
  if (state.selectedPartId === id) selectPart(null);
  return true;
}
