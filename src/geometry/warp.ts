import { RigDoc, RigPart, RigPath, WarpDefinition, WarpPathPair } from '../core/docTypes';
import { freshId } from '../core/idGen';
import { parsePath, pathToCubics, serializePath, PathCmd } from './paths';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from './transforms';
import { groupTransformOf, PoseSampler } from './pose';

type Cubic = Extract<PathCmd, { cmd: 'C' }>;
type Subpath = { start: { x: number; y: number }; curves: Cubic[]; closed: boolean };
export type WarpCandidate = { sourcePartId: string; sourcePathId: string; targetPartId: string; targetPathId: string; confidence: 'exact'; reason: string };
export type WarpBuildResult = { definition: WarpDefinition; warnings: string[]; ambiguous: string[] };

const cubicLine = (a: { x: number; y: number }, b: { x: number; y: number }): Cubic => ({
  cmd: 'C', x1: a.x + (b.x - a.x) / 3, y1: a.y + (b.y - a.y) / 3,
  x2: a.x + 2 * (b.x - a.x) / 3, y2: a.y + 2 * (b.y - a.y) / 3, x: b.x, y: b.y,
});

function subpathsOf(path: RigPath, matrix: Mat): Subpath[] {
  const commands = pathToCubics(parsePath(path.d));
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
    } else if (command.cmd === 'Z' && current) current.closed = true;
  }
  if (current) result.push(current);
  return result;
}

const midpoint = (a: number, b: number) => (a + b) / 2;

function split(curve: Cubic, start: { x: number; y: number }): [Cubic, Cubic] {
  const a = { x: midpoint(start.x, curve.x1), y: midpoint(start.y, curve.y1) };
  const b = { x: midpoint(curve.x1, curve.x2), y: midpoint(curve.y1, curve.y2) };
  const c = { x: midpoint(curve.x2, curve.x), y: midpoint(curve.y2, curve.y) };
  const d = { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) };
  const e = { x: midpoint(b.x, c.x), y: midpoint(b.y, c.y) };
  const p = { x: midpoint(d.x, e.x), y: midpoint(d.y, e.y) };
  return [
    { cmd: 'C', x1: a.x, y1: a.y, x2: d.x, y2: d.y, x: p.x, y: p.y },
    { cmd: 'C', x1: e.x, y1: e.y, x2: c.x, y2: c.y, x: curve.x, y: curve.y },
  ];
}

function splitLongest(subpath: Subpath): void {
  let start = subpath.start;
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < subpath.curves.length; i++) {
    const curve = subpath.curves[i];
    const length = Math.hypot(curve.x1 - start.x, curve.y1 - start.y) +
      Math.hypot(curve.x2 - curve.x1, curve.y2 - curve.y1) +
      Math.hypot(curve.x - curve.x2, curve.y - curve.y2);
    if (length > bestLength) { best = i; bestLength = length; }
    start = { x: curve.x, y: curve.y };
  }
  start = best === 0 ? subpath.start : { x: subpath.curves[best - 1].x, y: subpath.curves[best - 1].y };
  subpath.curves.splice(best, 1, ...split(subpath.curves[best], start));
}

function rotateClosed(subpath: Subpath, seam: number): void {
  if (!subpath.closed || subpath.curves.length === 0) return;
  const amount = ((seam % subpath.curves.length) + subpath.curves.length) % subpath.curves.length;
  if (!amount) return;
  const curves = [...subpath.curves.slice(amount), ...subpath.curves.slice(0, amount)];
  const previous = subpath.curves[(amount - 1 + subpath.curves.length) % subpath.curves.length];
  subpath.start = { x: previous.x, y: previous.y };
  subpath.curves = curves;
}

function reverseSubpath(subpath: Subpath): void {
  const points = [subpath.start, ...subpath.curves.map((curve) => ({ x: curve.x, y: curve.y }))];
  const curves = subpath.curves.map((curve, index) => ({ curve, start: points[index] })).reverse();
  subpath.start = points[points.length - 1];
  subpath.curves = curves.map(({ curve, start }) => ({
    cmd: 'C', x1: curve.x2, y1: curve.y2, x2: curve.x1, y2: curve.y1, x: start.x, y: start.y,
  }));
}

function commandsOf(subpaths: Subpath[]): PathCmd[] {
  return subpaths.flatMap((subpath) => [
    { cmd: 'M' as const, x: subpath.start.x, y: subpath.start.y },
    ...subpath.curves,
    ...(subpath.closed ? [{ cmd: 'Z' as const }] : []),
  ]);
}

function topology(path: RigPath): string {
  const subs = subpathsOf(path, matrixOfTransform(''));
  return subs.map((subpath) => `${subpath.closed ? 'c' : 'o'}:${subpath.curves.length}`).join('|');
}

export function warpPathFingerprint(path: RigPath): string {
  return `v1:${topology(path)}`;
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
  if (warpPathFingerprint(sourcePath) !== pair.sourceFingerprint || warpPathFingerprint(targetPath) !== pair.targetFingerprint) {
    throw new Error(`Warp correspondence "${sourcePath.label} ↔ ${targetPath.label}" is stale after a topology edit. Open Warp Setup and rebuild it.`);
  }
  const source = subpathsOf(sourcePath, sourceMatrix);
  const target = subpathsOf(targetPath, targetMatrix);
  if (source.length !== target.length) throw new Error(`Warp paths "${sourcePath.label}" and "${targetPath.label}" have different compound-path counts.`);
  for (let i = 0; i < source.length; i++) {
    if (source[i].closed !== target[i].closed) throw new Error(`Warp paths "${sourcePath.label}" and "${targetPath.label}" mix open and closed geometry.`);
    if (pair.reverse) reverseSubpath(target[i]);
    rotateClosed(target[i], pair.seam ?? 0);
    const count = Math.max(source[i].curves.length, target[i].curves.length);
    while (source[i].curves.length < count) splitLongest(source[i]);
    while (target[i].curves.length < count) splitLongest(target[i]);
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
