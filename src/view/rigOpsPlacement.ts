/**
 * Pen-tool bone-chain placement lifecycle (start/cancel/end) and Bones 2.0's
 * auto-bind targeting (geometric fill-coverage fallback + the anchor/selection union).
 * Split out of rigOps.ts (CLAUDE.md "Small, focused files"); shares its layer (may
 * reach render.ts/partDom.ts/skinRender.ts, never interactions.ts or higher).
 */

import {
  state, selectPart, selectedParts, boneChain, RigPart, healDegenerateBoneTip,
} from '../core/model';
import { expandBindTarget, chainAnchorPart } from '../geometry/skin';
import { ctx } from './context';
import { poseTime, effectivePivot, effectiveTip } from './pose';
import { renderPose } from './render';
import { bindPartsToBones } from './rigOpsBind';
import { partOwnPathElements } from './partDom';

/**
 * Fraction of a bone chain's length that actually lies inside an art part's FILLED
 * geometry (Bones 2.0 auto-bind targeting). Each chain segment is sampled and every
 * sample is hit-tested against the part's rendered <path> fills via the live DOM
 * `isPointInFill` (mapping root→screen (rootGroup CTM) →path-local (path CTM)). A bbox
 * that merely brushes the joint (the old test) no longer counts; a real limb the chain
 * runs down does. Returns 0 when the DOM/geometry isn't measurable.
 */
function chainFillCoverage(part: RigPart, segs: { p: { x: number; y: number }; q: { x: number; y: number } }[]): number {
  const rootCTM = ctx.rootGroup?.getScreenCTM();
  if (!rootCTM || !ctx.svg) return 0;
  // Every one of the part's own <path> elements, across all its runs (U2 interleaving).
  const paths = partOwnPathElements(part.id)
    .filter((pe) => typeof pe.isPointInFill === 'function' && pe.getAttribute('fill') !== 'none');
  if (paths.length === 0) return 0;
  const invByPath = paths.map((pe) => {
    const m = pe.getScreenCTM();
    return m ? { pe, inv: m.inverse() } : null;
  }).filter((x): x is { pe: SVGPathElement; inv: DOMMatrix } => !!x);
  const SAMPLES_PER_SEG = 12;
  let total = 0, inside = 0;
  const sp = ctx.svg.createSVGPoint();
  for (const s of segs) {
    for (let i = 0; i <= SAMPLES_PER_SEG; i++) {
      const f = i / SAMPLES_PER_SEG;
      total++;
      sp.x = s.p.x + (s.q.x - s.p.x) * f;
      sp.y = s.p.y + (s.q.y - s.p.y) * f;
      const screen = sp.matrixTransform(rootCTM); // root-content → screen
      for (const { pe, inv } of invByPath) {
        const lp = screen.matrixTransform(inv); // screen → path-local (`d` space)
        const dp = ctx.svg.createSVGPoint();
        dp.x = lp.x; dp.y = lp.y;
        if (pe.isPointInFill(dp)) { inside++; break; }
      }
    }
  }
  return total > 0 ? inside / total : 0;
}

/** A meaningful fraction of the chain must lie inside a part's fill to auto-bind it. */
const AUTO_BIND_COVERAGE = 0.34;

/**
 * Bones 2.0 AUTO-BIND (Group-level auto-bind): after a bone is placed, resolve its full
 * chain (root bone + every descendant bone) and skin the RIGHT art with zero manual
 * steps — the arm bends, the body does NOT. A chain dropped on a GROUP, or on an art part
 * whose own descendants include further art (Pip's nested body-in-body: an outer "body"
 * with its own path plus a nested "body" carrying several more), binds every piece of
 * that object together — completing the locked strict-hierarchy design ("multi-object
 * cases group first"). Targeting order (most predictable first), each stage's result
 * UNIONED into the bind set so nothing already resolved gets dropped:
 *   1. Art already skinned by any bone in this chain — kept bound as the chain grows
 *      (later child bones extend the same limb; they never grab new parts).
 *   2. The object the chain lives under (`chainAnchorPart` — the chain ROOT bone's
 *      parent, resolved from the chain itself so it survives a LATER pen-tool session
 *      where the current selection is one of the chain's own bones, not the original
 *      anchor) plus whatever the user has selected when the chain finishes — each
 *      expanded via `expandBindTarget` (a group or nested-art-in-art part → its whole art
 *      subtree; a plain leaf art → itself). Stages 1+2 running every time (not just on
 *      first bind) means a later child bone re-catches any of the anchor's art
 *      descendants an earlier bind missed.
 *   3. Otherwise, the geometric fallback: bind every art part whose FILLED geometry a
 *      meaningful fraction of the chain runs through (`chainFillCoverage`), replacing
 *      the old far-too-eager segment↔bbox test that bound anything the joint grazed. A
 *      GROUP anchor that expanded to nothing (an empty container) keeps the candidate
 *      pool scoped to its own descendants rather than reaching into unrelated artwork.
 * Binds nothing when no art qualifies anywhere (silent). Does NOT checkpoint/render — the
 * placement gesture owns the single checkpoint and final repaint.
 *
 * ZERO-LENGTH GUARD: also heals the just-placed bone's own tip if it's degenerate
 * (`healDegenerateBoneTip` — model.ts) before resolving the chain. interactions.ts's
 * placement gesture already substitutes a sane default tip for a near-zero drag, so
 * this is defense-in-depth for whatever reaches this, the one hook every placement
 * runs through under the SAME checkpoint as the creation (one undo reverts both) — not
 * a cancel/delete-the-part path, since the bone's already been selected by the time
 * this returns and un-creating it here would leave that selection dangling.
 */
export function autoBindPlacedBone(boneId: string): void {
  const doc = state.doc;
  if (!doc) return;
  const placed = doc.parts.find((p) => p.id === boneId);
  if (placed) healDegenerateBoneTip(placed);
  const chain = boneChain(doc.parts, boneId);
  if (chain.length === 0) return;
  const chainIds = new Set(chain.map((b) => b.id));

  // 1. Art already bound to this chain — always refreshed.
  const alreadyBound = doc.parts.filter(
    (p) => p.kind === 'art' && p.paths.length > 0 && p.skin
      && p.skin.bones.some((b) => chainIds.has(b.id)),
  );

  // 2. The chain's anchor (hierarchy-as-assignment target) and the current selection,
  // each expanded to a full art subtree when they're a group or a nested-art-in-art part.
  const anchor = chainAnchorPart(doc.parts, chain);
  const anchorTargets = anchor ? expandBindTarget(doc.parts, anchor) : [];
  const selectedTargets = selectedParts()
    .filter((p) => (p.kind === 'art' && p.paths.length > 0) || p.kind === 'group')
    .flatMap((p) => expandBindTarget(doc.parts, p));

  const targeted = new Map<string, RigPart>();
  for (const p of [...alreadyBound, ...anchorTargets, ...selectedTargets]) targeted.set(p.id, p);
  if (targeted.size > 0) {
    bindPartsToBones([...targeted.values()], chain);
    return;
  }

  // 3. Geometric fallback: which filled art does the chain actually run through?
  const t = poseTime();
  const segs = chain.map((b) => {
    const p = effectivePivot(b, t);
    const q = effectiveTip(b, t) ?? { x: p.x + 5, y: p.y };
    return { p, q };
  });
  // anchorTargets is guaranteed empty here (targeted.size === 0 above), so for a group
  // anchor this is exactly its own (empty) descendant set — narrows the search instead
  // of falling back to the whole doc.
  const pool = anchor?.kind === 'group'
    ? anchorTargets
    : doc.parts.filter((p) => p.kind === 'art' && p.paths.length > 0);
  const targets = pool.filter((p) => chainFillCoverage(p, segs) >= AUTO_BIND_COVERAGE);
  if (targets.length === 0) return; // no art under the chain — bind nothing
  bindPartsToBones(targets, chain);
}

// ---- Bone placement (pen-tool chains) ----

/**
 * Arm the bone tool for CHAIN placement. The first canvas click sets the chain's origin
 * (anchored at a selected bone's tip so a chain continues; parented to a selected art OR
 * GROUP per hierarchy-as-assignment — Group-level auto-bind then skins every art
 * descendant of a group anchor), each subsequent click commits a bone and starts the next at
 * that new tip, and Escape/Enter/double-click finishes (endBoneChain). `placingBone` stays
 * armed until the chain ends; `boneChain` is seeded on the first click (interactions.ts).
 */
export function startBonePlacement(): void {
  ctx.placingBone = true;
  ctx.boneChain = null;
  if (ctx.svg) ctx.svg.style.cursor = 'crosshair';
}

/**
 * DISCARD an armed/in-progress chain WITHOUT finalizing (no auto-bind) — for a document
 * swap/reset where any committed bones belong to the doc being replaced. Returns whether
 * the tool was armed or a chain was running. (User-driven ends go through endBoneChain,
 * which keeps the committed bones and auto-binds.)
 */
export function cancelBonePlacement(): boolean {
  const was = ctx.placingBone || !!ctx.boneChain;
  ctx.placingBone = false;
  ctx.boneChain = null;
  if (ctx.svg) ctx.svg.style.cursor = '';
  return was;
}

/**
 * FINISH the pen-tool chain (Escape / Enter / double-click, wired in main.ts +
 * interactions.ts). The in-progress preview segment is discarded; every committed bone
 * stays. AUTO-BIND runs exactly ONCE here for the whole chain (under the single checkpoint
 * the first commit already took — so undo removes the chain AND its binding together),
 * using the selection preserved across the chain (art selected → bind it; nothing → the
 * geometric limb-coverage fallback). Then the last bone is selected. A chain that committed
 * NO bones (a lone origin click) just disarms — no checkpoint was taken, nothing to bind.
 * Returns whether the tool was armed or a chain was running (for the Escape tier).
 */
export function endBoneChain(): boolean {
  const ch = ctx.boneChain;
  if (!ctx.placingBone && !ch) return false; // nothing armed — let the key fall through
  ctx.placingBone = false;
  ctx.boneChain = null;
  if (ctx.svg) ctx.svg.style.cursor = '';
  if (ch && ch.committed.length > 0) {
    const lastId = ch.committed[ch.committed.length - 1];
    autoBindPlacedBone(lastId); // ONCE, with the chain-start selection still intact
    selectPart(lastId);
  }
  renderPose();
  return true;
}
