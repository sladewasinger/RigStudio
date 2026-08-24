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
  const armSidePath = 'M 280,106 C330,92 390,92 462,104 L 462,122 C390,116 330,122 280,126 Z';
  const armPalmPath = 'M 280,106 C330,92 390,92 438,102 C466,84 486,92 478,110 C494,112 494,126 476,128 C444,132 394,122 280,126 Z';
  const armShadowPath = 'M 284,120 C340,112 402,112 462,116 L 462,124 C400,122 338,130 284,130 Z';
  const palmShadowPath = 'M 284,120 C350,112 414,116 478,122 L 476,130 C414,132 350,128 284,130 Z';
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const armBones = [
    { id: 'arm_shoulder', restWorldInv: identity, bindSeg: { p: { x: 280, y: 116 }, q: { x: 370, y: 112 } } },
    { id: 'arm_wrist', restWorldInv: identity, bindSeg: { p: { x: 370, y: 112 }, q: { x: 462, y: 113 } } },
  ];

  return {
    name: 'Triangle to Square Warp',
    viewBox: { x: 0, y: 0, w: 512, h: 256 },
    artboard: { enabled: true, x: 0, y: 0, w: 512, h: 256 },
    rootPivot: { x: 256, y: 128 },
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
      { id: 'arm_shoulder', label: 'Arm shoulder', kind: 'bone', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: null, boneTip: { x: 370, y: 112 }, skin: null, paths: [] },
      { id: 'arm_wrist', label: 'Arm wrist', kind: 'bone', transform: '', pivot: { x: 370, y: 112 }, pivotHint: null, rest: rest(), parentId: 'arm_shoulder', boneTip: { x: 462, y: 113 }, skin: null, paths: [] },
      { id: 'arm_side_group', label: 'Rigged arm · side hand', kind: 'group', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: null, boneTip: null, skin: null, paths: [] },
      { id: 'arm_side_shape', label: 'shape', kind: 'art', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: 'arm_side_group', boneTip: null, skin: { bones: armBones }, paths: [{ id: 'arm_side_path', label: 'arm silhouette', d: armSidePath, fill: '#65C5D3', fillOpacity: 1, stroke: '#173F4A', strokeWidth: 4, strokeOpacity: 1, transform: '' }] },
      { id: 'arm_side_shadow', label: 'shadow', kind: 'art', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: 'arm_side_group', boneTip: null, skin: { bones: structuredClone(armBones) }, paths: [{ id: 'arm_shadow_path', label: 'hard shadow', d: armShadowPath, fill: '#287B8B', fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }] },
      { id: 'arm_palm_group', label: 'Arm variant · open palm', kind: 'group', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: null, boneTip: null, skin: null, paths: [] },
      { id: 'arm_palm_shape', label: 'shape', kind: 'art', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: 'arm_palm_group', boneTip: null, skin: null, paths: [{ id: 'arm_palm_path', label: 'arm silhouette', d: armPalmPath, fill: '#F0C36A', fillOpacity: 1, stroke: '#62491F', strokeWidth: 4, strokeOpacity: 1, transform: '' }] },
      { id: 'arm_palm_shadow', label: 'shadow', kind: 'art', transform: '', pivot: { x: 280, y: 116 }, pivotHint: null, rest: rest(), parentId: 'arm_palm_group', boneTip: null, skin: null, paths: [{ id: 'palm_shadow_path', label: 'hard shadow', d: palmShadowPath, fill: '#A66F2D', fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }] },
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
    }, {
      version: 1, id: 'arm_side_to_palm', name: 'Side hand ↔ Open palm', sourcePartId: 'arm_side_group', targetPartId: 'arm_palm_group', pairs: [
        { id: 'arm_shape_pair', sourcePartId: 'arm_side_shape', sourcePathId: 'arm_side_path', targetPartId: 'arm_palm_shape', targetPathId: 'arm_palm_path', sourceFingerprint: warpPathFingerprint({ id: '', label: '', d: armSidePath, fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }), targetFingerprint: warpPathFingerprint({ id: '', label: '', d: armPalmPath, fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }) },
        { id: 'arm_shadow_pair', sourcePartId: 'arm_side_shadow', sourcePathId: 'arm_shadow_path', targetPartId: 'arm_palm_shadow', targetPathId: 'palm_shadow_path', sourceFingerprint: warpPathFingerprint({ id: '', label: '', d: armShadowPath, fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }), targetFingerprint: warpPathFingerprint({ id: '', label: '', d: palmShadowPath, fill: null, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' }) },
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
    }, {
      name: 'Rotated Triangle to Square',
      duration: 3000,
      loop: true,
      tracks: [{
        target: 'triangle_group', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'easeInOut' },
          { time: 500, value: 45, easing: 'easeInOut' },
          { time: 3000, value: 45, easing: 'linear' },
        ],
      }, {
        target: 'triangle_to_square', channel: 'warp', keyframes: [
          { time: 500, value: 0, easing: 'easeInOut' },
          { time: 1500, value: 1, easing: 'easeInOut' },
          { time: 2500, value: 0, easing: 'easeInOut' },
        ],
      }],
    }, {
      name: 'Warp Showcase · Shapes + Rigged Arm', duration: 4000, loop: true, tracks: [
        { target: 'triangle_group', channel: 'rotate', keyframes: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 500, value: 45, easing: 'easeInOut' }, { time: 4000, value: 45, easing: 'linear' }] },
        { target: 'triangle_to_square', channel: 'warp', keyframes: [{ time: 500, value: 0, easing: 'easeInOut' }, { time: 1500, value: 1, easing: 'easeInOut' }, { time: 2000, value: 1, easing: 'linear' }, { time: 3500, value: 0, easing: 'easeInOut' }] },
        { target: 'arm_shoulder', channel: 'rotate', keyframes: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 700, value: -24, easing: 'easeInOut' }, { time: 4000, value: -24, easing: 'linear' }] },
        { target: 'arm_wrist', channel: 'rotate', keyframes: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 700, value: 32, easing: 'easeInOut' }, { time: 2200, value: 20, easing: 'easeInOut' }, { time: 2700, value: 42, easing: 'easeInOut' }, { time: 4000, value: 32, easing: 'easeInOut' }] },
        { target: 'arm_side_to_palm', channel: 'warp', keyframes: [{ time: 700, value: 0, easing: 'easeInOut' }, { time: 1700, value: 1, easing: 'easeInOut' }, { time: 3300, value: 0, easing: 'easeInOut' }] },
      ],
    }],
    stateMachines: [],
  };
}
