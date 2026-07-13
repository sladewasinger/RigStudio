// ---- Structural edits: AI rig changes, delete/duplicate, draw order ----

import { RigPart, Vec2 } from './docTypes';
import { selectedPart, selectPart, state } from './appState';
import { addNullPart, partById, setParent } from './partHierarchy';
import { isUsableBoneTip } from './boneOps';
import { freshId } from './idGen';

/** Structural edits the AI assistant may request (opt-in). */
export interface RigChanges {
  addBones: {
    label: string;
    pivot: Vec2;
    parent: string | null;
    /**
     * Bone tip (Bones 2.0), in the same frame as `pivot` — mirrors how interactive
     * placement stores `RigPart.boneTip` (see `view/interactions.ts`'s commitBone):
     * both fields go through the identical parent-chain conversion, so passing `pivot`
     * and `tip` straight through here (as this function already did for `pivot`) keeps
     * them consistent with each other. Omitted/null = a partless joint with no visible
     * length (fine for a plain reparent target; auto-bind needs a real tip to form a
     * segment).
     */
    tip?: Vec2 | null;
    /**
     * Part LABELS to auto-bind (LBS skin) to this bone's full chain once created. Model
     * layer only carries the request through — binding needs the live canvas (baking
     * geometry into the bind pose), so it is applied by the caller (panels/ai.ts) via
     * the view facade's bindPartsToBones, not here.
     */
    bindParts?: string[];
  }[];
  reparent: { part: string; parent: string | null }[];
  movePivots: { part: string; x: number; y: number }[];
}

/**
 * Apply AI structural edits by part LABEL (the AI never sees ids). Returns the
 * label → id map including newly created bones, for resolving clip targets after.
 * Invalid references and cycle-creating reparents are skipped, not fatal. Does NOT
 * apply `addBones[].bindParts` — see the RigChanges doc comment; the caller binds
 * separately once the canvas can bake geometry.
 */
export function applyRigChanges(changes: RigChanges): Map<string, string> {
  const doc = state.doc!;
  const byLabel = new Map<string, string>(doc.parts.map((p) => [p.label, p.id]));

  for (const b of changes.addBones ?? []) {
    if (byLabel.has(b.label)) continue; // labels must stay unique
    const parentId = b.parent ? (byLabel.get(b.parent) ?? null) : null;
    const bone = addNullPart('bone', b.pivot, parentId, b.label.replace(/\s+/g, '_'));
    // A degenerate requested tip (on/near its own pivot — seen from AI-generated
    // requests) is treated the same as an omitted one: boneTip stays null, the
    // already-documented "partless joint, no visible length" state, rather than
    // fabricating a length the caller never asked for.
    if (b.tip && isUsableBoneTip(b.pivot, b.tip)) bone.boneTip = { x: b.tip.x, y: b.tip.y };
    byLabel.set(bone.label, bone.id);
  }
  for (const r of changes.reparent ?? []) {
    const childId = byLabel.get(r.part);
    if (!childId) continue;
    setParent(childId, r.parent ? (byLabel.get(r.parent) ?? null) : null);
  }
  for (const m of changes.movePivots ?? []) {
    const id = byLabel.get(m.part);
    const part = id ? partById(id) : null;
    if (part) part.pivot = { x: m.x, y: m.y };
  }
  return byLabel;
}

/**
 * Delete parts (layers). Children of a deleted part re-adopt its nearest SURVIVING
 * ancestor (artwork is never deleted implicitly), the parts' tracks vanish from every
 * clip, and skin bindings (bones AND any per-node overrides pinned to them) referencing
 * deleted bones are dropped. Returns deleted ids so the canvas can unregister their
 * groups.
 */
export function deleteParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const dead = new Set(ids.filter((id) => doc.parts.some((p) => p.id === id)));
  if (dead.size === 0) return [];

  for (const part of doc.parts) {
    if (dead.has(part.id) || !part.parentId || !dead.has(part.parentId)) continue;
    let anc: RigPart | null = partById(part.parentId);
    while (anc && dead.has(anc.id)) anc = anc.parentId ? partById(anc.parentId) : null;
    part.parentId = anc?.id ?? null;
  }
  doc.parts = doc.parts.filter((p) => !dead.has(p.id));
  for (const clip of doc.clips) {
    clip.tracks = clip.tracks.filter((t) => !dead.has(t.target));
  }
  for (const part of doc.parts) {
    if (!part.skin) continue;
    part.skin.bones = part.skin.bones.filter((b) => !dead.has(b.id));
    if (part.skin.bones.length === 0) { part.skin = null; continue; }
    // A deleted bone can still be pinned by a per-node override even though it's gone
    // from skin.bones above — prune those too (mirrors normalizeDoc's dangling-ref
    // pruning, but live: this runs on an in-session mutation, not just on load).
    if (part.skin.overrides) {
      for (const pathId of Object.keys(part.skin.overrides)) {
        const rec = part.skin.overrides[pathId];
        for (const key of Object.keys(rec)) {
          const ov = rec[key];
          if (dead.has(ov.a) || (ov.b != null && dead.has(ov.b))) delete rec[key];
        }
        if (Object.keys(rec).length === 0) delete part.skin.overrides[pathId];
      }
      if (Object.keys(part.skin.overrides).length === 0) delete part.skin.overrides;
    }
  }
  if (state.selectedPartId && dead.has(state.selectedPartId)) selectPart(null);
  else state.selectedPartIds = state.selectedPartIds.filter((id) => !dead.has(id));
  return [...dead];
}

/**
 * Duplicate parts (Ctrl+D, Setup only): deep-clones each part and its paths with fresh
 * ids, keeps the same parent, and nudges the rest translation by (+12,+12) doc units so
 * the copy is visibly offset from the source. No animation tracks are copied — a fresh
 * id has none by construction, since clip tracks are keyed by target id. Skinned parts
 * are skipped (their geometry is baked to a bind pose; a naive clone would double-bind
 * the same bones). Each copy is inserted immediately after its source, so the whole
 * duplicated set stays contiguous. Returns the new parts' ids, input order preserved.
 */
export function duplicateParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const newIds: string[] = [];
  for (const id of ids) {
    const part = doc.parts.find((p) => p.id === id);
    if (!part || part.skin) continue;
    const clone: RigPart = structuredClone(part);
    clone.id = freshId('part');
    clone.label = `${part.label} copy`;
    clone.pivotHint = null;
    clone.rest.tx += 12;
    clone.rest.ty += 12;
    clone.paths = part.paths.map((p) => ({ ...structuredClone(p), id: freshId('path') }));
    const insertAt = doc.parts.indexOf(part) + 1;
    doc.parts.splice(insertAt, 0, clone);
    newIds.push(clone.id);
  }
  return newIds;
}

// ---- Draw order (z-order) ----
// doc.parts array order IS the AUTHORED paint order: last = drawn on top. The layers panel
// lists topmost first, so "up the layer list" means "later in doc.parts". On top of that,
// every part carries a keyable `z` OFFSET channel (stepped, absolute, rest 0) that lifts it
// forward/back per frame; the rendered order sorts by (effective z, doc.parts index).

/**
 * Parts in paint order for a given effective-z map: sorted by (z ascending, doc.parts index
 * ascending). PURE and STABLE — equal z preserves authored order, so an all-zero z map
 * returns exactly `parts` order (an unkeyed doc renders byte-identically to the pre-z-channel
 * behavior). render.ts feeds this the per-frame effective z (view/pose.ts's `effectiveZ`);
 * keeping the rule here makes it a single unit-testable function instead of inline DOM code.
 */
export function drawOrder(parts: RigPart[], zOf: (part: RigPart) => number): RigPart[] {
  return parts
    .map((part, i) => ({ part, z: zOf(part), i }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((e) => e.part);
}

/** Whether the current selection (entered path, else part) can move a step in z. */
export function canMoveSelectedInDrawOrder(delta: 1 | -1): boolean {
  const doc = state.doc;
  const part = selectedPart();
  if (!doc || !part) return false;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    return i >= 0 && i + delta >= 0 && i + delta < part.paths.length;
  }
  const i = doc.parts.indexOf(part);
  return i + delta >= 0 && i + delta < doc.parts.length;
}

/** Move the entered path (within its part) or the selected part one z step (+1 = up). */
export function moveSelectedInDrawOrder(delta: 1 | -1): boolean {
  if (!canMoveSelectedInDrawOrder(delta)) return false;
  const doc = state.doc!;
  const part = selectedPart()!;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    [part.paths[i], part.paths[i + delta]] = [part.paths[i + delta], part.paths[i]];
  } else {
    const i = doc.parts.indexOf(part);
    [doc.parts[i], doc.parts[i + delta]] = [doc.parts[i + delta], doc.parts[i]];
  }
  return true;
}

/**
 * Drop a part just above/below another in the layers tree: it draws immediately on
 * top of ('above') or beneath ('below') `refId` and becomes its sibling — adopting
 * ref's parent, like dropping between rows in any layer tree. Refuses when adopting
 * that parent would create a cycle.
 */
export function movePartRelativeTo(
  partId: string, refId: string, place: 'above' | 'below',
): boolean {
  const doc = state.doc;
  if (!doc || partId === refId) return false;
  const part = partById(partId);
  const ref = partById(refId);
  if (!part || !ref) return false;
  if (ref.parentId !== part.parentId && !setParent(partId, ref.parentId)) return false;
  doc.parts.splice(doc.parts.indexOf(part), 1);
  const refIdx = doc.parts.indexOf(ref);
  doc.parts.splice(place === 'above' ? refIdx + 1 : refIdx, 0, part);
  return true;
}
