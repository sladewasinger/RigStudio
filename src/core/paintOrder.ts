/**
 * Paint-order flattening (U2 — rendering honors childOrder). Turns a part's ordered,
 * MIXED child list (`RigPart.childOrder`/`effectiveChildOrder` — see `core/childOrder.ts`)
 * into the actual PAINT SEQUENCE both renderers walk — the live canvas
 * (`view/render.ts`/`view/canvas.ts`) and the headless `headless/composePose.ts`. Pure and
 * DOM-free so both sides share exactly one algorithm instead of drifting (the
 * `geometry/pose.ts` shared-kernel precedent).
 *
 * RUNS: a part's own paths that sit CONTIGUOUS in its childOrder become one PAINT RUN;
 * runs interleave with the (recursively flattened) child parts' own runs in the exact
 * document order childOrder records. A part with NO own paths (bone/group, or an art part
 * whose own paths all happen to sit in other runs — never happens today, but the algorithm
 * doesn't assume it can't) still contributes exactly one EMPTY anchor run — every part
 * needs at least one paint-order entry so a live renderer always has somewhere to hang
 * that part's transform (glyphs, CTM lookups, bbox measurement), matching the pre-U2
 * invariant "every part gets a canvas group". A part whose childOrder is the synthesized
 * paths-first shape (every doc that predates U2, or was never hand-edited into an
 * interleaved shape) therefore degenerates to EXACTLY one run holding ALL its own paths,
 * in the SAME relative position — today's DOM, byte-for-byte.
 *
 * Z-ORDER (Animate-mode keyed `z`): only PART-kind slots re-sort, by (z ascending,
 * original relative order) STABLE, scoped to their PARENT's own slot list (siblings only —
 * never globally across the whole doc, unlike `structuralOps.ts`'s `drawOrder`). PATH-kind
 * slots never move — paths carry no channels, so they always hold their rest position.
 * Callers pass a `zOf` that always returns 0 for pure REST/structural order (e.g. Edit
 * mode, or the initial DOM build): with an all-zero z, the stable index tiebreak
 * reproduces the doc.parts/childOrder order exactly, which is also what
 * `channelValue(part, 'z', null)` naturally returns — so a caller can pass the SAME zOf
 * function unconditionally in both editor modes (`effectiveZ(part, poseTime())` quietly
 * no-ops when poseTime() is null) rather than branching.
 *
 * DELIBERATELY SEPARATE from `core/structuralOps.ts`'s `drawOrder`: that function's
 * GLOBAL (doc-wide, hierarchy-blind) sort is still what the .riv/Lottie exporters and the
 * inspector's stacking-section UI use (U3's job to reconcile — the exporters don't read
 * slots yet, so their golden/pinned bytes must not move here). `flattenPaintOrder` reuses
 * `drawOrder` internally, but only ever on ONE parent's sibling list at a time (roots, or
 * one part's direct children) — that scoping is what makes the reuse safe without
 * touching `drawOrder`'s own global semantics or its callers.
 */
import { ChildSlot, RigPart } from './docTypes';
import { effectiveChildOrder, reassignKindOrder } from './childOrder';
import { drawOrder } from './structuralOps';

export interface PaintRun {
  /** The part this run's paths belong to. */
  partId: string;
  /** This run's own path ids, in slot (bottom→top) order. Empty for a partless part's
   *  anchor run. */
  pathIds: string[];
  /** 0-based index of this run among `partId`'s own runs, in paint order. */
  runIndex: number;
  /** How many runs `partId` contributes in total (>= 1). `runIndex === 0 && totalRuns
   *  === 1` is the degenerate "exactly like before U2" case. */
  totalRuns: number;
}

/**
 * The contiguous PATH-kind runs in `order` (a slot list already resolved for one part —
 * see `effectiveChildOrder`), ignoring wherever the 'part'-kind slots between them sit.
 * `[[]]` (one empty run) for a part with no path slots at all — the anchor-run rule, see
 * the module doc. The single source both `flattenPart` (fed the z-sorted order — z-sort
 * only ever touches 'part' slots, so a part's PATH-run content/count is identical whether
 * computed before or after it) and the standalone exported `partOwnRuns` (fed the plain
 * unsorted order) resolve runs from, so the two can never drift out of lockstep.
 */
function pathRunsOf(order: ChildSlot[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  for (const slot of order) {
    if (slot.kind === 'path') { current.push(slot.id); continue; }
    if (current.length > 0) { runs.push(current); current = []; }
  }
  if (current.length > 0) runs.push(current);
  return runs.length > 0 ? runs : [[]];
}

/**
 * Just `part`'s own paint runs (pathId groups), ignoring recursion into children and any
 * z-sort — the piece `view/partDom.ts` needs to (re)build a part's own DOM run-groups
 * after its paths change (a structural node edit, a cross-part path move) without
 * re-flattening the whole document. Always matches what a full `flattenPaintOrder` call
 * would compute for this part (see `pathRunsOf`'s doc) — a caller may safely use the
 * result to decide how many `<g>`s a part needs and which path ids go in each.
 */
export function partOwnRuns(part: RigPart, allParts: RigPart[]): string[][] {
  return pathRunsOf(effectiveChildOrder(part, allParts));
}

function flattenPart(
  part: RigPart,
  allParts: RigPart[],
  partsById: Map<string, RigPart>,
  childrenOf: Map<string, RigPart[]>,
  zOf: (part: RigPart) => number,
): PaintRun[] {
  let order = effectiveChildOrder(part, allParts);
  const kids = childrenOf.get(part.id);
  if (kids && kids.length > 0) {
    const zSortedIds = drawOrder(kids, zOf).map((p) => p.id);
    order = reassignKindOrder(order, 'part', zSortedIds);
  }
  const ownPathRuns = pathRunsOf(order);
  const result: PaintRun[] = [];

  if (ownPathRuns.length === 1 && ownPathRuns[0].length === 0) {
    // No real path slots anywhere (a partless bone/group, or an art part with zero own
    // paths) — the phantom ANCHOR run `pathRunsOf` falls back to. It has to be emitted
    // FIRST, matching where the (empty) leading run sits under the "own paths THEN
    // children" synthesis rule — otherwise a partless part WITH children (a plain
    // `group` wrapping other parts) would flatten with its own anchor AFTER its
    // children's whole subtree instead of before, diverging from today's doc.parts-order
    // DOM for that exact degenerate case.
    result.push({ partId: part.id, pathIds: [], runIndex: 0, totalRuns: 1 });
    for (const slot of order) {
      if (slot.kind !== 'part') continue;
      const child = partsById.get(slot.id);
      if (child) result.push(...flattenPart(child, allParts, partsById, childrenOf, zOf));
    }
    return result;
  }

  let runIndex = 0;
  let pathRunCursor = 0;
  // A run is "pending" (accumulated but not yet emitted) whenever we've just walked past
  // one or more PATH slots and haven't hit the NEXT part slot yet — emit it exactly then,
  // so it lands between the part slots on either side of it, never before we know there
  // is no more of it to accumulate.
  let pendingRun = false;
  const emitOwnRun = (): void => {
    result.push({
      partId: part.id, pathIds: ownPathRuns[pathRunCursor++], runIndex: runIndex++, totalRuns: ownPathRuns.length,
    });
    pendingRun = false;
  };
  for (const slot of order) {
    if (slot.kind === 'path') { pendingRun = true; continue; }
    if (pendingRun) emitOwnRun();
    const child = partsById.get(slot.id);
    if (child) result.push(...flattenPart(child, allParts, partsById, childrenOf, zOf));
  }
  if (pendingRun) emitOwnRun(); // trailing run after the last part slot (or the part's only run)
  return result;
}

/**
 * The whole document's paint sequence: root parts (no `parentId`) in `drawOrder`'d
 * sibling order, each recursively flattened the same way. See the module doc for the
 * run/anchor/z-sort rules. Callers decide hidden-part exclusion themselves (the live
 * canvas keeps hidden parts' groups, toggling `visibility:hidden` for editing; headless
 * exports drop them entirely) — this function is agnostic to `RigPart.hidden`.
 */
export function flattenPaintOrder(
  doc: { parts: RigPart[] },
  zOf: (part: RigPart) => number,
): PaintRun[] {
  const partsById = new Map(doc.parts.map((p) => [p.id, p]));
  const childrenOf = new Map<string, RigPart[]>();
  for (const p of doc.parts) {
    if (!p.parentId) continue;
    const arr = childrenOf.get(p.parentId);
    if (arr) arr.push(p);
    else childrenOf.set(p.parentId, [p]);
  }
  const roots = doc.parts.filter((p) => !p.parentId);
  const rootOrder = drawOrder(roots, zOf);
  return rootOrder.flatMap((p) => flattenPart(p, doc.parts, partsById, childrenOf, zOf));
}
