/**
 * Coordinate helpers: mapping pointer/client positions into the various SVG spaces
 * (user/viewBox, root/document, a path's raw pre-transform space) and the on-screen
 * scale utilities that keep overlay chrome a constant number of device pixels.
 *
 * Everything here reads the live DOM through `ctx` and computes from the transform
 * STRINGS / screen CTM — never a captured overlay element (overlay rebuilds detach
 * such elements, whose screen matrix is garbage).
 */

import { RigPart, RigPath } from '../core/model';
import { Mat, applyMat, invertMat, matrixOfTransform } from '../geometry/transforms';
import { ctx } from './context';

export function svgPoint(x: number, y: number): DOMPoint {
  const pt = ctx.svg!.createSVGPoint();
  pt.x = x; pt.y = y;
  return pt;
}

/** Pointer position in root (document) coordinates — where pivots and parts live. */
export function pointerInRoot(ev: PointerEvent): DOMPoint {
  const m = ctx.rootGroup!.getScreenCTM();
  return svgPoint(ev.clientX, ev.clientY).matrixTransform(m!.inverse());
}

/** On-screen scale (user units → device px) of the current zoom. */
export function screenScaleOf(): number {
  const ctm = ctx.svg?.getScreenCTM();
  return ctm ? Math.hypot(ctm.a, ctm.b) : 1;
}

/** ~8 screen px expressed in root/user units (root pose is identity in Setup). */
export function snapThreshold(): number {
  return 8 / screenScaleOf();
}

/** Map a root-space point into SVG user (viewBox) space, where overlay markers live. */
export function rootToUser(p: { x: number; y: number }): { x: number; y: number } {
  const m = matrixOfTransform(ctx.rootGroup?.getAttribute('transform') ?? '');
  return applyMat(m, p.x, p.y);
}

/** The holder matrix a path's raw coordinates render through (root+group+path). Reads
 *  ANY one of the part's run groups — every run of a part shares the SAME composed
 *  transform (U2: `ctx.partGroups` may hold more than one — see partDom.ts). */
export function pathHolderMat(part: RigPart, path: RigPath): Mat {
  const g = ctx.partGroups.get(part.id)?.[0];
  return matrixOfTransform([
    ctx.rootGroup?.getAttribute('transform') ?? '',
    g?.getAttribute('transform') ?? '',
    path.transform,
  ].filter(Boolean).join(' '));
}

/**
 * Pointer position in a path's raw-coordinate space, computed from the TRANSFORM
 * STRINGS (root pose + part chain + path transform) rather than a captured overlay
 * element — overlay rebuilds mid-drag would leave such an element detached, and a
 * detached element's screen matrix is garbage (nodes teleporting off-screen).
 * Going through the svg's own screen CTM keeps zoom/pan exact.
 */
export function pointerInPathSpace(
  ev: PointerEvent, part: RigPart, path: RigPath,
): { x: number; y: number } {
  const m = ctx.svg!.getScreenCTM()!;
  const user = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
  return applyMat(invertMat(pathHolderMat(part, path)), user.x, user.y);
}

/** Handle radius in user units, compensating for on-screen scale. */
export function handleSize(): number {
  if (!ctx.svg) return 4;
  const ctm = ctx.svg.getScreenCTM();
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
  return 6 / scale;
}
