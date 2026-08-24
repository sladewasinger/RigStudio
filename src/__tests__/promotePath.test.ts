import { afterEach, describe, expect, it } from 'vitest';
import {
  promotePathToPart, RigDoc, RigPart, RigPath, serializeDoc, deserializeDoc, state,
  setKeyframeAt, warpPathFingerprint,
} from '../core/model';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP, TYPE } from './rivDecoder';

const path = (id: string): RigPath => ({
  id, label: id, d: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', fill: '#000000',
  fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '',
});
const part = (id: string, paths: RigPath[], parentId: string | null = null): RigPart => ({
  id, label: id, kind: 'art', transform: '', pivot: { x: 5, y: 5 }, pivotHint: null,
  rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
  parentId, paths, childOrder: paths.map((item) => ({ kind: 'path', id: item.id })),
});

afterEach(() => { state.doc = null; });

describe('promotePathToPart', () => {
  it('preserves path identity/order and retargets Warp while giving the leaf durable channels', () => {
    const owner = part('eyes', [path('right_eye'), path('left_eye')]);
    const target = part('target', [path('target_eye')]);
    const doc: RigDoc = {
      name: 'leaf', viewBox: { x: 0, y: 0, w: 100, h: 100 }, parts: [owner, target],
      rootPivot: { x: 50, y: 50 }, clips: [{ name: 'blink', duration: 1000, tracks: [] }],
      warps: [{
        version: 1, id: 'warp', name: 'eye', sourcePartId: owner.id, targetPartId: target.id,
        pairs: [{
          id: 'pair', sourcePartId: owner.id, sourcePathId: 'left_eye',
          targetPartId: target.id, targetPathId: 'target_eye',
          sourceFingerprint: warpPathFingerprint(owner.paths[1]),
          targetFingerprint: warpPathFingerprint(target.paths[0]),
        }],
      }],
    };
    state.doc = doc;
    const leaf = promotePathToPart(owner, 'left_eye')!;
    expect(owner.paths.map((item) => item.id)).toEqual(['right_eye']);
    expect(leaf.parentId).toBe(owner.id);
    expect(leaf.paths.map((item) => item.id)).toEqual(['left_eye']);
    expect(owner.childOrder).toEqual([
      { kind: 'path', id: 'right_eye' }, { kind: 'part', id: leaf.id },
    ]);
    expect(doc.warps![0].pairs[0].sourcePartId).toBe(leaf.id);

    setKeyframeAt(leaf.id, 'sx', 0, 1, 'linear');
    setKeyframeAt(leaf.id, 'sx', 1000, 0.25, 'easeInOut');
    const restored = deserializeDoc(serializeDoc(doc));
    expect(restored.parts.find((candidate) => candidate.id === leaf.id)?.paths[0].id).toBe('left_eye');
    expect(restored.clips[0].tracks.find((track) => track.target === leaf.id && track.channel === 'sx')
      ?.keyframes.map((key) => key.value)).toEqual([1, 0.25]);
    expect(restored.warps![0].pairs[0].sourcePartId).toBe(leaf.id);

    restored.warps = [];
    const decoded = decodeRiv(exportRiv(restored));
    const leafNode = decoded.objects.find(
      (object) => object.typeKey === TYPE.NODE && object.props[PROP.NAME] === 'left_eye',
    )!;
    const scale = decoded.animations.find((animation) => animation.name === 'blink')!
      .objects.find((object) => object.objectId === leafNode.index)!
      .props.find((property) => property.propertyKey === PROP.SCALE_X)!;
    expect(scale.keyframes.map((key) => key.value)).toEqual([1, 0.25]);
  });
});
