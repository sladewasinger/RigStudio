import { describe, expect, it } from 'vitest';
import { RigDoc, RigPart, RigPath, warpPathFingerprint } from '../core/model';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP, TYPE } from './rivDecoder';

function path(id: string, d: string, transform = ''): RigPath {
  return {
    id, label: id, d, transform, fill: '#3366cc', fillOpacity: 1,
    stroke: null, strokeWidth: 1, strokeOpacity: 1,
  };
}

function part(id: string, paths: RigPath[], hidden = false): RigPart {
  return {
    id, label: id, kind: 'art', transform: '', pivot: { x: 0, y: 0 }, pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    parentId: null, paths, hidden,
  };
}

function warpDoc(): RigDoc {
  const sourcePath = path('source_path', 'M0 0 L10 0 L10 10 L0 10 Z');
  const targetPath = path(
    'target_path',
    'M0 5 C0 2.2 2.2 0 5 0 C7.8 0 10 2.2 10 5 C10 7.8 7.8 10 5 10 Z',
    'translate(20 0)',
  );
  return {
    name: 'warp', viewBox: { x: 0, y: 0, w: 50, h: 20 }, rootPivot: { x: 0, y: 0 },
    parts: [part('source', [sourcePath]), part('target', [targetPath])],
    clips: [{
      name: 'morph', duration: 1000, tracks: [{
        target: 'warp_arm', channel: 'warp', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 1, easing: 'easeInOut' },
        ],
      }],
    }],
    warps: [{
      version: 1, id: 'warp_arm', name: 'Arm', sourcePartId: 'source', targetPartId: 'target',
      pairs: [{
        id: 'pair_arm', sourcePartId: 'source', sourcePathId: sourcePath.id,
        targetPartId: 'target', targetPathId: targetPath.id,
        sourceFingerprint: warpPathFingerprint(sourcePath),
        targetFingerprint: warpPathFingerprint(targetPath),
      }],
    }],
  };
}

describe('exportRiv native vertex warp', () => {
  it('keys all six official CubicDetachedVertex properties on each source vertex', () => {
    const decoded = decodeRiv(exportRiv(warpDoc()));
    const sourceShape = decoded.objects.find(
      (object) => object.typeKey === TYPE.SHAPE && object.props[PROP.NAME] === 'source_path',
    )!;
    const pointsPath = decoded.objects.find(
      (object) => object.typeKey === TYPE.POINTS_PATH && object.props[PROP.PARENT_ID] === sourceShape.index,
    )!;
    const vertices = decoded.objects.filter(
      (object) => object.typeKey === TYPE.CUBIC_VERTEX && object.props[PROP.PARENT_ID] === pointsPath.index,
    );
    expect(vertices).toHaveLength(4);
    expect(decoded.objects.some(
      (object) => object.typeKey === TYPE.SHAPE && object.props[PROP.NAME] === 'target_path',
    )).toBe(false);

    const animation = decoded.animations.find((candidate) => candidate.name === 'morph')!;
    const keyedVertices = animation.objects.filter((object) =>
      vertices.some((vertex) => vertex.index === object.objectId),
    );
    expect(keyedVertices).toHaveLength(24);
    for (const vertex of vertices) {
      const properties = keyedVertices
        .filter((object) => object.objectId === vertex.index)
        .flatMap((object) => object.props.map((property) => property.propertyKey));
      expect(properties.sort((a, b) => a - b)).toEqual([
        PROP.VERT_X, PROP.VERT_Y, PROP.IN_ROT, PROP.IN_DIST, PROP.OUT_ROT, PROP.OUT_DIST,
      ].sort((a, b) => a - b));
    }
  });

  it('writes source-local endpoint values and preserves arriving-key easing', () => {
    const decoded = decodeRiv(exportRiv(warpDoc()));
    const vertex = decoded.objects.find((object) => object.typeKey === TYPE.CUBIC_VERTEX)!;
    const animation = decoded.animations.find((candidate) => candidate.name === 'morph')!;
    const x = animation.objects.find((object) =>
      object.objectId === vertex.index && object.props[0]?.propertyKey === PROP.VERT_X,
    )!.props[0];
    const y = animation.objects.find((object) =>
      object.objectId === vertex.index && object.props[0]?.propertyKey === PROP.VERT_Y,
    )!.props[0];
    expect(x.keyframes.map((key) => key.value)).toEqual([0, 20]);
    expect(y.keyframes.map((key) => key.value)).toEqual([0, 5]);
    expect(x.keyframes[0].interpType).toBe(2);
    expect(x.keyframes[0].interpId).toBeGreaterThanOrEqual(0);
  });

  it('is byte-deterministic', () => {
    expect(Array.from(exportRiv(warpDoc()))).toEqual(Array.from(exportRiv(warpDoc())));
  });
});
