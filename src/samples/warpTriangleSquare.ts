import { RigDoc } from '../core/model';
import { warpPathFingerprint } from '../geometry/warp';

export const WARP_TRIANGLE_SQUARE_SAMPLE = {
  id: 'warp-triangle-square',
  name: 'Triangle ↔ Square',
  description: 'A grouped shape and hard shadow warping from triangle to square and back.',
  fileName: 'WARP_TRIANGLE_SQUARE.rig.json',
} as const;

const rest = () => ({
  rotate: 0,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
  kx: 0,
  ky: 0,
  opacity: 1,
});

export function createWarpTriangleSquareSample(): RigDoc {
  const trianglePath = 'M 128,48 L 128,48 L 224,216 L 32,216 Z';
  const triangleShadowPath = 'M 128,48 L 128,48 L 224,216 L 174,216 Z';
  const squarePath = 'M 40,40 L 216,40 L 216,216 L 40,216 Z';
  const squareShadowPath = 'M 142,40 L 216,40 L 216,216 L 142,216 Z';

  return {
    name: 'Triangle to Square Warp',
    viewBox: { x: 0, y: 0, w: 256, h: 256 },
    artboard: { enabled: true, x: 0, y: 0, w: 256, h: 256 },
    rootPivot: { x: 128, y: 128 },
    fps: 60,
    parts: [
      {
        id: 'triangle_group', label: 'Triangle', kind: 'group', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: null,
        boneTip: null, skin: null, paths: [],
        childOrder: [
          { kind: 'part', id: 'triangle_shape' },
          { kind: 'part', id: 'triangle_shadow' },
        ],
      },
      {
        id: 'triangle_shape', label: 'shape', kind: 'art', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: 'triangle_group',
        boneTip: null, skin: null,
        paths: [{
          id: 'triangle_shape_path', label: 'Main', d: trianglePath,
          fill: '#6C63FF', fillOpacity: 1, stroke: '#2D285F', strokeWidth: 5,
          strokeOpacity: 1, transform: '', nodeTypes: 'cccc',
        }],
        childOrder: [{ kind: 'path', id: 'triangle_shape_path' }],
      },
      {
        id: 'triangle_shadow', label: 'shadow', kind: 'art', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: 'triangle_group',
        boneTip: null, skin: null,
        paths: [{
          id: 'triangle_shadow_path', label: 'Hard shadow', d: triangleShadowPath,
          fill: '#443DA8', fillOpacity: 1, stroke: null, strokeWidth: 0,
          strokeOpacity: 1, transform: '', nodeTypes: 'cccc',
        }],
        childOrder: [{ kind: 'path', id: 'triangle_shadow_path' }],
      },
      {
        id: 'square_group', label: 'Square', kind: 'group', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: null,
        boneTip: null, skin: null, paths: [],
        childOrder: [
          { kind: 'part', id: 'square_shape' },
          { kind: 'part', id: 'square_shadow' },
        ],
      },
      {
        id: 'square_shape', label: 'shape', kind: 'art', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: 'square_group',
        boneTip: null, skin: null,
        paths: [{
          id: 'square_shape_path', label: 'Main', d: squarePath,
          fill: '#FF8A5B', fillOpacity: 1, stroke: '#6E2F25', strokeWidth: 5,
          strokeOpacity: 1, transform: '', nodeTypes: 'cccc',
        }],
        childOrder: [{ kind: 'path', id: 'square_shape_path' }],
      },
      {
        id: 'square_shadow', label: 'shadow', kind: 'art', transform: '',
        pivot: { x: 128, y: 128 }, pivotHint: null, rest: rest(), parentId: 'square_group',
        boneTip: null, skin: null,
        paths: [{
          id: 'square_shadow_path', label: 'Hard shadow', d: squareShadowPath,
          fill: '#C5533E', fillOpacity: 1, stroke: null, strokeWidth: 0,
          strokeOpacity: 1, transform: '', nodeTypes: 'cccc',
        }],
        childOrder: [{ kind: 'path', id: 'square_shadow_path' }],
      },
    ],
    warps: [{
      version: 1,
      id: 'triangle_to_square',
      name: 'Triangle ↔ Square',
      sourcePartId: 'triangle_group',
      targetPartId: 'square_group',
      pairs: [
        {
          id: 'warp_main',
          sourcePartId: 'triangle_shape',
          sourcePathId: 'triangle_shape_path',
          targetPartId: 'square_shape',
          targetPathId: 'square_shape_path',
          sourceFingerprint: warpPathFingerprint({
            id: 'triangle_shape_path', label: 'Main', d: trianglePath,
            fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '',
          }),
          targetFingerprint: warpPathFingerprint({
            id: 'square_shape_path', label: 'Main', d: squarePath,
            fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '',
          }),
          seam: 0,
        },
        {
          id: 'warp_shadow',
          sourcePartId: 'triangle_shadow',
          sourcePathId: 'triangle_shadow_path',
          targetPartId: 'square_shadow',
          targetPathId: 'square_shadow_path',
          sourceFingerprint: warpPathFingerprint({
            id: 'triangle_shadow_path', label: 'Hard shadow', d: triangleShadowPath,
            fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '',
          }),
          targetFingerprint: warpPathFingerprint({
            id: 'square_shadow_path', label: 'Hard shadow', d: squareShadowPath,
            fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '',
          }),
          seam: 0,
        },
      ],
    }],
    clips: [{
      name: 'Triangle to Square to Triangle',
      duration: 2000,
      loop: true,
      tracks: [{
        target: 'triangle_to_square',
        channel: 'warp',
        keyframes: [
          { time: 0, value: 0, easing: 'easeInOut' },
          { time: 1000, value: 1, easing: 'easeInOut' },
          { time: 2000, value: 0, easing: 'easeInOut' },
        ],
      }],
    }],
    stateMachines: [],
  };
}
