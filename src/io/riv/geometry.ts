/**
 * Path-data -> Rive vertex conversion for the .riv exporter: the baked-matrix
 * composition and the subpath/vertex walk that turns a RigPath's `d` into Rive
 * CubicDetachedVertex records (split out of scene.ts in the skinned-part export wave so
 * scene.ts and skin.ts can share one walk — a second, weights-only reimplementation of
 * the fold rules would inevitably drift).
 *
 * Every emitted vertex also records its SOURCE sample points (`RivVertex.src`): the
 * doc-space coordinates of the vertex point and each handle plus the path-command
 * (node) index that governs them. Rigid parts never read them; `io/riv/skin.ts` maps
 * them through the same weight model as `view/skinRender.ts` (auto weights at each
 * sample's own position, per-node overrides by command index) to build the exported
 * CubicWeight for each vertex. The node-index bookkeeping mirrors skinRender's
 * `nodeKeyFlat` exactly: a C command's outgoing handle (x1,y1) belongs to the PREVIOUS
 * node it leaves; its incoming handle (x2,y2) and endpoint belong to this node.
 */

import { RigPart, RigPath } from '../../core/model';
import { parsePath, pathToCubics } from '../../geometry/paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../../geometry/transforms';

/**
 * Baked matrix for a path: part group transform, then rest scale/skew innermost around
 * the pivot (mapped into pre-baked local space) so artwork reshapes on its own axes and
 * the joint stays fixed, then the per-path transform. Identical to exportLottie.ts.
 */
export function bakedMatrix(part: RigPart, path: RigPath): Mat {
  const baked = matrixOfTransform(part.transform);
  let m = baked;
  const sx = part.rest?.sx ?? 1;
  const sy = part.rest?.sy ?? 1;
  const kx = part.rest?.kx ?? 0;
  const ky = part.rest?.ky ?? 0;
  if (sx !== 1 || sy !== 1 || kx !== 0 || ky !== 0) {
    const pl = applyMat(invertMat(baked), part.pivot.x, part.pivot.y);
    const local = matrixOfTransform(
      `translate(${pl.x},${pl.y}) scale(${sx},${sy}) ` +
      `skewX(${kx}) skewY(${ky}) translate(${-pl.x},${-pl.y})`,
    );
    m = multiply(baked, local);
  }
  return multiply(m, matrixOfTransform(path.transform));
}

/** A weight sample: where this point sits in the SOURCE path data (doc space for a
 *  bind-baked skinned path) and which node (command index) governs its override. */
export interface WeightSample { x: number; y: number; node: number }

/** The source samples behind one emitted vertex. `in`/`out` are null for a
 *  zero-distance handle (straight segment) — the point's own sample governs it, so the
 *  deformed handle stays glued to the deformed endpoint exactly like an L endpoint in
 *  the live LBS render. */
export interface VertexSources {
  pt: WeightSample;
  in: WeightSample | null;
  out: WeightSample | null;
}

export interface RivVertex {
  x: number; y: number;
  inRot: number; inDist: number;
  outRot: number; outDist: number;
  src: VertexSources;
}
export interface RivSubpath { verts: RivVertex[]; closed: boolean }

/**
 * Parse path data, rewrite arcs as cubics, flatten the baked matrix, subtract the pivot
 * to land in the part node's local space, and convert each vertex's in/out tangent
 * offsets to Rive's polar (rotation, distance) form. Straight segments become
 * zero-distance handles (Rive renders a degenerate cubic as a line). The subpath fold
 * for an explicit closing segment mirrors exportLottie.ts's pathToBeziers.
 */
export function pathToLocalSubpaths(d: string, m: Mat, pivotX: number, pivotY: number): RivSubpath[] {
  const cmds = pathToCubics(parsePath(d));
  const subs: RivSubpath[] = [];
  // Working buffers for the current subpath: vertex point + in/out tangent OFFSETS,
  // plus the parallel source-sample records for the skin weight computation.
  let v: { x: number; y: number }[] = [];
  let inv: { x: number; y: number }[] = [];
  let outv: { x: number; y: number }[] = [];
  let src: VertexSources[] = [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let open = false;

  const local = (x: number, y: number) => {
    const p = applyMat(m, x, y);
    return { x: p.x - pivotX, y: p.y - pivotY };
  };
  const tangent = (cx: number, cy: number, vx: number, vy: number) => {
    const c = applyMat(m, cx, cy);
    const w = applyMat(m, vx, vy);
    return { x: c.x - w.x, y: c.y - w.y };
  };
  const finish = (closed: boolean) => {
    if (v.length >= 2) {
      subs.push({ verts: v.map((pt, i) => toPolar(pt, inv[i], outv[i], src[i])), closed });
    }
    v = []; inv = []; outv = []; src = []; open = false;
  };
  const startSub = (x: number, y: number, node: number) => {
    v = [local(x, y)]; inv = [{ x: 0, y: 0 }]; outv = [{ x: 0, y: 0 }];
    src = [{ pt: { x, y, node }, in: null, out: null }];
    open = true;
  };

  cmds.forEach((c, node) => {
    switch (c.cmd) {
      case 'M':
        if (open) finish(false);
        startSub(c.x, c.y, node);
        curX = c.x; curY = c.y; startX = c.x; startY = c.y;
        break;
      case 'L': {
        if (!open) startSub(curX, curY, node);
        v.push(local(c.x, c.y)); inv.push({ x: 0, y: 0 }); outv.push({ x: 0, y: 0 });
        src.push({ pt: { x: c.x, y: c.y, node }, in: null, out: null });
        curX = c.x; curY = c.y;
        break;
      }
      case 'C': {
        if (!open) startSub(curX, curY, node);
        outv[outv.length - 1] = tangent(c.x1, c.y1, curX, curY);
        // The outgoing handle rides the PREVIOUS node's override (skinRender's
        // nodeKeyFlat rule) but is weighted at its OWN position.
        src[src.length - 1].out = { x: c.x1, y: c.y1, node: Math.max(0, node - 1) };
        v.push(local(c.x, c.y));
        inv.push(tangent(c.x2, c.y2, c.x, c.y));
        src.push({
          pt: { x: c.x, y: c.y, node },
          in: { x: c.x2, y: c.y2, node },
          out: null,
        });
        outv.push({ x: 0, y: 0 });
        curX = c.x; curY = c.y;
        break;
      }
      case 'Z': {
        if (open) {
          const n = v.length;
          // Explicit final segment back to the start duplicates vertex 0: fold its
          // incoming tangent into vertex 0 and drop it (Rive auto-closes last->first).
          if (n > 1 && Math.hypot(v[n - 1].x - v[0].x, v[n - 1].y - v[0].y) < 1e-3) {
            inv[0] = inv[n - 1];
            src[0].in = src[n - 1].in; // the folded tangent keeps ITS node's weights
            v.pop(); inv.pop(); outv.pop(); src.pop();
          }
          finish(true);
        }
        curX = startX; curY = startY;
        break;
      }
      case 'A':
        break; // unreachable: pathToCubics rewrote all arcs
    }
  });
  if (open) finish(false);
  return subs;
}

/** Vertex point + in/out tangent offsets -> Rive detached-cubic polar handles. */
function toPolar(
  pt: { x: number; y: number },
  inOff: { x: number; y: number },
  outOff: { x: number; y: number },
  src: VertexSources,
): RivVertex {
  return {
    x: pt.x, y: pt.y,
    inRot: Math.atan2(inOff.y, inOff.x),
    inDist: Math.hypot(inOff.x, inOff.y),
    outRot: Math.atan2(outOff.y, outOff.x),
    outDist: Math.hypot(outOff.x, outOff.y),
    src,
  };
}
