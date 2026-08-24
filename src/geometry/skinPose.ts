import { channelValue, RigDoc, RigPart, WarpPathPair } from '../core/model';
import { PathCmd } from './paths';
import {
  influenceProfileOwner, influenceProfileWeights, overrideWeightRow, Seg,
  skinWeights, SKIN_WEIGHT_POWER,
} from './skin';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from './transforms';
import { PoseSampler } from './pose';
import { compileWarpEndpointPair, interpolateWarpCommands } from './warp';

type CommandPoint = { x: number; y: number; node: number };

function pointsOf(command: PathCmd, index: number): CommandPoint[] {
  if (command.cmd === 'C') return [
    { x: command.x1, y: command.y1, node: Math.max(0, index - 1) },
    { x: command.x2, y: command.y2, node: index },
    { x: command.x, y: command.y, node: index },
  ];
  if (command.cmd === 'Z') return [];
  return [{ x: command.x, y: command.y, node: index }];
}

function fullPoseMatrix(doc: RigDoc, part: RigPart, time: number, sampler?: PoseSampler): Mat {
  const chain: RigPart[] = [];
  let current: RigPart | undefined = part;
  const byId = new Map(doc.parts.map((candidate) => [candidate.id, candidate]));
  while (current) { chain.unshift(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
  const pose = (candidate: RigPart) => {
    const value = (channel: 'tx' | 'ty' | 'rotate') => sampler
      ? sampler(candidate.id, channel)
      : channelValue(candidate, channel, time);
    return `translate(${value('tx')},${value('ty')}) rotate(${value('rotate')},${candidate.pivot.x},${candidate.pivot.y})`;
  };
  return matrixOfTransform(chain.map(pose).join(' '));
}

function boneTransforms(doc: RigDoc, part: RigPart, time: number, sampler?: PoseSampler, stretchEnabled = true) {
  return (part.skin?.bones ?? []).map((bind) => {
    const bone = doc.parts.find((candidate) => candidate.id === bind.id);
    const m = bone
      ? multiply(fullPoseMatrix(doc, bone, time, sampler), bind.restWorldInv)
      : matrixOfTransform('');
    const dx = bind.bindSeg.q.x - bind.bindSeg.p.x;
    const dy = bind.bindSeg.q.y - bind.bindSeg.p.y;
    const bindLength = Math.hypot(dx, dy);
    let ax = 0, ay = 0, stretch = 1;
    if (stretchEnabled && bone && bindLength > 1e-3) {
      ax = dx / bindLength;
      ay = dy / bindLength;
      const pose = fullPoseMatrix(doc, bone, time, sampler);
      const pivot = applyMat(pose, bone.pivot.x, bone.pivot.y);
      const tip = bone.boneTip ? applyMat(pose, bone.boneTip.x, bone.boneTip.y) : null;
      if (tip) stretch = Math.min(5, Math.max(.2, Math.hypot(tip.x - pivot.x, tip.y - pivot.y) / bindLength));
    }
    return { m, bx: bind.bindSeg.p.x, by: bind.bindSeg.p.y, ax, ay, stretch };
  });
}

function mapPoint(
  point: CommandPoint, weights: number[], pin: number, transforms: ReturnType<typeof boneTransforms>,
  pinMatrix: Mat | null,
) {
  let x = 0, y = 0;
  for (let index = 0; index < transforms.length; index++) {
    const transform = transforms[index];
    let sx = point.x, sy = point.y;
    if (transform.stretch !== 1) {
      const along = (sx - transform.bx) * transform.ax + (sy - transform.by) * transform.ay;
      sx += (transform.stretch - 1) * along * transform.ax;
      sy += (transform.stretch - 1) * along * transform.ay;
    }
    x += weights[index] * (transform.m.a * sx + transform.m.c * sy + transform.m.e);
    y += weights[index] * (transform.m.b * sx + transform.m.d * sy + transform.m.f);
  }
  if (pin > 0 && pinMatrix) {
    const rigid = applyMat(pinMatrix, point.x, point.y);
    x += (rigid.x - x) * pin;
    y += (rigid.y - y) * pin;
  }
  return { x, y };
}

/**
 * Evaluate normalized bind geometry through one endpoint's own skin. Unlike the live
 * renderer this is DOM-free and accepts topology-equalized commands, which lets Warp
 * pose source and target rigs independently before interpolating them in document
 * space. Endpoint geometry and handles therefore remain exact even when the two
 * variants have different bind orientations or distinct bone chains.
 */
export function evaluateSkinnedCommands(
  doc: RigDoc, part: RigPart, pathId: string, commands: PathCmd[], time: number,
  sampler?: PoseSampler,
): PathCmd[] {
  if (!part.skin?.bones.length) return commands;
  const samples = commands.flatMap(pointsOf);
  const profile = influenceProfileOwner(doc.parts, part)?.influenceProfile ?? null;
  const automatic = profile
    ? influenceProfileWeights(samples, part.skin.bones, profile)
    : skinWeights(samples, part.skin.bones.map((bone) => bone.bindSeg as Seg), SKIN_WEIGHT_POWER);
  const overrides = part.skin.overrides?.[pathId] ?? {};
  const boneIds = part.skin.bones.map((bone) => bone.id);
  const weights = automatic.map((row, index) => {
    const override = overrides[String(samples[index].node)];
    return override ? overrideWeightRow(boneIds, override) || row : row;
  });
  const pins = samples.map((sample) => {
    const value = overrides[String(sample.node)]?.pin;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : 0;
  });
  const transforms = boneTransforms(doc, part, time, sampler);
  const rigid = fullPoseMatrix(doc, part, time, sampler);
  const pinMatrix = pins.some((value) => value > 0)
    ? part.skin.restWorldInv ? multiply(rigid, part.skin.restWorldInv) : rigid
    : null;
  let offset = 0;
  return commands.map((command, index) => {
    const mapped = pointsOf(command, index).map((point) => {
      const sample = mapPoint(point, weights[offset], pins[offset], transforms, pinMatrix);
      offset++;
      return sample;
    });
    if (command.cmd === 'C') return {
      cmd: 'C', x1: mapped[0].x, y1: mapped[0].y, x2: mapped[1].x, y2: mapped[1].y,
      x: mapped[2].x, y: mapped[2].y,
    };
    if (command.cmd === 'Z') return command;
    return { ...command, x: mapped[0].x, y: mapped[0].y } as PathCmd;
  });
}

/**
 * Convert a desired document-space pose into animated carrier bind coordinates. Rive
 * will subsequently apply the carrier's Skin/Tendons, so this inverse compensation is
 * what prevents a held carrier bone rotation from post-rotating the 100% target. Rive
 * does not animate bone length, hence stretch is deliberately disabled here.
 */
export function compensateForCarrierSkin(
  doc: RigDoc, part: RigPart, pathId: string, carrierBind: PathCmd[], desired: PathCmd[],
  time: number, sampler?: PoseSampler,
): PathCmd[] {
  if (!part.skin?.bones.length) return desired;
  const sourceSamples = carrierBind.flatMap(pointsOf);
  const desiredSamples = desired.flatMap(pointsOf);
  if (sourceSamples.length !== desiredSamples.length) throw new Error('Warp skin compensation topology mismatch.');
  const profile = influenceProfileOwner(doc.parts, part)?.influenceProfile ?? null;
  const automatic = profile
    ? influenceProfileWeights(sourceSamples, part.skin.bones, profile)
    : skinWeights(sourceSamples, part.skin.bones.map((bone) => bone.bindSeg as Seg), SKIN_WEIGHT_POWER);
  const overrides = part.skin.overrides?.[pathId] ?? {};
  const boneIds = part.skin.bones.map((bone) => bone.id);
  const transforms = boneTransforms(doc, part, time, sampler, false);
  const rigid = fullPoseMatrix(doc, part, time, sampler);
  const pinMatrix = part.skin.restWorldInv ? multiply(rigid, part.skin.restWorldInv) : rigid;
  const compensated = sourceSamples.map((sample, index) => {
    const override = overrides[String(sample.node)];
    const weights = override ? overrideWeightRow(boneIds, override) || automatic[index] : automatic[index];
    const rawPin = override?.pin;
    const pin = Number.isFinite(rawPin) ? Math.min(1, Math.max(0, rawPin!)) : 0;
    const blended: Mat = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
    transforms.forEach(({ m }, boneIndex) => {
      const weight = weights[boneIndex] * (1 - pin);
      blended.a += m.a * weight; blended.b += m.b * weight;
      blended.c += m.c * weight; blended.d += m.d * weight;
      blended.e += m.e * weight; blended.f += m.f * weight;
    });
    if (pin > 0) {
      blended.a += pinMatrix.a * pin; blended.b += pinMatrix.b * pin;
      blended.c += pinMatrix.c * pin; blended.d += pinMatrix.d * pin;
      blended.e += pinMatrix.e * pin; blended.f += pinMatrix.f * pin;
    }
    return applyMat(invertMat(blended), desiredSamples[index].x, desiredSamples[index].y);
  });
  let offset = 0;
  const result: PathCmd[] = carrierBind.map((command): PathCmd => {
    if (command.cmd === 'C') return {
      cmd: 'C' as const, x1: compensated[offset].x, y1: compensated[offset++].y,
      x2: compensated[offset].x, y2: compensated[offset++].y,
      x: compensated[offset].x, y: compensated[offset++].y,
    };
    if (command.cmd === 'Z') return command;
    return { ...command, x: compensated[offset].x, y: compensated[offset++].y } as PathCmd;
  });
  // Rive represents a closed subpath with one vertex for the seam. Our cubic command
  // stream may also contain an explicit final curve back to M; force that duplicate
  // endpoint onto the compensated M so pathToLocalSubpaths folds it exactly as it does
  // for the static carrier. The closing curve's independently compensated incoming
  // handle is retained, so tangent fidelity is unaffected.
  let start: { x: number; y: number } | null = null;
  let bindStart: { x: number; y: number } | null = null;
  for (let index = 0; index < result.length; index++) {
    const command = result[index];
    const bindCommand = carrierBind[index];
    if (command.cmd === 'M' && bindCommand.cmd === 'M') {
      start = { x: command.x, y: command.y };
      bindStart = { x: bindCommand.x, y: bindCommand.y };
    }
    else if (command.cmd === 'Z') {
      const previous = result[index - 1];
      const bindPrevious = carrierBind[index - 1];
      if (start && bindStart && previous?.cmd === 'C' && bindPrevious?.cmd === 'C') {
        const explicitClose = Math.hypot(bindPrevious.x - bindStart.x, bindPrevious.y - bindStart.y) < 1e-3;
        if (explicitClose) { previous.x = start.x; previous.y = start.y; }
        else if (Math.hypot(previous.x - start.x, previous.y - start.y) < 1e-3) {
          const dx = bindPrevious.x - bindStart.x, dy = bindPrevious.y - bindStart.y;
          const length = Math.hypot(dx, dy) || 1;
          previous.x = start.x + dx / length * .002;
          previous.y = start.y + dy / length * .002;
        }
      }
      start = null; bindStart = null;
    }
  }
  return result;
}

/** Endpoint-exact Warp evaluation for two independently rigged variants. */
export function evaluateRiggedWarpCommands(
  doc: RigDoc, pair: WarpPathPair, amount: number, time: number, sampler?: PoseSampler,
): { source: PathCmd[]; target: PathCmd[]; current: PathCmd[] } {
  const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId);
  const targetPart = doc.parts.find((part) => part.id === pair.targetPartId);
  if (!sourcePart?.skin || !targetPart?.skin) {
    throw new Error('Rigged Warp endpoints must both have compatible bindings. Bind the unrigged endpoint or repair the Warp.');
  }
  const normalized = compileWarpEndpointPair(doc, pair);
  const source = evaluateSkinnedCommands(doc, sourcePart, pair.sourcePathId, normalized.source, time, sampler);
  const target = evaluateSkinnedCommands(doc, targetPart, pair.targetPathId, normalized.target, time, sampler);
  return { source, target, current: interpolateWarpCommands(source, target, amount) };
}
