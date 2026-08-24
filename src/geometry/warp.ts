import { RigDoc, RigPart, RigPath, WarpDefinition, WarpPathPair } from '../core/docTypes';
import { freshId } from '../core/idGen';
import { parsePath, pathToCubics, serializePath, PathCmd } from './paths';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from './transforms';
import { groupTransformOf, PoseSampler } from './pose';
import { alignAndEqualize, resolveSubpathAlignment, WarpAlignment, WarpSubpath } from './warpAlignment';

type Cubic = Extract<PathCmd, { cmd: 'C' }>;
type Subpath = WarpSubpath;
export type { WarpAlignment } from './warpAlignment';
export type WarpCandidate = { sourcePartId: string; sourcePathId: string; targetPartId: string; targetPathId: string; confidence: 'exact'; reason: string };
export type WarpBuildResult = { definition: WarpDefinition; warnings: string[]; ambiguous: string[] };

const cubicLine = (a: { x: number; y: number }, b: { x: number; y: number }): Cubic => ({
  cmd: 'C', x1: a.x + (b.x - a.x) / 3, y1: a.y + (b.y - a.y) / 3,
  x2: a.x + 2 * (b.x - a.x) / 3, y2: a.y + 2 * (b.y - a.y) / 3, x: b.x, y: b.y,
});

function subpathsOfCommands(commands: PathCmd[], matrix: Mat): Subpath[] {
  const result: Subpath[] = [];
  let current: Subpath | null = null;
  let point = { x: 0, y: 0 };
  for (const command of commands) {
    if (command.cmd === 'M') {
      if (current) result.push(current);
      point = applyMat(matrix, command.x, command.y);
      current = { start: point, curves: [], closed: false };
    } else if (command.cmd === 'L' || command.cmd === 'C') {
      if (!current) continue;
      const end = applyMat(matrix, command.x, command.y);
      if (command.cmd === 'L') current.curves.push(cubicLine(point, end));
      else {
        const one = applyMat(matrix, command.x1, command.y1);
        const two = applyMat(matrix, command.x2, command.y2);
        current.curves.push({ cmd: 'C', x1: one.x, y1: one.y, x2: two.x, y2: two.y, x: end.x, y: end.y });
      }
      point = end;
    } else if (command.cmd === 'Z' && current) {
      // Make the implicit closing edge explicit before cyclic rotation/reversal. Without
      // this edge, reversing a closed contour changes its shape and can send one side
      // across the other during a Warp.
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 1e-9) {
        current.curves.push(cubicLine(point, current.start));
      }
      current.closed = true;
      point = current.start;
    }
  }
  if (current) result.push(current);
  return result;
}

function subpathsOf(path: RigPath, matrix: Mat): Subpath[] {
  return subpathsOfCommands(pathToCubics(parsePath(path.d)), matrix);
}

function commandsOf(subpaths: Subpath[]): PathCmd[] {
  return subpaths.flatMap((subpath) => [
    { cmd: 'M' as const, x: subpath.start.x, y: subpath.start.y },
    ...subpath.curves,
    ...(subpath.closed ? [{ cmd: 'Z' as const }] : []),
  ]);
}

/**
 * Equalize two already-evaluated command streams. Keeping this step AFTER endpoint
 * skinning is important: synthetic vertices introduced only for Warp correspondence
 * are subdivisions of the rendered curve, not authored nodes that may borrow an
 * unrelated manual override by their new command ordinal.
 */
export function normalizeEvaluatedWarpCommands(
  sourceCommands: PathCmd[], targetCommands: PathCmd[], reverse?: boolean, seam?: number,
): { source: PathCmd[]; target: PathCmd[] } {
  const identity = matrixOfTransform('');
  const source = subpathsOfCommands(sourceCommands, identity);
  const target = subpathsOfCommands(targetCommands, identity);
  if (source.length !== target.length) throw new Error('Warp paths have different compound-path counts.');
  for (let i = 0; i < source.length; i++) {
    if (source[i].closed !== target[i].closed) throw new Error('Warp paths mix open and closed geometry.');
    alignAndEqualize(source[i], target[i], reverse, seam);
  }
  return { source: commandsOf(source), target: commandsOf(target) };
}

function topology(path: RigPath): string {
  const subs = subpathsOf(path, matrixOfTransform(''));
  // v1 fingerprints predate explicit closing-edge normalization.
  return subs.map((subpath) => `${subpath.closed ? 'c' : 'o'}:${subpath.curves.length - (subpath.closed ? 1 : 0)}`).join('|');
}

export function warpPathFingerprint(path: RigPath): string {
  return `v2:${topology(path)}:${serializePath(parsePath(path.d))}`;
}

export function warpPairIsStale(doc: RigDoc, pair: WarpPathPair): boolean {
  const source = doc.parts.find((part) => part.id === pair.sourcePartId)?.paths.find((path) => path.id === pair.sourcePathId);
  const target = doc.parts.find((part) => part.id === pair.targetPartId)?.paths.find((path) => path.id === pair.targetPathId);
  if (!source || !target) return true;
  const legacyMatches = (stored: string, path: RigPath) => stored.startsWith('v1:') && stored === `v1:${topology(path)}`;
  return !(pair.sourceFingerprint === warpPathFingerprint(source) || legacyMatches(pair.sourceFingerprint, source)) ||
    !(pair.targetFingerprint === warpPathFingerprint(target) || legacyMatches(pair.targetFingerprint, target));
}

export function repairWarpPair(doc: RigDoc, pair: WarpPathPair): WarpAlignment {
  const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId)!;
  const targetPart = doc.parts.find((part) => part.id === pair.targetPartId)!;
  const sourcePath = sourcePart.paths.find((path) => path.id === pair.sourcePathId)!;
  const targetPath = targetPart.paths.find((path) => path.id === pair.targetPathId)!;
  const source = subpathsOf(sourcePath, holderMatrix(doc, sourcePart, sourcePath));
  const target = subpathsOf(targetPath, holderMatrix(doc, targetPart, targetPath));
  // Older serializers materialized an absent seam as `0`; a v1 pair with no auto
  // metadata therefore cannot mean "manual seam zero". Recover its intended auto mode.
  const legacyDefaultSeam = pair.sourceFingerprint.startsWith('v1:') && pair.seam === 0 && pair.reverse === undefined && pair.autoSeam === undefined;
  const alignment = resolveSubpathAlignment(source[0], target[0], pair.reverse, legacyDefaultSeam ? undefined : pair.seam);
  if (legacyDefaultSeam) delete pair.seam;
  pair.sourceFingerprint = warpPathFingerprint(sourcePath);
  pair.targetFingerprint = warpPathFingerprint(targetPath);
  pair.autoReverse = alignment.reverse;
  pair.autoSeam = alignment.seam;
  pair.alignmentConfidence = alignment.confidence;
  pair.alignmentWarning = alignment.ambiguous ? alignment.reason : undefined;
  return alignment;
}

export function resolvedWarpAlignment(doc: RigDoc, pair: WarpPathPair): WarpAlignment {
  const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId)!;
  const targetPart = doc.parts.find((part) => part.id === pair.targetPartId)!;
  const sourcePath = sourcePart.paths.find((path) => path.id === pair.sourcePathId)!;
  const targetPath = targetPart.paths.find((path) => path.id === pair.targetPathId)!;
  if (!sourcePath || !targetPath) return { reverse: false, seam: 0, confidence: 0, ambiguous: true, reason: 'Missing artwork.' };
  if (!warpPairIsStale(doc, pair) && pair.reverse === undefined && pair.seam === undefined && pair.autoSeam !== undefined) {
    return { reverse: !!pair.autoReverse, seam: pair.autoSeam, confidence: pair.alignmentConfidence ?? 0, ambiguous: !!pair.alignmentWarning, reason: pair.alignmentWarning ?? 'Stored spatial match.' };
  }
  const legacyDefaultSeam = pair.sourceFingerprint.startsWith('v1:') && pair.seam === 0 && pair.reverse === undefined && pair.autoSeam === undefined;
  return resolveSubpathAlignment(
    subpathsOf(sourcePath, holderMatrix(doc, sourcePart, sourcePath))[0],
    subpathsOf(targetPath, holderMatrix(doc, targetPart, targetPath))[0],
    pair.reverse, legacyDefaultSeam ? undefined : pair.seam,
  );
}

function restGroupMatrix(doc: RigDoc, part: RigPart): Mat {
  const chain: RigPart[] = [];
  let current: RigPart | null = part;
  while (current) {
    chain.unshift(current);
    current = current.parentId ? doc.parts.find((candidate) => candidate.id === current!.parentId) ?? null : null;
  }
  const poses = chain.map((candidate) =>
    `translate(${candidate.rest.tx},${candidate.rest.ty}) rotate(${candidate.rest.rotate},${candidate.pivot.x},${candidate.pivot.y})`,
  ).join(' ');
  const localPivot = applyMat(invertMat(matrixOfTransform(part.transform)), part.pivot.x, part.pivot.y);
  const inner = `translate(${localPivot.x},${localPivot.y}) scale(${part.rest.sx},${part.rest.sy}) ` +
    `skewX(${part.rest.kx}) skewY(${part.rest.ky}) translate(${-localPivot.x},${-localPivot.y})`;
  return matrixOfTransform(`${poses} ${part.transform} ${inner}`);
}

function holderMatrix(doc: RigDoc, part: RigPart, path: RigPath): Mat {
  return multiply(restGroupMatrix(doc, part), matrixOfTransform(path.transform));
}

function evaluatedHolderMatrix(doc: RigDoc, part: RigPart, path: RigPath, time: number, sampler?: PoseSampler): Mat {
  if (!sampler) return multiply(matrixOfTransform(groupTransformOf(part, time)), matrixOfTransform(path.transform));
  const chain: RigPart[] = [];
  let current = part.parentId ? doc.parts.find((candidate) => candidate.id === part.parentId) ?? null : null;
  while (current) { chain.unshift(current); current = current.parentId ? doc.parts.find((candidate) => candidate.id === current!.parentId) ?? null : null; }
  const pose = (candidate: RigPart) => `translate(${sampler(candidate.id, 'tx')},${sampler(candidate.id, 'ty')}) rotate(${sampler(candidate.id, 'rotate')},${candidate.pivot.x},${candidate.pivot.y})`;
  const localPivot = applyMat(invertMat(matrixOfTransform(part.transform)), part.pivot.x, part.pivot.y);
  const inner = `translate(${localPivot.x},${localPivot.y}) scale(${sampler(part.id, 'sx')},${sampler(part.id, 'sy')}) skewX(${part.rest.kx}) skewY(${part.rest.ky}) translate(${-localPivot.x},${-localPivot.y})`;
  return multiply(matrixOfTransform(`${chain.map(pose).join(' ')} ${pose(part)} ${part.transform} ${inner}`), matrixOfTransform(path.transform));
}

function compileWarpPairWithMatrices(
  doc: RigDoc, pair: WarpPathPair, sourceMatrix: Mat, targetMatrix: Mat,
): { source: PathCmd[]; target: PathCmd[] } {
  const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId);
  const targetPart = doc.parts.find((part) => part.id === pair.targetPartId);
  const sourcePath = sourcePart?.paths.find((path) => path.id === pair.sourcePathId);
  const targetPath = targetPart?.paths.find((path) => path.id === pair.targetPathId);
  if (!sourcePart || !targetPart || !sourcePath || !targetPath) throw new Error('Warp correspondence references missing artwork. Open Warp Setup to repair it.');
  const resolved = resolvedWarpAlignment(doc, pair);
  const source = subpathsOf(sourcePath, sourceMatrix);
  const target = subpathsOf(targetPath, targetMatrix);
  if (source.length !== target.length) throw new Error(`Warp paths "${sourcePath.label}" and "${targetPath.label}" have different compound-path counts.`);
  for (let i = 0; i < source.length; i++) {
    if (source[i].closed !== target[i].closed) throw new Error(`Warp paths "${sourcePath.label}" and "${targetPath.label}" mix open and closed geometry.`);
    alignAndEqualize(source[i], target[i], i === 0 ? resolved.reverse : pair.reverse, i === 0 ? resolved.seam : pair.seam);
  }
  return { source: commandsOf(source), target: commandsOf(target) };
}

/**
 * Normalize both authored endpoints without changing either endpoint's coordinate
 * space. This is the input to independent endpoint evaluation (notably when two rigged
 * variants own different bone chains): normalize first, pose each endpoint through its
 * own rig, then interpolate the resulting document-space geometry.
 */
export function compileWarpEndpointPair(doc: RigDoc, pair: WarpPathPair): { source: PathCmd[]; target: PathCmd[] } {
  const identity = matrixOfTransform('');
  return compileWarpPairWithMatrices(doc, pair, identity, identity);
}

export function compileWarpPathPair(doc: RigDoc, pair: WarpPathPair, time?: number, sampler?: PoseSampler): { source: PathCmd[]; target: PathCmd[] } {
  const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId);
  const targetPart = doc.parts.find((part) => part.id === pair.targetPartId);
  const sourcePath = sourcePart?.paths.find((path) => path.id === pair.sourcePathId);
  const targetPath = targetPart?.paths.find((path) => path.id === pair.targetPathId);
  if (!sourcePart || !targetPart || !sourcePath || !targetPath) throw new Error('Warp correspondence references missing artwork. Open Warp Setup to repair it.');
  const sourceHolder = time === undefined ? holderMatrix(doc, sourcePart, sourcePath) : evaluatedHolderMatrix(doc, sourcePart, sourcePath, time, sampler);
  const targetHolder = time === undefined ? holderMatrix(doc, targetPart, targetPath) : evaluatedHolderMatrix(doc, targetPart, targetPath, time, sampler);
  return compileWarpPairWithMatrices(doc, pair, matrixOfTransform(''), multiply(invertMat(sourceHolder), targetHolder));
}

export function interpolateWarpCommands(source: PathCmd[], target: PathCmd[], amount: number): PathCmd[] {
  if (source.length !== target.length) throw new Error('Warp topology is not compatible.');
  const t = Math.min(1, Math.max(0, amount));
  return source.map((left, index) => {
    const right = target[index];
    if (left.cmd !== right.cmd) throw new Error('Warp topology is not compatible.');
    if (left.cmd === 'Z' || right.cmd === 'Z') return { cmd: 'Z' };
    const mix = (a: number, b: number) => a + (b - a) * t;
    if (left.cmd === 'M' && right.cmd === 'M') return { cmd: 'M', x: mix(left.x, right.x), y: mix(left.y, right.y) };
    if (left.cmd === 'C' && right.cmd === 'C') return {
      cmd: 'C', x1: mix(left.x1, right.x1), y1: mix(left.y1, right.y1),
      x2: mix(left.x2, right.x2), y2: mix(left.y2, right.y2), x: mix(left.x, right.x), y: mix(left.y, right.y),
    };
    throw new Error('Warp topology normalization failed.');
  });
}

export function evaluateWarpPath(doc: RigDoc, pair: WarpPathPair, amount: number, time?: number): string {
  const compiled = compileWarpPathPair(doc, pair, time);
  return serializePath(interpolateWarpCommands(compiled.source, compiled.target, amount));
}

function descendants(doc: RigDoc, rootId: string): RigPart[] {
  const result: RigPart[] = [];
  const visit = (id: string) => {
    const part = doc.parts.find((candidate) => candidate.id === id);
    if (!part) return;
    result.push(part);
    for (const child of doc.parts.filter((candidate) => candidate.parentId === id)) visit(child.id);
  };
  visit(rootId);
  return result;
}

const normalizedName = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export function createWarpDefinition(doc: RigDoc, sourcePartId: string, targetPartId: string, name: string): WarpBuildResult {
  const source = descendants(doc, sourcePartId);
  const target = descendants(doc, targetPartId);
  const pairs: WarpPathPair[] = [];
  const ambiguous: string[] = [];
  const used = new Set<string>();
  for (const sourcePart of source) for (const sourcePath of sourcePart.paths) {
    const matches = target.flatMap((part) => part.paths.map((path) => ({ part, path })))
      .filter(({ path }) => !used.has(path.id) && normalizedName(path.label) === normalizedName(sourcePath.label));
    if (matches.length !== 1) {
      if (matches.length > 1) ambiguous.push(`${sourcePath.label}: ${matches.length} exact-name candidates`);
      continue;
    }
    const match = matches[0];
    used.add(match.path.id);
    pairs.push({
      id: freshId('warp_pair'), sourcePartId: sourcePart.id, sourcePathId: sourcePath.id,
      targetPartId: match.part.id, targetPathId: match.path.id,
      sourceFingerprint: warpPathFingerprint(sourcePath), targetFingerprint: warpPathFingerprint(match.path),
    });
    repairWarpPair(doc, pairs[pairs.length - 1]);
  }
  const unmatchedSource = source.flatMap((part) => part.paths).length - pairs.length;
  const unmatchedTarget = target.flatMap((part) => part.paths).filter((path) => !used.has(path.id)).length;
  const warnings = [
    ...(unmatchedSource ? [`${unmatchedSource} source path${unmatchedSource === 1 ? '' : 's'} will fade out.`] : []),
    ...(unmatchedTarget ? [`${unmatchedTarget} target path${unmatchedTarget === 1 ? '' : 's'} will fade in.`] : []),
  ];
  return {
    definition: { version: 1, id: freshId('warp'), name, sourcePartId, targetPartId, pairs },
    warnings, ambiguous,
  };
}

export function isWarpReferencePart(doc: RigDoc, partId: string): boolean {
  const roots = new Set((doc.warps ?? []).map((warp) => warp.targetPartId));
  let current = doc.parts.find((part) => part.id === partId) ?? null;
  while (current) {
    if (roots.has(current.id)) return true;
    current = current.parentId ? doc.parts.find((part) => part.id === current!.parentId) ?? null : null;
  }
  return false;
}

export function warpForSourcePath(doc: RigDoc, pathId: string): { warp: WarpDefinition; pair: WarpPathPair } | null {
  for (const warp of doc.warps ?? []) {
    const pair = warp.pairs.find((candidate) => candidate.sourcePathId === pathId);
    if (pair) return { warp, pair };
  }
  return null;
}
