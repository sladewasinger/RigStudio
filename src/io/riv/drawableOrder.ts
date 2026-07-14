/**
 * U3 (unified child ordering): the .riv exporter's GLOBAL drawable-emission order,
 * derived from the SAME childOrder slot flatten both live renderers paint with
 * (`core/paintOrder.ts`'s `flattenPaintOrder`, shared verbatim by the canvas and
 * headless composePose since U2) — so an INTERLEAVED childOrder (a path run stacked
 * above a nested child part) exports with exactly the stacking the editor shows.
 *
 * REST ORDER ONLY: the flatten runs with a constant zOf (0 for every part). The .riv
 * file's static drawable order IS the rest paint order; animate-time keyed `z` remains
 * drawRules.ts's DrawRules/DrawTarget job (see the U3 divergence note in its header).
 *
 * THE REVERSAL (how runs map to Rive order): Rive draws the FIRST drawable in file
 * order TOPMOST (scene.ts's DRAW ORDER comment pinning rive-runtime/src/artboard.cpp),
 * while the flatten is bottom→top paint order — so emission order is the flatten fully
 * reversed at BOTH levels: runs back-to-front, and each run's own paths back-to-front.
 * A doc whose childOrders are all absent or synthesized paths-first (every legacy doc,
 * and everything until U4 lets a user hand-interleave) flattens to exactly one run per
 * part in doc.parts order, so the reversal degenerates to the pre-U3 emission — parts
 * in reverse doc order, each part's paths in reverse array order — BYTE-IDENTICALLY
 * (pinned by exportRivDrawableOrder.test.ts's captured pre-U3 hash and both
 * goldenRiv.test.ts pins).
 *
 * EVERY part contributes at least one run (partless bones/groups as their empty anchor
 * run), preserving the pre-U3 loop's "visit every part" shape so scene.ts can keep
 * resolving per-part side work (skin plan, pin anchor) at first encounter. SAFETY NET:
 * a part UNREACHABLE from the root forest (dangling parentId or a parent cycle —
 * states normalizeDoc repairs on load and the app itself cannot produce) is missing
 * from the flatten; it is appended (in doc.parts order) as one synthesized
 * paths-in-array-order run rather than silently dropping its geometry from the export.
 * The U2 renderers simply don't paint such parts; the export prefers completeness —
 * the reversal lands appended runs first in the file, i.e. topmost.
 */
import { flattenPaintOrder, PaintRun, RigDoc } from '../../core/model';

/** One emission step: `pathIds` are `partId`'s own paths in FILE order (topmost path
 *  first — already reversed from the run's bottom→top slot order). */
export interface EmissionRun {
  partId: string;
  pathIds: string[];
}

/** The whole document's drawable-emission sequence, in file order (topmost first).
 *  Hidden-part exclusion stays the caller's job (scene.ts skips them mid-walk, exactly
 *  like the pre-U3 loop did), matching `flattenPaintOrder`'s own hidden-agnosticism. */
export function drawableEmissionOrder(doc: RigDoc): EmissionRun[] {
  const runs: PaintRun[] = flattenPaintOrder(doc, () => 0);
  const flattened = new Set(runs.map((r) => r.partId));
  for (const part of doc.parts) {
    if (flattened.has(part.id)) continue; // unreachable-part safety net — see module doc
    runs.push({ partId: part.id, pathIds: part.paths.map((p) => p.id), runIndex: 0, totalRuns: 1 });
  }
  return runs
    .reverse()
    .map((r) => ({ partId: r.partId, pathIds: [...r.pathIds].reverse() }));
}
