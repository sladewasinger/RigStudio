import { boundsCenter, pathBoundsThroughMatrix } from '../geometry/pathBounds';
import { IDENTITY, matrixOfTransform, multiply } from '../geometry/transforms';
import { restRenderMatrixOf } from './boneOps';
import { reconcileChildOrder, slotPromotePathToChild } from './childOrder';
import { freshId } from './idGen';
import { canonicalizePartOrder } from './structuralOps';
import { RigPart } from './docTypes';
import { state } from './appState';

/**
 * Give one path inside a composite art part its own ordinary RigPart transform target.
 * The operation is visually neutral and durable: paint position, skin binding, Warp
 * correspondence, visibility, and path identity all follow the promoted leaf.
 * One-path parts are returned unchanged because they already are leaf targets.
 */
export function promotePathToPart(owner: RigPart, pathId: string): RigPart | null {
  const doc = state.doc;
  const path = owner.paths.find((candidate) => candidate.id === pathId);
  if (!doc || !path) return null;
  if (!pathNeedsPromotion(owner, doc.parts)) {
    return owner;
  }
  const partMatrix = owner.skin ? IDENTITY : restRenderMatrixOf(doc.parts, owner);
  const matrix = multiply(partMatrix, matrixOfTransform(path.transform));
  const bounds = pathBoundsThroughMatrix(path.d, matrix);
  const overrides = owner.skin?.overrides?.[path.id];
  const skin = owner.skin ? {
    ...structuredClone(owner.skin),
    overrides: overrides ? { [path.id]: structuredClone(overrides) } : undefined,
  } : null;
  const leaf: RigPart = {
    id: freshId('part'), label: path.label, kind: 'art', transform: owner.skin ? '' : owner.transform,
    pivot: bounds ? boundsCenter(bounds) : { ...owner.pivot }, pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    parentId: owner.id, paths: [{ ...path, hidden: undefined }],
    childOrder: [{ kind: 'path', id: path.id }], hidden: path.hidden ? true : undefined,
    skin,
  };
  owner.paths = owner.paths.filter((candidate) => candidate.id !== path.id);
  if (owner.skin?.overrides) delete owner.skin.overrides[path.id];
  if (owner.paths.length === 0) {
    owner.kind = 'group';
    owner.skin = null;
  }
  slotPromotePathToChild(owner, path.id, leaf.id);
  doc.parts.push(leaf);
  doc.parts = canonicalizePartOrder(doc.parts);
  reconcileChildOrder(owner, doc.parts);
  for (const warp of doc.warps ?? []) for (const pair of warp.pairs) {
    if (pair.sourcePartId === owner.id && pair.sourcePathId === path.id) pair.sourcePartId = leaf.id;
    if (pair.targetPartId === owner.id && pair.targetPathId === path.id) pair.targetPartId = leaf.id;
  }
  return leaf;
}

/** Whether an entered path still shares its transform owner with sibling artwork or
 * child art. A one-path art leaf is already independently transformable. */
export function pathNeedsPromotion(owner: RigPart, parts: RigPart[]): boolean {
  return owner.paths.length !== 1
    || parts.some((part) => part.parentId === owner.id && part.kind !== 'bone');
}
