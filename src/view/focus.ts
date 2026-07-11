/**
 * Drill-down focus and artwork hit-testing.
 *
 * "Entered" groups (double-click drill-down) and node editing narrow the editing
 * context; parts outside it dim and stop catching clicks (renderPose applies the
 * class). Clicking through a faded part falls to blank canvas, which exits focus.
 */

import { state, RigPart, selectedPart, selectPart, ancestorChain, partById } from '../core/model';
import { ctx } from './context';

/** Escape/blank-click hook: close all entered groups. */
export function clearGroupEntry(): void {
  ctx.enteredGroups.clear();
}

/**
 * The deepest currently-entered group (the one with the longest ancestor chain).
 * Dives are strictly nested — dimming + click-through prevents entering a group whose
 * parent isn't entered — so "deepest" is the innermost dive level. `enterGroupsFor`
 * can add several at once, so depth (not insertion order) is the reliable key.
 */
export function innermostEnteredGroup(): RigPart | null {
  const doc = state.doc;
  if (!doc) return null;
  let best: RigPart | null = null;
  let bestDepth = -1;
  for (const id of ctx.enteredGroups) {
    const g = doc.parts.find((p) => p.id === id);
    if (!g) continue;
    const depth = ancestorChain(g).length;
    if (depth > bestDepth) { bestDepth = depth; best = g; }
  }
  return best;
}

/** Leave the innermost entered group (one dive level). Returns false if none entered. */
export function popEnteredGroup(): boolean {
  const g = innermostEnteredGroup();
  if (!g) return false;
  ctx.enteredGroups.delete(g.id);
  return true;
}

/**
 * One-level "step out", shared by Escape and blank-canvas clicks (Inkscape parity):
 * leave an entered path → deselect the current object → pop the innermost entered
 * group. Each call unwinds exactly one level of drill-down so a nested dive is
 * reversed the same number of steps it was entered.
 */
export function stepOutFocus(): void {
  if (state.selectedPathId) {
    state.selectedPathId = null;
    return;
  }
  if (state.selectedPartId) {
    selectPart(null);
    return;
  }
  popEnteredGroup();
}

/**
 * The artwork part/path under the pointer, looking THROUGH overlay widgets (pivot
 * grab circles, handles, gizmos). document.elementsFromPoint returns the full stack
 * top-to-bottom; the first hit inside rootGroup is the real artwork.
 */
export function artworkUnderPointer(
  ev: MouseEvent,
): { part: RigPart; pathEl: SVGElement | null } | null {
  const doc = state.doc;
  if (!doc || !ctx.rootGroup) return null;
  for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
    if (!ctx.rootGroup.contains(el)) continue;
    const partEl = (el as Element).closest('[data-part-id]') as SVGGElement | null;
    const part = doc.parts.find((p) => p.id === partEl?.dataset.partId);
    if (part) {
      const pathEl = (el as SVGElement).dataset?.pathId ? (el as SVGElement) : null;
      return { part, pathEl };
    }
  }
  return null;
}

/**
 * Which parts are "in focus" while drilling: node editing focuses the edited part;
 * entered groups focus their subtrees. Everything else dims and stops catching
 * clicks (renderPose applies the class), so drags over faded artwork rubber-band
 * nodes instead of selecting parts, and a click on faded artwork falls through to
 * blank canvas — which exits the focus, Inkscape-style. Null = nothing dimmed.
 */
export function focusContext(): Set<string> | null {
  const part = selectedPart();
  if (state.mode === 'nodes' && state.editorMode === 'setup' && part) {
    return new Set([part.id]);
  }
  if (ctx.enteredGroups.size > 0) {
    const doc = state.doc!;
    const focus = new Set<string>();
    for (const p of doc.parts) {
      if (ctx.enteredGroups.has(p.id) || ancestorChain(p).some((a) => ctx.enteredGroups.has(a.id))) {
        focus.add(p.id);
      }
    }
    return focus;
  }
  return null;
}

/**
 * Open every group above a part (Layers-panel selection does this so a part picked
 * in the tree is immediately draggable on canvas instead of re-selecting its group).
 */
export function enterGroupsFor(partId: string): void {
  const part = partById(partId);
  if (!part) return;
  for (const a of ancestorChain(part)) {
    if (a.kind === 'group') ctx.enteredGroups.add(a.id);
  }
}
