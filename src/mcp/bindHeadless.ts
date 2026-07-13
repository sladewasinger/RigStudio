/**
 * Headless linear-blend skin bind: a DOM-free port of `view/rigOpsBind.ts`'s
 * `bindPartsToBones` for `src/mcp/`, which — like `src/headless/` — may never import
 * `src/view` (enforced by `headlessBoundary.test.ts`'s walk, extended to this folder).
 *
 * DUPLICATION RISK (accepted, same tradeoff CLAUDE.md documents for `mcp/applyClip.ts`):
 * this mirrors the editor's bind GEOMETRY math line-for-line where it can — everything it
 * needs (`chainMatOf`/`effectivePivot`/`effectiveTip`/`fullPoseTransform`/
 * `groupTransformOf` from `geometry/pose.ts`, `applyMat`/`invertMat`/`multiply` from
 * `geometry/transforms.ts`, `parsePath`/`serializePath`/`pathToCubics`/`arcToCubics` from
 * `geometry/paths.ts`) is already DOM-free — but drops everything that exists only to
 * keep a LIVE canvas in sync: `ctx.svg` DOM queries, `applyPathAttrs`, and
 * `invalidateSkinCache` (an editor-only render cache) are gone; `path.d`/`path.transform`/
 * `part.skin`/`bone.rest` are still mutated on the model exactly as the editor version
 * does, since that's the actual bind, not a DOM side effect. `ensureNodeTypesHeadless`/
 * `spliceNodeTypesForBakeHeadless` are tiny pure duplicates of
 * `view/nodeEditing/dragMath.ts`'s `ensureNodeTypes` and
 * `view/nodeEditing/structural.ts`'s `spliceNodeTypesForBake` (both already DOM-free,
 * just housed under `view/` alongside DOM-coupled siblings). A future change to the bind
 * algorithm must be ported to both files by hand — a good candidate for the dedicated
 * refactor pass to unify, not attempted here to keep this wave's diff reviewable.
 *
 * SCOPE (deliberately narrower than the editor version): no freeze-mode bind-refresh, no
 * per-node override preservation beyond a straight carry-through, and — per ROADMAP H2 —
 * no geometric auto-bind (`chainFillCoverage`/`expandBindTarget` need a live DOM
 * `isPointInFill`, unavailable headlessly). MCP's `add_bones` tool binds only the EXPLICIT
 * art labels the caller names; an unresolvable label is a clear tool error, never a
 * silent geometric fallback.
 */
import { ancestorChain, RigPart, SkinBone } from '../core/model';
import {
  arcToCubics, parsePath, PathCmd, pathToCubics, serializePath,
} from '../geometry/paths';
import {
  applyMat, invertMat, Mat, matrixOfTransform, multiply,
} from '../geometry/transforms';
import {
  chainMatOf, effectivePivot, effectiveTip, fullPoseTransform, groupTransformOf,
} from '../geometry/pose';

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Duplicate of `view/nodeEditing/dragMath.ts`'s `ensureNodeTypes` — see module doc. */
function ensureNodeTypesHeadless(path: { d: string; nodeTypes?: string | null }): string {
  const count = parsePath(path.d).filter((c) => c.cmd !== 'Z').length;
  let types = path.nodeTypes ?? '';
  if (types.length > count) types = types.slice(0, count);
  while (types.length < count) types += 'c';
  path.nodeTypes = types;
  return types;
}

/** Duplicate of `view/nodeEditing/structural.ts`'s `spliceNodeTypesForBake` — see module
 *  doc. Keeps the one-char-per-node type string in lockstep when an arc command expands
 *  into multiple baked cubics. */
function spliceNodeTypesForBakeHeadless(
  path: { nodeTypes?: string | null }, cmds: PathCmd[],
): void {
  if ((path.nodeTypes ?? null) === null) { path.nodeTypes = null; return; }
  const nodeTypes = ensureNodeTypesHeadless(path as { d: string; nodeTypes?: string | null });
  let out = '';
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c.cmd === 'Z') { cx = sx; cy = sy; continue; }
    const ch = nodeTypes[i++];
    if (c.cmd === 'A') {
      out += 'c'.repeat(arcToCubics(cx, cy, c).length - 1) + ch;
    } else {
      out += ch;
      if (c.cmd === 'M') { sx = c.x; sy = c.y; }
    }
    cx = c.x; cy = c.y;
  }
  path.nodeTypes = out;
}

function skinBoneOf(bone: RigPart): SkinBone {
  const p = effectivePivot(bone, null);
  const q = effectiveTip(bone, null) ?? { x: p.x + 5, y: p.y };
  return {
    id: bone.id,
    restWorldInv: invertMat(matrixOfTransform(fullPoseTransform(bone, null))),
    bindSeg: { p: { ...p }, q: { ...q } },
  };
}

/** Solve the bone's own rest so `chainMat(bone)·ownPose(bone) == W` — see
 *  `rigOpsBind.ts`'s `foldLostArtPoseIntoBoneRest` for the full derivation. */
function foldLostArtPoseIntoBoneRest(bone: RigPart, W: Mat): void {
  const target = multiply(invertMat(chainMatOf(bone, null)), W);
  const rotDeg = round3((Math.atan2(target.b, target.a) * 180) / Math.PI);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const { x: px, y: py } = bone.pivot;
  bone.rest.rotate = rotDeg;
  bone.rest.tx = round3(target.e - px + (cos * px - sin * py));
  bone.rest.ty = round3(target.f - py + (sin * px + cos * py));
}

/**
 * Bind art parts to bones (linear-blend skinning), headlessly. See the module doc for
 * what's dropped vs. the editor's `bindPartsToBones`; the geometry-baking behavior itself
 * (ancestor-first ordering, pre-bake snapshotting, the lost-art-pose fold onto a bone
 * parented to the art it rides) is unchanged.
 */
export function bindPartsToBonesHeadless(artsIn: RigPart[], bones: RigPart[]): void {
  if (artsIn.length === 0 || bones.length === 0) return;
  const arts = [...artsIn].sort((a, b) => ancestorChain(a).length - ancestorChain(b).length);
  const skinBones = bones.map(skinBoneOf);
  const freshBones = (): SkinBone[] =>
    skinBones.map((b) => ({ ...b, bindSeg: { p: { ...b.bindSeg.p }, q: { ...b.bindSeg.q } } }));
  const boneWorlds = new Map(
    bones.map((b) => [b.id, matrixOfTransform(fullPoseTransform(b, null))]),
  );
  const bakedArtIds = new Set<string>();

  const preBake = new Map<string, { full: Mat; rootPivot: { x: number; y: number } }>();
  for (const part of arts) {
    if (part.skin) continue;
    preBake.set(part.id, {
      full: matrixOfTransform(groupTransformOf(part, null)),
      rootPivot: effectivePivot(part, null),
    });
  }

  for (const part of arts) {
    if (part.skin) {
      const overrides = part.skin.overrides;
      part.skin = { bones: freshBones(), ...(overrides ? { overrides } : {}) };
      continue;
    }
    const { full, rootPivot } = preBake.get(part.id)!;
    for (const path of part.paths) {
      const m = multiply(full, matrixOfTransform(path.transform));
      const parsed = parsePath(path.d);
      spliceNodeTypesForBakeHeadless(path, parsed);
      const cmds = pathToCubics(parsed).map((c) => {
        if (c.cmd === 'C') {
          const p1 = applyMat(m, c.x1, c.y1);
          const p2 = applyMat(m, c.x2, c.y2);
          const p = applyMat(m, c.x, c.y);
          return { cmd: 'C' as const, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
        }
        if (c.cmd === 'Z') return c;
        const p = applyMat(m, (c as { x: number }).x, (c as { y: number }).y);
        return { ...c, x: p.x, y: p.y } as PathCmd;
      });
      path.d = serializePath(cmds);
      path.transform = '';
      path.strokeWidth = path.strokeWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    }
    part.transform = '';
    part.rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: part.rest.opacity };
    part.pivot = applyMat(invertMat(chainMatOf(part, null)), rootPivot.x, rootPivot.y);
    part.skin = { bones: freshBones() };
    bakedArtIds.add(part.id);
  }

  for (const bone of bones) {
    if (!bone.parentId || !bakedArtIds.has(bone.parentId)) continue;
    foldLostArtPoseIntoBoneRest(bone, boneWorlds.get(bone.id)!);
  }
}
