/**
 * Per-node skin weight overrides (Bones 2.0 manual refinement): the inspector's
 * node-binding editor pins a node's blend to specific bones on top of the auto weights
 * computed from bind-time distance. Split out of rigOps.ts (CLAUDE.md "Small, focused
 * files"); shares its layer (may reach render.ts/partDom.ts/skinRender.ts, never
 * interactions.ts or higher).
 */

import { state, selectedPart, chainBonesOfPart, RigPart, SkinOverride } from '../core/model';
import { ctx, parseNodeKey } from './context';
import { invalidateSkinCache } from './skinRender';
import { renderPose } from './render';
import { bindPartsToBones } from './rigOpsBind';

export interface NodeBindingInfo {
  pathId: string;
  cmdIndex: number;
  override: SkinOverride | null;
}

/** The primary selected node's current binding (auto vs override), for the inspector. */
export function primaryNodeBinding(): NodeBindingInfo | null {
  const part = selectedPart();
  if (!part?.skin || !ctx.selectedNode) return null;
  const { pathId, cmdIndex } = ctx.selectedNode;
  const ov = part.skin.overrides?.[pathId]?.[String(cmdIndex)];
  return { pathId, cmdIndex, override: ov ? { ...ov } : null };
}

/**
 * Set every selected node's bone-CARRY: bone `a` at (1−t) blended with bone `b` at t
 * (b null = 100% a). Both ids must reference the part's bound bones. Each node's own
 * PIN fraction (independent, see SkinOverride's doc comment) is preserved as-is — this
 * only touches which bone(s) carry the node, never whether it's held toward rest.
 * Caller checkpoints.
 */
export function setNodeBinding(a: string, b: string | null, t: number): boolean {
  const part = selectedPart();
  if (!part?.skin || ctx.selectedNodes.size === 0) return false;
  const boneIds = new Set(part.skin.bones.map((bb) => bb.id));
  if (!boneIds.has(a)) return false;
  const bb = b && b !== a && boneIds.has(b) ? b : null;
  const overrides = part.skin.overrides ?? (part.skin.overrides = {});
  const value: SkinOverride = { a, b: bb, t: Math.min(1, Math.max(0, t)) };
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const rec = overrides[pathId] ?? (overrides[pathId] = {});
    const prevPin = rec[String(cmdIndex)]?.pin;
    rec[String(cmdIndex)] = prevPin !== undefined ? { ...value, pin: prevPin } : { ...value };
  }
  invalidateSkinCache(part.id);
  renderPose();
  return true;
}

/**
 * Set every selected node's PIN-TO-REST fraction (0..1) — independent of the bone-CARRY
 * override above; preserves each node's own a/b/t if it has one. `pin <= 0` on a node
 * with no bone-carry override (`a: null`) drops the now-empty entry entirely rather than
 * leaving a degenerate `{a:null,pin:0}` on the doc; a node WITH a bone-carry override
 * just loses its `pin` field (the override itself survives). Caller checkpoints. Returns
 * whether anything actually changed (so a no-op "apply pin" costs no undo step).
 */
export function setNodePin(pin: number): boolean {
  const part = selectedPart();
  if (!part?.skin || ctx.selectedNodes.size === 0) return false;
  const clamped = Math.min(1, Math.max(0, pin));
  const overrides = part.skin.overrides ?? (part.skin.overrides = {});
  let changed = false;
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const rec = overrides[pathId];
    const cur = rec?.[String(cmdIndex)];
    if (clamped <= 0) {
      if (!cur) continue;
      if (cur.a == null) {
        delete rec![String(cmdIndex)];
        if (Object.keys(rec!).length === 0) delete overrides[pathId];
      } else {
        delete cur.pin;
      }
      changed = true;
      continue;
    }
    const target = overrides[pathId] ?? (overrides[pathId] = {});
    target[String(cmdIndex)] = cur ? { ...cur, pin: clamped } : { a: null, b: null, t: 0, pin: clamped };
    changed = true;
  }
  if (Object.keys(overrides).length === 0) delete part.skin.overrides;
  if (changed) {
    invalidateSkinCache(part.id);
    renderPose();
  }
  return changed;
}

/**
 * The (a,b,t) override target for the node-editing "bind to bone…" quick action: bone
 * `boneId` plus which of ITS ends the selected nodes sit at — its origin (the joint
 * shared with its parent) or its tip (the joint shared with its child). `a` is always
 * the picked bone; `b` is the neighbor bone on that side WITHIN the part's own chain, or
 * null when none exists there (a chain root has no parent bone; a leaf has no child) —
 * `overrideWeightRow` collapses a null `b` to 100% `a` regardless of `t`, so that case is
 * "100% single-bone" automatically. When a neighbor does exist, t=0.5 blends evenly
 * across the shared joint (refinable afterward with the inspector's existing % slider).
 */
export function quickNodeBindTarget(
  part: RigPart, boneId: string, end: 'origin' | 'tip',
): { a: string; b: string | null; t: number } | null {
  const chain = chainBonesOfPart(state.doc?.parts ?? [], part);
  const x = chain.find((b) => b.id === boneId);
  if (!x) return null;
  const neighbor = end === 'tip'
    ? chain.find((b) => b.parentId === x.id) ?? null
    : chain.find((b) => b.id === x.parentId) ?? null;
  return { a: x.id, b: neighbor?.id ?? null, t: neighbor ? 0.5 : 0 };
}

/**
 * Node-editing "bind to bone…" (replaces the old top-bar whole-part bind button):
 * selecting a bone tip/origin ALONGSIDE node selection is structurally impossible (node
 * mode's pointerdown routing claims every canvas click for bend/marquee before a part
 * selection could land — `interactions.ts`), so this always drives the picker dialog
 * rather than trying a "co-selected bone" fast path. If `part` isn't already skinned by
 * its own chain, this binds it first (the whole-part bind stays available
 * PROGRAMMATICALLY — `bindPartsToBones`, which auto-bind also calls — just not from a
 * toolbar button any more), then pins every selected node per `quickNodeBindTarget`.
 * Caller checkpoints.
 */
export function bindSelectedNodesToBone(
  part: RigPart, boneId: string, end: 'origin' | 'tip',
): boolean {
  const chain = chainBonesOfPart(state.doc?.parts ?? [], part);
  if (chain.length === 0 || ctx.selectedNodes.size === 0) return false;
  if (!part.skin) bindPartsToBones([part], chain);
  const target = quickNodeBindTarget(part, boneId, end);
  if (!target) return false;
  return setNodeBinding(target.a, target.b, target.t);
}

/** Clear per-node overrides on every selected node (caller checkpoints). */
export function clearNodeBinding(): boolean {
  const part = selectedPart();
  const overrides = part?.skin?.overrides;
  if (!part || !overrides || ctx.selectedNodes.size === 0) return false;
  let changed = false;
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const rec = overrides[pathId];
    if (rec && String(cmdIndex) in rec) {
      delete rec[String(cmdIndex)];
      changed = true;
      if (Object.keys(rec).length === 0) delete overrides[pathId];
    }
  }
  if (Object.keys(overrides).length === 0) delete part.skin!.overrides;
  if (changed) {
    invalidateSkinCache(part.id);
    renderPose();
  }
  return changed;
}

/** Drop ALL per-node overrides on the selected part ("recompute auto weights"). */
export function resetNodeBindings(): boolean {
  const part = selectedPart();
  if (!part?.skin?.overrides) return false;
  delete part.skin.overrides;
  invalidateSkinCache(part.id);
  renderPose();
  return true;
}

/**
 * Recompute auto weights for the selected skinned part: drop any per-node overrides and
 * rebuild the runtime weight cache from the current bones. Enabled whenever the part is
 * skinned (the inspector button used to gray out unless overrides existed — the reported
 * "always disabled" bug). Returns whether overrides were actually dropped, so the caller
 * only spends an undo step when the doc changed.
 */
export function recomputeAutoWeights(): boolean {
  const part = selectedPart();
  if (!part?.skin) return false;
  const hadOverrides = !!part.skin.overrides;
  if (hadOverrides) delete part.skin.overrides;
  invalidateSkinCache(part.id);
  renderPose();
  return hadOverrides;
}
