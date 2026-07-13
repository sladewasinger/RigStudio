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

/** Reparent a part; refuses cycles. Returns whether the change was applied. */
export function setParent(childId: string, parentId: string | null): boolean {
  const child = partById(childId);
  if (!child) return false;
  if (parentId === null) {
    child.parentId = null;
    return true;
  }
  if (parentId === childId) return false;
  const parent = partById(parentId);
  if (!parent) return false;
  if (isAncestorOf(child, parent)) return false; // would create a cycle
  child.parentId = parentId;
  return true;
}

// ---- Bones, groups, structural edits ----

/** Create a partless bone/group part. Bones are the joints of multi-joint chains. */
export function addNullPart(
  kind: 'bone' | 'group', pivot: Vec2, parentId: string | null, label?: string,
): RigPart {
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
  state.doc!.parts.push(part);
  return part;
}

/**
 * Wrap the outermost of the given parts in a new group null pivoted at `pivot`.
 * Members whose ancestor is also selected stay attached to that ancestor. The group
 * adopts the members' common parent (or none) and slots in just above them in draw
 * order.
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
  // addNullPart pushed it last; move it just above the topmost member instead.
  doc.parts.pop();
  const insertAt = Math.max(...outer.map((p) => doc.parts.indexOf(p))) + 1;
  doc.parts.splice(insertAt, 0, group);
  for (const p of outer) p.parentId = group.id;
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
