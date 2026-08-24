import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deserializeDoc, sampleKeyList, serializeDoc, state } from '../core/model';
import { compileWarpEndpointPair } from '../geometry/warp';
import { evaluateRiggedWarpCommands, evaluateSkinnedCommands } from '../geometry/skinPose';
import { PathCmd } from '../geometry/paths';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP, TYPE } from './rivDecoder';

const projectText = readFileSync(new URL('./fixtures/pip-failing-warp-test.json', import.meta.url), 'utf8');

function points(commands: PathCmd[]) {
  return commands.flatMap((command) => command.cmd === 'C'
    ? [{ x: command.x1, y: command.y1 }, { x: command.x2, y: command.y2 }, { x: command.x, y: command.y }]
    : command.cmd === 'Z' ? [] : [{ x: command.x, y: command.y }]);
}

function bounds(commands: PathCmd[]) {
  const all = points(commands);
  const xs = all.map((point) => point.x), ys = all.map((point) => point.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function expectCommandsClose(actual: PathCmd[], expected: PathCmd[]) {
  expect(actual).toHaveLength(expected.length);
  const left = points(actual), right = points(expected);
  expect(left).toHaveLength(right.length);
  left.forEach((point, index) => {
    expect(point.x).toBeCloseTo(right[index].x, 7);
    expect(point.y).toBeCloseTo(right[index].y, 7);
  });
}

describe('Pip independently-rigged arm Warp regression', () => {
  it('loads the real failing project through current migration with its distinct arm rigs intact', () => {
    const doc = deserializeDoc(projectText);
    expect(doc.warps).toHaveLength(1);
    expect(doc.parts.find((part) => part.id === 'part_876')?.skin?.bones.map((bone) => bone.id)).toEqual(['part_905', 'part_907', 'part_909']);
    expect(doc.parts.find((part) => part.id === 'part_879')?.skin?.bones.map((bone) => bone.id)).toEqual(['part_911', 'part_913', 'part_915']);
    expect(serializeDoc(deserializeDoc(serializeDoc(doc)))).toBe(serializeDoc(doc));
  });

  it('ends the forward transition at the target rig pose instead of post-rotating it through the carrier rig', () => {
    const doc = deserializeDoc(projectText);
    state.doc = doc; state.activeClipIndex = 0;
    const warp = doc.warps![0], pair = warp.pairs.find((candidate) => candidate.sourcePathId === 'path_877')!;
    const normalized = compileWarpEndpointPair(doc, pair);
    const targetPart = doc.parts.find((part) => part.id === pair.targetPartId)!;
    const expectedTarget = evaluateSkinnedCommands(doc, targetPart, pair.targetPathId, normalized.target, 662);
    const evaluated = evaluateRiggedWarpCommands(doc, pair, 1, 662);
    expectCommandsClose(evaluated.current, expectedTarget);
    const box = bounds(evaluated.current);
    expect(box.w).toBeGreaterThan(box.h * 2.5);
  });

  it('is exact at both endpoints across the real 0→100→0 sequence and keeps the shadow coherent', () => {
    const doc = deserializeDoc(projectText);
    state.doc = doc; state.activeClipIndex = 0;
    const warp = doc.warps![0];
    const warpTrack = doc.clips[0].tracks.find((track) => track.target === warp.id && track.channel === 'warp')!;
    for (const time of [314, 662, 900, 1155]) {
      const amount = sampleKeyList(warpTrack.keyframes, time, 0);
      for (const pair of warp.pairs) {
        const evaluated = evaluateRiggedWarpCommands(doc, pair, amount, time);
        if (amount === 0) expectCommandsClose(evaluated.current, evaluated.source);
        if (amount === 1) expectCommandsClose(evaluated.current, evaluated.target);
        expect(points(evaluated.current).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      }
      const arm = bounds(evaluateRiggedWarpCommands(doc, warp.pairs[0], amount, time).current);
      const shadow = bounds(evaluateRiggedWarpCommands(doc, warp.pairs[1], amount, time).current);
      expect(Math.abs((arm.x + arm.w / 2) - (shadow.x + shadow.w / 2))).toBeLessThan(22);
      expect(Math.abs((arm.y + arm.h / 2) - (shadow.y + shadow.h / 2))).toBeLessThan(22);
    }
    const reversed = evaluateRiggedWarpCommands(doc, warp.pairs[0], 0, 1155);
    expect(bounds(reversed.current).w).toBeGreaterThan(bounds(reversed.current).h * 2);
  });

  it('exports the real rig as native skinned vertex keys without a duplicate target drawable', () => {
    const doc = deserializeDoc(projectText);
    const decoded = decodeRiv(exportRiv(doc));
    expect(decoded.objects.some((object) => object.typeKey === TYPE.SHAPE && object.props[PROP.NAME] === 'arm')).toBe(true);
    expect(decoded.objects.some((object) => object.typeKey === TYPE.NODE && object.props[PROP.NAME] === 'left_arm_sideways')).toBe(true);
    expect(decoded.objects.some((object) => object.typeKey === TYPE.NODE && object.props[PROP.NAME] === 'left_arm')).toBe(false);
    const animation = decoded.animations.find((candidate) => candidate.name === 'idle')!;
    const vertexKeys = animation.objects.filter((object) =>
      [PROP.VERT_X, PROP.VERT_Y, PROP.IN_ROT, PROP.IN_DIST, PROP.OUT_ROT, PROP.OUT_DIST]
        .includes(object.props[0]?.propertyKey),
    );
    expect(vertexKeys.length).toBeGreaterThan(20);
    expect(vertexKeys.every((object) => object.props[0].keyframes.every((key) => Number.isFinite(key.value)))).toBe(true);
  });
});
