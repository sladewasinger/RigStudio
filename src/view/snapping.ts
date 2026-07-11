/**
 * Snap-candidate wiring for Setup-mode editing aids. These build the root/path-space
 * feature points that pivot drags, part-translate drags, and node drags line up on;
 * the pure snap math lives in `src/snap.ts`.
 */

import { state, RigPart, RigPath } from '../model';
import { parsePath } from '../paths';
import { applyMat, invertMat, matrixOfTransform, multiply } from '../transforms';
import { SnapCandidate, boxFeaturePoints } from '../snap';
import { nodeKey } from './context';
import { pathHolderMat, screenScaleOf } from './coords';
import { effectivePivot, groupTransformOf, partRootBoxes } from './pose';

/**
 * Candidate points (root space) a pivot drag snaps to: the part's own path nodes and
 * every OTHER part's live joint. Landing a joint exactly on an artwork node or another
 * joint is the whole point of snapping for rigging.
 */
export function pivotSnapCandidates(part: RigPart, t: number | null): SnapCandidate[] {
  const doc = state.doc;
  if (!doc) return [];
  const cands: SnapCandidate[] = [];
  for (const other of doc.parts) {
    if (other.id === part.id) continue;
    const ep = effectivePivot(other, t);
    cands.push({ x: ep.x, y: ep.y, kind: 'pivot' });
  }
  const groupMat = matrixOfTransform(groupTransformOf(part, t));
  for (const path of part.paths) {
    const pm = multiply(groupMat, matrixOfTransform(path.transform));
    for (const c of parsePath(path.d)) {
      if (c.cmd === 'Z') continue;
      const r = applyMat(pm, (c as { x: number }).x, (c as { y: number }).y);
      cands.push({ x: r.x, y: r.y, kind: 'node' });
    }
  }
  return cands;
}

/** Moving + target feature points (root space) for a part-translate snap. */
export function translateSnapFeatures(
  part: RigPart, t: number | null,
): { moving: SnapCandidate[]; targets: SnapCandidate[] } {
  const doc = state.doc!;
  const selected = new Set(state.selectedPartIds);
  const featuresOf = (p: RigPart): SnapCandidate[] => {
    const out: SnapCandidate[] = [];
    const ep = effectivePivot(p, t);
    out.push({ x: ep.x, y: ep.y, kind: 'pivot' });
    const box = p.paths.length > 0 ? partRootBoxes([p.id]).get(p.id) : undefined;
    if (box) out.push(...boxFeaturePoints(box));
    return out;
  };
  const moving = featuresOf(part);
  const targets: SnapCandidate[] = [];
  for (const other of doc.parts) {
    if (selected.has(other.id)) continue; // never snap the moving selection to itself
    targets.push(...featuresOf(other));
  }
  return { moving, targets };
}

/**
 * Node-snap candidates in the DRAGGED path's raw coordinate space (so a same-path
 * target snaps to an EXACT stored coordinate). Every endpoint of the part's editable
 * paths except the ones being dragged; other paths are mapped in through their holder.
 */
export function nodeSnapCandidates(
  part: RigPart, draggedPath: RigPath, scoped: RigPath[], moving: Set<string>,
): { candidates: SnapCandidate[]; threshold: number } {
  const draggedHolder = pathHolderMat(part, draggedPath);
  const draggedInv = invertMat(draggedHolder);
  const candidates: SnapCandidate[] = [];
  for (const path of scoped) {
    const toDragged = path.id === draggedPath.id
      ? null
      : multiply(draggedInv, pathHolderMat(part, path));
    const cmds = parsePath(path.d);
    cmds.forEach((c, i) => {
      if (c.cmd === 'Z') return;
      if (moving.has(nodeKey(path.id, i))) return; // exclude the dragged selection
      const raw = { x: (c as { x: number }).x, y: (c as { y: number }).y };
      const pt = toDragged ? applyMat(toDragged, raw.x, raw.y) : raw;
      candidates.push({ x: pt.x, y: pt.y, kind: 'node' });
    });
  }
  // Threshold: ~8 screen px carried through the path's full path→screen scale.
  const pathUserScale = Math.hypot(draggedHolder.a, draggedHolder.b) || 1;
  const threshold = 8 / (screenScaleOf() * pathUserScale);
  return { candidates, threshold };
}
