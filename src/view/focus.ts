/**
 * Drill-down focus and artwork hit-testing.
 *
 * "Entered" groups (double-click drill-down) and node editing narrow the editing
 * context; parts outside it dim and stop catching clicks (renderPose applies the
 * class). Clicking through a faded part falls to blank canvas, which exits focus.
 */

import {
  state, RigPart, selectedPart, selectedParts, selectPart, ancestorChain, partById,
  chainBonesOfPart, isGroupLike,
} from '../core/model';
import { ctx } from './context';

/** Escape/blank-click hook: close all entered groups. */
export function clearGroupEntry(): void {
  ctx.enteredGroups.clear();
}

/**
 * Doc-replace hook (main.ts's afterDocReplaced, the SINGLE doc-swap path incl.
 * loadProjectText/New/Open/Load-sample): every piece of session-only editing state
 * below can reference a part/path id from the OLD document, or sit mid-gesture over
 * DOM elements buildCanvas is about to discard wholesale. A stale SELECTION id is
 * cosmetic (selectedPart()/selectedParts() already resolve a miss to "nothing"), but a
 * stale node/handle SELECTION, an armed bone placement, or an in-flight drag object is
 * not — it is read by the very next pointer/render pass against the NEW doc. Resets
 * every such flag so a doc swap always lands in a clean, fully interactive state
 * (confirmed live bug: node mode + a selected path id surviving Load Sample into the
 * fresh doc). `enteredGroups` is intentionally NOT touched here — callers pair this
 * with clearGroupEntry() (already a separate, reusable Escape/blank-click hook).
 */
export function resetInteractionState(): void {
  ctx.selectedNodes.clear();
  ctx.selectedNode = null;
  ctx.placingBone = false;
  ctx.boneChain = null; // an in-progress pen-tool chain must not survive a doc swap/reset
  ctx.drag = null;
  ctx.handleMode = 'scale';
  ctx.handlePartId = null;
  ctx.snapMarker = null;
  if (ctx.svg) ctx.svg.style.cursor = '';
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
  repairEnteredGroups();
  const part = selectedPart();
  if (state.mode === 'nodes' && state.editorMode === 'setup' && part) {
    // Bones of the edited part's own chain are its binding context, not "everything
    // else" — they stay fully visible/selectable while every other part dims.
    const focus = new Set([part.id]);
    for (const b of chainBonesOfPart(state.doc?.parts ?? [], part)) focus.add(b.id);
    return focus;
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
 * The skinned part, if any, whose LBS deformation should be SUSPENDED this frame: node
 * editing on a bound part edits `path.d` — its baked BIND/rest geometry — but per-frame
 * skinning normally overwrites the rendered `d` with the deformed pose, so handles
 * (computed straight from `path.d`) and the drawn art would coincide only by accident
 * (the reported bug — a drag temporarily aligned them, release diverged again). Render
 * that one part through the normal rigid path instead (`render.ts`) for as long as it's
 * the node-editing target; every other skinned part keeps deforming normally.
 */
export function nodeEditSkinSuspendId(): string | null {
  if (state.mode !== 'nodes' || state.editorMode !== 'setup') return null;
  const part = selectedPart();
  return part?.skin ? part.id : null;
}

/**
 * Open every group above a part (Layers-panel selection does this so a part picked
 * in the tree is immediately draggable on canvas instead of re-selecting its group).
 */
export function enterGroupsFor(partId: string): void {
  const part = partById(partId);
  if (!part) return;
  const parts = state.doc?.parts ?? [];
  for (const a of ancestorChain(part)) {
    if (isGroupLike(a, parts)) ctx.enteredGroups.add(a.id);
  }
}

/**
 * Self-healing chokepoint for the reported "Ctrl+G leaves the canvas dimmed" bug: no
 * structural mutation (group/ungroup/delete/reparent — deliberately none of them know
 * `enteredGroups` exists, since it is view-layer editing-SESSION state, not doc state)
 * clears or repairs it. Run this on every `focusContext()` call instead, so no future
 * structural op can strand dimming:
 *  - drop any entered id whose part no longer exists (ungrouped/deleted — the DOC was
 *    correct, the SESSION reference went stale);
 *  - drop any entered id that is not a STRICT ancestor of at least one currently
 *    SELECTED part — but only when something IS selected, so the deliberate
 *    "dive in, select nothing" state (dblclick drill-down) is never disturbed.
 * The strict-ancestor rule means an entered group that becomes a SELECTED part ITSELF
 * pops its own entry (user bug 2026-07-14, "clicking the selected Girl group again just
 * selects the child Body"): "open to work inside" and "selected as a whole to
 * manipulate" are contradictory states — while a group stayed both, the artwork
 * pipeline's group substitution was suppressed by the entry, so every canvas click
 * stole the selection down to the child under the cursor and the second-click handle
 * toggle (rotate corners) was unreachable. Selecting the whole group (Layers row,
 * context menu, canvas substitution alike — this repair is the one chokepoint they all
 * render through) expresses the manipulate-as-a-unit intent, so the entry closes.
 * This also gives the least-surprising UX for "group while entered" without any
 * structural-op call site needing to know this repair exists: grouping members that
 * live INSIDE the entered group nests the new group there too (still an ancestor of
 * the new selection, so entry is naturally preserved); grouping members from OUTSIDE
 * it pops back out to whichever entered id (if any) still encloses the result.
 */
function repairEnteredGroups(): void {
  const doc = state.doc;
  if (!doc || ctx.enteredGroups.size === 0) return;
  for (const id of [...ctx.enteredGroups]) {
    if (!doc.parts.some((p) => p.id === id)) ctx.enteredGroups.delete(id);
  }
  const selected = selectedParts();
  if (selected.length === 0) return;
  for (const id of [...ctx.enteredGroups]) {
    // ancestorChain never contains the part itself, so this is the strict-ancestor
    // test: a selected part that IS the entered group keeps nothing alive.
    const relevant = selected.some(
      (sp) => ancestorChain(sp).some((a) => a.id === id),
    );
    if (!relevant) ctx.enteredGroups.delete(id);
  }
}
