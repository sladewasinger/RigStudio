import { describe, expect, it } from 'vitest';
import SAMPLE_PROJECT from '../../public/WARP_TRIANGLE_SQUARE.rig.json?raw';
import { deserializeDoc, normalizeDoc, sampleKeyList } from '../core/model';
import { evaluateWarpPath, warpPathFingerprint } from '../geometry/warp';
import {
  createWarpTriangleSquareSample,
  WARP_TRIANGLE_SQUARE_SAMPLE,
} from '../samples/warpTriangleSquare';
import { exportRiv } from '../io/riv';

describe('Triangle ↔ Square warp sample', () => {
  it('is discoverable and its public project matches the factory', () => {
    expect(WARP_TRIANGLE_SQUARE_SAMPLE).toEqual(expect.objectContaining({
      id: 'warp-triangle-square',
      name: 'Triangle ↔ Square',
      fileName: 'WARP_TRIANGLE_SQUARE.rig.json',
    }));

    const publicDoc = deserializeDoc(SAMPLE_PROJECT);
    const factoryDoc = normalizeDoc(createWarpTriangleSquareSample());
    expect(publicDoc).toEqual(factoryDoc);
  });

  it('contains two grouped endpoints with paired shape and shadow artwork', () => {
    const doc = createWarpTriangleSquareSample();
    const warp = doc.warps?.[0];
    expect(warp).toBeTruthy();
    expect(doc.parts.filter((part) => part.kind === 'group').map((part) => part.label))
      .toEqual(['Triangle', 'Square', 'Rigged arm · side hand', 'Arm variant · open palm']);

    for (const rootId of ['triangle_group', 'square_group']) {
      expect(doc.parts.filter((part) => part.parentId === rootId).map((part) => part.label))
        .toEqual(['shape', 'shadow']);
    }
    expect(warp?.pairs.map((pair) => pair.id)).toEqual(['warp_main', 'warp_shadow']);
    for (const pair of warp?.pairs ?? []) {
      const source = doc.parts.find((part) => part.id === pair.sourcePartId)?.paths
        .find((path) => path.id === pair.sourcePathId);
      const target = doc.parts.find((part) => part.id === pair.targetPartId)?.paths
        .find((path) => path.id === pair.targetPathId);
      expect(source && warpPathFingerprint(source)).toBe(pair.sourceFingerprint);
      expect(target && warpPathFingerprint(target)).toBe(pair.targetFingerprint);
    }
  });

  it('includes an editable shared-chain arm and combined showcase animation', () => {
    const doc = createWarpTriangleSquareSample();
    const armWarp = doc.warps!.find((warp) => warp.id === 'arm_side_to_palm')!;
    expect(armWarp.pairs).toHaveLength(3);
    expect(doc.parts.find((part) => part.id === 'arm_side_shape')!.skin!.bones.map((bone) => bone.id))
      .toEqual(['arm_shoulder', 'arm_wrist', 'arm_hand']);
    expect(doc.parts.find((part) => part.id === 'arm_side_shadow')!.skin!.bones.map((bone) => bone.id))
      .toEqual(['arm_shoulder', 'arm_wrist', 'arm_hand']);
    expect(doc.parts.find((part) => part.id === 'arm_palm_shape')!.skin!.bones.map((bone) => bone.id))
      .toEqual(['arm_shoulder', 'arm_wrist', 'arm_hand']);
    const showcase = doc.clips.find((clip) => clip.name === 'Warp Showcase · Shapes + Rigged Arm')!;
    expect(showcase.tracks.map((track) => `${track.target}.${track.channel}`)).toEqual(expect.arrayContaining([
      'triangle_group.rotate', 'triangle_to_square.warp', 'arm_shoulder.rotate',
      'arm_wrist.rotate', 'arm_hand.rotate', 'arm_side_to_palm.warp',
    ]));
    expect(exportRiv(doc).byteLength).toBeGreaterThan(1000);
  });

  it('plays Triangle to Square to Triangle and compiles its unequal node counts', () => {
    const doc = createWarpTriangleSquareSample();
    const clip = doc.clips[0];
    const track = clip.tracks[0];
    expect(track.target).toBe('triangle_to_square');
    expect(track.channel).toBe('warp');
    expect([0, 1000, 2000].map((time) => sampleKeyList(track.keyframes, time, 0)))
      .toEqual([0, 1, 0]);

    const pair = doc.warps![0].pairs[0];
    const start = evaluateWarpPath(doc, pair, 0);
    const middle = evaluateWarpPath(doc, pair, 0.5);
    const end = evaluateWarpPath(doc, pair, 1);
    expect(new Set([start, middle, end]).size).toBe(3);
    expect(start.match(/C/g)?.length).toBe(4);
    expect(end.match(/C/g)?.length).toBe(4);
  });
});
