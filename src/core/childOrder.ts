// ---- Unified child ordering (U1): the childOrder slot CHOKEPOINT ----
//
// `RigPart.childOrder` (`ChildSlot[]`) is a part's own paths and direct child parts as
// ONE ordered, interleaved list (see the field's doc comment in docTypes.ts). This
// module is the ONLY place that may write it — every structural mutation elsewhere
// (core/partHierarchy.ts, core/structuralOps.ts, and the two path-mutating sites outside
// core/ — view/rigOpsEdit.ts's movePathToPart, ui/pathActions.ts's deletePathFromPart)
// routes through the helpers below instead. Enforced by childOrderChokepoint.test.ts
// (grep-based, mirrors nodeEditingChokepoint.test.ts).
//
// LAZY BY DEFAULT: a part's `childOrder` stays absent until `normalizeDoc` first
// synthesizes it (`reconcileChildOrder` below, called per part from serialization.ts).
// Every ADD/REMOVE helper is a no-op on a part whose `childOrder` is still absent — that
// preserves "legacy docs are semantically unchanged" (their implicit order, own-paths-
// then-children, is correct either way) without forcing every in-session mutation
// (including ones on a freshly-imported, never-normalized doc) to eagerly materialize a
// list nothing reads yet. Once a doc HAS been normalized (Save, or any MCP/headless
// entry point), every part in it carries a `childOrder`, and these helpers — plus
// `reconcileChildOrder`, reused as each mutation's correctness backstop — keep the whole
// doc in sync from then on. A part CREATED mid-session (`addNullPart`, `duplicateParts`)
// rejoins that regime IMMEDIATELY via `seedChildOrderIfActive` when the doc already uses
// one (a container part's own list must exist from birth, or its children's later
// `slotAddChild` calls would silently no-op against it — see that function's doc
// comment); on a never-normalized doc it stays absent, same as everything else. ONE
// deliberate exception to laziness (U4): the SVG importer materializes every part's
// childOrder at birth via `beginExplicitChildOrder` + the add helpers, because a fresh
// import carries true DOCUMENT-ORDER interleaving the paths-first synthesis could never
// reconstruct after the fact — old saved projects never touch that path and stay lazy.
//
// TWO SOURCES OF TRUTH, ONE PER SLOT KIND (U1 spec rule 4): `doc.parts` sibling order
// stays the DFS pre-order authority for PART-vs-PART order (CLAUDE.md "doc.parts order
// is CANONICAL") and `RigPath[]` order stays the authority for PATH-vs-PATH order
// (mirrors the same rule) — `childOrder` only additionally records where each kind's
// slots sit RELATIVE TO EACH OTHER (the interleaving that neither authority can express
// alone, and the entire point of U1). A childOrder-mutating op therefore never
// reorders `doc.parts`/`paths[]` itself; it only ever mirrors them. (ONE deliberate,
// documented inversion: U4's `core/slotReorder.ts` — a Layers-row reorder gesture is
// authored in SLOT space, so there the slot list moves first and the two authorities
// are re-derived to agree; see that module's header.) For sites where the
// correct SLOT POSITION is directly known (a brand-new part/path is always appended,
// setParent's target is always "new topmost child" — see each call site) the five named
// primitives below are used directly. For sites that reposition potentially several
// siblings AT ONCE relative to `doc.parts`/`paths[]` (groupParts' cosmetic starting
// slot, duplicateParts' insert-after-source, movePartRelativeTo's above/below drop, the
// z-order subtree-block swap) precise incremental index math would have to duplicate
// doc.parts' own splice logic — instead those sites call `reconcileChildOrder` again
// afterward, which re-derives each kind's relative order fresh from the (by-then
// finalized) `doc.parts`/`paths[]` truth. Both paths converge on the same invariant;
// `childOrderAgreesWithCanonicalPartOrder` below is the ORDER half of the test coverage,
// `isChildOrderCoherent` the SET half.
//
// KNOWN GAP (documented, not silently missed): `view/nodeEditing/structural.ts`'s
// `applyStructuralEdit` chokepoint can add/remove whole `RigPath` objects (segment
// delete splitting one path into two; join merging two into one) without routing
// through here — it is a separate, already-locked-down chokepoint (its own enforcement
// test) outside this wave's audited site list. A part touched that way keeps a STALE
// `childOrder` (extra/missing path slots) until the next `normalizeDoc` call repairs it
// via `reconcileChildOrder`'s dangling-drop/missing-append pass — self-healing, and
// inconsequential in U1 since nothing reads `childOrder` yet. Flagged for whoever wires
// U2's renderer to childOrder: route that chokepoint too, or accept the staleness window.

import { ChildSlot, RigPart } from './docTypes';

function slotIndexOf(order: ChildSlot[], kind: ChildSlot['kind'], id: string): number {
  return order.findIndex((s) => s.kind === kind && s.id === id);
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

/**
 * Whether ANY part in `parts` already carries a `childOrder` — the doc-wide signal
 * `addNullPart`/`duplicateParts` use to decide whether a BRAND-NEW part should join the
 * regime immediately (eagerly correct from birth: an empty/fresh-paths-only list) rather
 * than staying absent like the rest of a never-normalized doc. Without this, a part
 * created mid-session on an already-normalized doc (e.g. `groupParts`' new group, whose
 * children arrive via repeated `slotAddChild` calls as each member is absorbed) would
 * never accumulate a childOrder at all — `slotAddChild` is a no-op against an absent
 * list, so the doc would silently regress from "every part has one" the moment any
 * container part is created. Cheap (short-circuiting scan over a typically-small array).
 */
export function docUsesChildOrder(parts: RigPart[]): boolean {
  return parts.some((p) => p.childOrder !== undefined);
}

/**
 * Give a BRAND-NEW part (no children of its own; `pathIds` lets a caller like
 * duplicateParts seed its own fresh path ids in order) a `childOrder` IMMEDIATELY when
 * the doc already uses one (`docUsesChildOrder`), so it joins the regime from birth
 * instead of leaving a gap until the next `normalizeDoc` call — see that function's own
 * doc comment for why the gap matters. Leaves `childOrder` absent on a doc that has
 * never been normalized (LAZY rule). Used by `addNullPart` (no paths — `pathIds`
 * defaults to none) and `duplicateParts` (its clone's fresh path ids, stale
 * structuredClone copy discarded).
 */
export function seedChildOrderIfActive(part: RigPart, allParts: RigPart[], pathIds: string[] = []): void {
  if (!docUsesChildOrder(allParts)) { delete part.childOrder; return; }
  part.childOrder = pathIds.map((id): ChildSlot => ({ kind: 'path', id }));
}

/**
 * Begin an EXPLICIT, initially-empty `childOrder` on a brand-new part whose slots the
 * caller is about to record in true discovery order via `slotAddPath`/`slotAddChild`
 * (U4: `io/importSvg.ts` — the importer walks an SVG group's children in DOCUMENT order
 * and appends a slot per child as it goes, so the recorded interleaving is exactly the
 * authored stacking, killing the paths-first import approximation). This deliberately
 * OVERRIDES the LAZY rule for the part it is called on: an imported doc carries real
 * document-order information the synthesis could never reconstruct, so it must be
 * materialized at birth — old SAVED projects never pass through here and stay lazy.
 * Unconditional (unlike `seedChildOrderIfActive`): the importer builds a whole doc from
 * scratch, so there is no pre-existing regime to defer to.
 */
export function beginExplicitChildOrder(part: RigPart): void {
  part.childOrder = [];
}

/** Add a PATH slot to `part.childOrder`, if present (no-op otherwise — see the file
 *  header's LAZY rule). Default position = end (topmost within the part), matching a
 *  freshly appended `RigPath`. A no-op if the slot already exists (idempotent). */
export function slotAddPath(part: RigPart, pathId: string, index?: number): void {
  if (!part.childOrder) return;
  if (slotIndexOf(part.childOrder, 'path', pathId) >= 0) return;
  const at = index === undefined ? part.childOrder.length : clampIndex(index, part.childOrder.length);
  part.childOrder.splice(at, 0, { kind: 'path', id: pathId });
}

/** Remove a PATH slot from `part.childOrder`, if present. A no-op if the slot doesn't
 *  exist. */
export function slotRemovePath(part: RigPart, pathId: string): void {
  if (!part.childOrder) return;
  const i = slotIndexOf(part.childOrder, 'path', pathId);
  if (i >= 0) part.childOrder.splice(i, 1);
}

/** Add a child-PART slot to `parent.childOrder`, if present. Default position = end
 *  (topmost), matching `addNullPart`'s/`setParent`'s "new topmost child" placement. A
 *  no-op if the slot already exists (idempotent). */
export function slotAddChild(parent: RigPart, childId: string, index?: number): void {
  if (!parent.childOrder) return;
  if (slotIndexOf(parent.childOrder, 'part', childId) >= 0) return;
  const at = index === undefined ? parent.childOrder.length : clampIndex(index, parent.childOrder.length);
  parent.childOrder.splice(at, 0, { kind: 'part', id: childId });
}

/** Remove a child-PART slot from `parent.childOrder`, if present. A no-op if the slot
 *  doesn't exist. */
export function slotRemoveChild(parent: RigPart, childId: string): void {
  if (!parent.childOrder) return;
  const i = slotIndexOf(parent.childOrder, 'part', childId);
  if (i >= 0) parent.childOrder.splice(i, 1);
}

/**
 * Relocate an EXISTING slot (path or part — ids are unique doc-wide, so identifying by
 * id alone is unambiguous) to `toIndex` within `parent.childOrder`, if present. `toIndex`
 * is interpreted in POST-REMOVAL index space (i.e. it targets the final resting index,
 * the same convention `Array.prototype.splice` implies once the moved item is already
 * out of the way) and is clamped to the list's post-removal bounds. A no-op if
 * `childOrder` is absent or the slot isn't found. No U1 mutation site happens to need
 * this directly (the multi-slot repositioning cases route through `reconcileChildOrder`
 * instead — see the file header) but it is exercised directly by childOrder.test.ts and
 * kept as a primary primitive for later waves.
 */
export function slotMoveWithin(parent: RigPart, slotId: string, toIndex: number): void {
  if (!parent.childOrder) return;
  const i = parent.childOrder.findIndex((s) => s.id === slotId);
  if (i < 0) return;
  const [slot] = parent.childOrder.splice(i, 1);
  const at = clampIndex(toIndex, parent.childOrder.length);
  parent.childOrder.splice(at, 0, slot);
}

/**
 * Reassign WHICH id occupies each existing `kind`-slot POSITION within `order`, in
 * `wantOrder` sequence, dropping any `kind`-slot whose id isn't in `wantOrder` (dangling)
 * and appending any `wantOrder` id that had no existing slot (missing) at the end of the
 * `kind` run. Slots of the OTHER kind, and the overall interleaving, are left untouched —
 * this only ever changes the sequence in which `kind` shows up. The shared engine behind
 * `reconcileChildOrder`'s two passes (path kind, then part kind); see that function. Also
 * reused directly by `core/paintOrder.ts` (U2) for the Animate-mode keyed-`z` PART-slot
 * resort — z-sorting a part's children is exactly "reassign which id occupies each
 * existing 'part'-slot position, in z order" instead of doc.parts order, so it needs the
 * identical dangling/missing safety net this already provides.
 */
export function reassignKindOrder(order: ChildSlot[], kind: ChildSlot['kind'], wantOrder: string[]): ChildSlot[] {
  const wantSet = new Set(wantOrder);
  const queue = [...wantOrder];
  const rebuilt: ChildSlot[] = [];
  for (const slot of order) {
    if (slot.kind !== kind) { rebuilt.push(slot); continue; }
    if (!wantSet.has(slot.id)) continue; // dangling — drop
    const id = queue.shift();
    if (id !== undefined) rebuilt.push({ kind, id });
  }
  for (const id of queue) rebuilt.push({ kind, id }); // missing — append, still in wantOrder sequence
  return rebuilt;
}

/** Own paths (paths[] order) THEN direct children (doc.parts sibling order) — exactly
 *  today's two-bucket paint order. The ABSENT branch of `reconcileChildOrder`, factored
 *  out so `effectiveChildOrder` (a pure READ, never writes the doc) can share it. */
function synthesizeChildOrder(part: RigPart, allParts: RigPart[]): ChildSlot[] {
  const wantPaths = part.paths.map((p) => p.id);
  const wantChildren = allParts.filter((p) => p.parentId === part.id).map((p) => p.id);
  return [
    ...wantPaths.map((id): ChildSlot => ({ kind: 'path', id })),
    ...wantChildren.map((id): ChildSlot => ({ kind: 'part', id })),
  ];
}

/**
 * Synthesize-or-repair `part.childOrder` against the two authorities (`part.paths[]` for
 * path order, `allParts` filtered to `parentId === part.id` for part order — see the
 * file header's "two sources of truth" note):
 *  - ABSENT: synthesize from scratch (`synthesizeChildOrder`).
 *  - PRESENT: repair in place — drop dangling/duplicate slots, reassign which id
 *    occupies each kind's existing positions to match the authority (rule 4), and
 *    append any id that never had a slot. The existing INTERLEAVING (where path-kind
 *    vs part-kind runs sit relative to each other) is preserved; only the relative
 *    order WITHIN each kind changes, plus any genuinely new content appended.
 * Idempotent (a second call on its own output is a no-op) and safe to call liberally —
 * `normalizeDoc` calls it for EVERY part (the full synthesize/repair pass, see
 * serialization.ts), and the trickier structural ops (see the file header) call it again
 * afterward on just the affected part(s) as their positional correctness backstop. U2
 * (`view/nodeEditing/structural.ts`'s segment delete/join, which can add/remove whole
 * `RigPath` objects) is the newest such backstop caller — see that file.
 */
export function reconcileChildOrder(part: RigPart, allParts: RigPart[]): void {
  if (!part.childOrder) {
    part.childOrder = synthesizeChildOrder(part, allParts);
    return;
  }
  const wantPaths = part.paths.map((p) => p.id);
  const wantChildren = allParts.filter((p) => p.parentId === part.id).map((p) => p.id);
  part.childOrder = reassignKindOrder(reassignKindOrder(part.childOrder, 'path', wantPaths), 'part', wantChildren);
}

/**
 * READ-ONLY counterpart to `reconcileChildOrder`: a part's childOrder if present, else
 * the same synthesized paths-first-then-children list `reconcileChildOrder` would write —
 * WITHOUT writing it. Renderers (`core/paintOrder.ts`'s `flattenPaintOrder`, consumed by
 * both `view/render.ts`/`view/canvas.ts` and `headless/composePose.ts`) must never
 * force a never-normalized doc's lazy `childOrder` into existence just by being painted
 * (see the file header's LAZY rule — that would silently change a doc's serialized
 * shape as a side effect of rendering it). PURE.
 */
export function effectiveChildOrder(part: RigPart, allParts: RigPart[]): ChildSlot[] {
  return part.childOrder ?? synthesizeChildOrder(part, allParts);
}

/**
 * Whether every part in `doc.parts` that carries a `childOrder` is internally coherent:
 * exactly its own path ids plus its direct children's ids, each exactly once, no extras,
 * no omissions — order is NOT checked here (any permutation is valid; see
 * `childOrderAgreesWithCanonicalPartOrder` for the separate, order-sensitive rule-4
 * check). A part with no `childOrder` yet (legacy/never-normalized) is vacuously
 * coherent — see the file header's LAZY rule. PURE. Exported for reuse by later waves'
 * own integrity tests (U2+).
 */
export function isChildOrderCoherent(doc: { parts: RigPart[] }): boolean {
  for (const part of doc.parts) {
    if (!part.childOrder) continue;
    const wantPaths = new Set(part.paths.map((p) => p.id));
    const wantChildren = new Set(doc.parts.filter((p) => p.parentId === part.id).map((p) => p.id));
    const seenPaths = new Set<string>();
    const seenChildren = new Set<string>();
    for (const slot of part.childOrder) {
      const seen = slot.kind === 'path' ? seenPaths : seenChildren;
      const want = slot.kind === 'path' ? wantPaths : wantChildren;
      if (!want.has(slot.id) || seen.has(slot.id)) return false; // extra, dangling, or duplicate
      seen.add(slot.id);
    }
    if (seenPaths.size !== wantPaths.size || seenChildren.size !== wantChildren.size) return false; // omission
  }
  return true;
}

/**
 * Whether every PART-kind slot sequence in `doc.parts`' childOrders agrees with
 * `doc.parts` SIBLING order (U1 rule 4 — doc.parts stays the DFS pre-order authority for
 * part-vs-part order; a childOrder's part-slots must always agree with it).
 * Order-sensitive, part-slots only — path-slot order is `paths[]`'s own business,
 * unchecked here. A part with no `childOrder` is vacuously fine. PURE.
 */
export function childOrderAgreesWithCanonicalPartOrder(doc: { parts: RigPart[] }): boolean {
  for (const part of doc.parts) {
    if (!part.childOrder) continue;
    const slotChildren = part.childOrder.filter((s) => s.kind === 'part').map((s) => s.id);
    const siblingChildren = doc.parts.filter((p) => p.parentId === part.id).map((p) => p.id);
    if (slotChildren.length !== siblingChildren.length) return false;
    for (let i = 0; i < slotChildren.length; i++) if (slotChildren[i] !== siblingChildren[i]) return false;
  }
  return true;
}
