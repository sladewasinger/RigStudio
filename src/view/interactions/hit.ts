/**
 * HitContext resolution: the pointerdown router calls `resolveHit` exactly ONCE per
 * press and every pipeline's `claim()` reads from the result instead of re-sniffing
 * `ev.target`/`dataset` itself — kills the per-branch re-sniffing the old cascade did
 * (each `if` re-cast `ev.target as Element`, re-ran `closest()`, re-read `dataset`).
 *
 * Deliberately PURE (no selection/doc mutation): `part`/`pivotPart` are raw id lookups
 * only — the group-aware substitution a click into a closed group needs (walking
 * `ancestorChain` against `ctx.enteredGroups`) is business logic specific to the
 * artwork pipeline, not a generic "what did we hit" fact, so it stays in
 * `pipelines/artwork.ts`.
 */

import { RigDoc, RigPart, state } from '../../core/model';

export interface HitNode {
  pathId: string;
  cmdIndex: number;
  field: 'x' | 'x1' | 'x2';
}

export interface HitContext {
  ev: PointerEvent;
  target: Element;
  doc: RigDoc;

  /** Transform-gizmo translate affordance: 'x' | 'y' | 'xy' | null (raw dataset value). */
  gizmoAxis: string | null;
  /** Transform-gizmo rotate ring (data-role="gizmo-ring"), shared by the unified
   *  select-tool gizmo and the dedicated translate/rotate tool gizmo. */
  isGizmoRing: boolean;
  /** Bone tip reshape handle (data-role="bone-tip"). */
  isBoneTip: boolean;

  /** Setup handle-set: corner/side SCALE handle (data-handle="nw"|"n"|...). */
  scaleHandle: string | null;
  /** Setup handle-set: side SKEW handle (data-skew-side="n"|"e"|"s"|"w"). */
  skewSide: string | null;
  /** Setup/Animate handle-set: corner ROTATE handle (data-role="rotate-handle"). */
  isRotateHandle: boolean;

  /** Node endpoint/control-handle (data-role="node"), or null off a node. */
  node: HitNode | null;

  /** Freeze joint marker element (closest [data-role="pivot"]), or null. */
  pivotEl: Element | null;
  /** Raw part lookup from `pivotEl`'s data-part-id (no group substitution). */
  pivotPart: RigPart | null;

  /** Closest ancestor carrying data-part-id (artwork/bone/group glyph), or null. */
  partEl: SVGGElement | null;
  /** Raw part lookup from `partEl`'s data-part-id (no group substitution). */
  part: RigPart | null;
}

/** Resolve one pointerdown's HitContext, or null when there's no open document (the
 *  router's whole-cascade guard, mirroring the old file's `if (!doc) return`). */
export function resolveHit(ev: PointerEvent): HitContext | null {
  const doc = state.doc;
  if (!doc) return null;
  const target = ev.target as Element;
  const svgTarget = target instanceof SVGElement ? target : null;

  const nodeEl = svgTarget?.dataset.role === 'node' ? svgTarget : null;
  const pivotEl = target.closest('[data-role="pivot"]') as SVGElement | null;
  const partEl = target.closest('[data-part-id]') as SVGGElement | null;

  return {
    ev,
    target,
    doc,
    gizmoAxis: svgTarget?.dataset.gizmoAxis ?? null,
    isGizmoRing: svgTarget?.dataset.role === 'gizmo-ring',
    isBoneTip: svgTarget?.dataset.role === 'bone-tip',
    scaleHandle: svgTarget?.dataset.handle ?? null,
    skewSide: svgTarget?.dataset.skewSide ?? null,
    isRotateHandle: svgTarget?.dataset.role === 'rotate-handle',
    node: nodeEl
      ? {
          pathId: nodeEl.dataset.pathId!,
          cmdIndex: Number(nodeEl.dataset.cmdIndex),
          field: nodeEl.dataset.field as 'x' | 'x1' | 'x2',
        }
      : null,
    pivotEl,
    pivotPart: pivotEl ? doc.parts.find((p) => p.id === pivotEl.dataset.partId) ?? null : null,
    partEl,
    part: partEl ? doc.parts.find((p) => p.id === partEl.dataset.partId) ?? null : null,
  };
}
