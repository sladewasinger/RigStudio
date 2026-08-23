/** Bridge from Rig Studio warp correspondences to native Rive vertex animation. */

import { RigDoc } from '../../core/model';
import { compileWarpPathPair, interpolateWarpCommands } from '../../geometry/warp';
import { PathCmd, serializePath } from '../../geometry/paths';

export interface RivWarpStyle {
  fill: string | null; fillOpacity: number;
  stroke: string | null; strokeOpacity: number; strokeWidth: number;
}

export interface CompiledRivWarpPair {
  warpId: string;
  pairId: string;
  sourcePartId: string;
  sourcePathId: string;
  source: PathCmd[];
  target: PathCmd[];
  sourceStyle: RivWarpStyle;
  targetStyle: RivWarpStyle;
  sourcePartOpacity: number;
  targetPartOpacity: number;
}

export function compileRivWarpPairs(doc: RigDoc): CompiledRivWarpPair[] {
  const result: CompiledRivWarpPair[] = [];
  for (const warp of doc.warps ?? []) for (const pair of warp.pairs) {
    const compiled = compileWarpPathPair(doc, pair);
    const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId)!;
    const targetPart = doc.parts.find((part) => part.id === pair.targetPartId)!;
    const sourcePath = sourcePart.paths.find((path) => path.id === pair.sourcePathId)!;
    const targetPath = targetPart.paths.find((path) => path.id === pair.targetPathId)!;
    if (!!sourcePath.fill !== !!targetPath.fill || !!sourcePath.stroke !== !!targetPath.stroke) {
      throw new Error(`Warp correspondence "${sourcePath.label} ↔ ${targetPath.label}" changes fill/stroke presence. Pair matching paint structures or crossfade them as unmatched artwork.`);
    }
    result.push({
      warpId: warp.id, pairId: pair.id,
      sourcePartId: pair.sourcePartId, sourcePathId: pair.sourcePathId,
      source: compiled.source, target: compiled.target,
      sourceStyle: sourcePath, targetStyle: targetPath,
      sourcePartOpacity: sourcePart.rest.opacity, targetPartOpacity: targetPart.rest.opacity,
    });
  }
  return result;
}

export function rivWarpPathData(pair: CompiledRivWarpPair, amount: number): string {
  return serializePath(interpolateWarpCommands(pair.source, pair.target, amount));
}

export function assertSharedSourceTopology(pairs: CompiledRivWarpPair[]): void {
  if (pairs.length < 2) return;
  const signature = topologySignature(pairs[0].source);
  if (pairs.some((pair) => topologySignature(pair.source) !== signature)) {
    throw new Error(
      'Multiple warp transitions reuse one source path with incompatible vertex counts. ' +
      'Use separate source variants or rebuild the correspondences with matching topology.',
    );
  }
}

function topologySignature(commands: PathCmd[]): string {
  return commands.map((command) => command.cmd).join('');
}
