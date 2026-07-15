/**
 * THE BYTE-IDENTITY GATE (replaces the deleted exportPipTakePill pipeline, which lived
 * outside the repo's test surface and hardcoded machine-specific paths — user decision
 * 2026-07-13: agent-authored animations now go through the CLI/MCP, never a maintained
 * script). Every behavior-identical wave (refactors especially) must leave this hash
 * untouched; a feature wave that legitimately changes export bytes RE-PINS it in the
 * same commit with the justification in the commit message, after verifying the visual
 * result (the layer-order wave's render-frames verification is the precedent). See
 * docs/PROJECT_PROCESS.md "The gates".
 *
 * The golden doc is deterministic and repo-contained: the bundled sample imported
 * headlessly + a hand-authored clip exercising a representative channel surface
 * (rotate/tx/ty with all four preset easings, a custom bezier, keyed sx/sy, keyed
 * stepped z, keyed opacity, a multi-part spread) + a hidden part + a state machine.
 * Everything the encoder emits conditionally (DrawRules, KeyFrameColor, exclusion)
 * is exercised, so silent encoder drift in ANY of those paths moves the hash.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importSvgHeadless } from '../headless/importSvgHeadless';
import { exportRiv } from '../io/riv';
import { normalizeDoc, RigDoc, RigPart, Clip } from '../core/model';

/** RE-PINNED for headless-import pivot seeding (2026-07-14, from 581d5b1f…): a headless
 *  import now seeds every part whose rotation pivot wasn't recovered to its geometry bbox
 *  center (seedImportedPivots) instead of leaving a (near-)origin placeholder, so this
 *  doc's Node positions (pivots) and pivot-relative baked geometry legitimately moved.
 *  Verified per the re-pin protocol: headless render-frames before/after at 0/300/600/
 *  700/1200ms. The STATIC frames (t=0, t=1200 — every channel at its base) are
 *  PIXEL-IDENTICAL: moving a pivot is render-neutral while rest rotate=0/scale=1. The
 *  only differences (t=300/600/700, ≤1782px, confined to an ~80×40px box on the FACE)
 *  are the keyed `face.sx/sy` scale, which anchors at the pivot — BEFORE it scaled the
 *  face about the SVG origin (eyes splayed down-right, asymmetric); AFTER it scales about
 *  the face's own center (eyes stay symmetric, grows in place). That is the correction
 *  the fix exists for, verified visually. right_arm (keyed rotate, pivot rotation-
 *  recovered so UNCHANGED) and left_arm (keyed translate, pivot-independent) render
 *  byte-identically. The skinned golden below did NOT move (hand-authored doc, no import). */
const GOLDEN_SHA256 = '5f20e55014dbf29abb80a1afefc90c6ecc8fb748ca7b293307f8b770d38595c0';

/** Second pin: the SKELETAL-DEFORMATION surface (skinned-part export wave, 2026-07-13).
 *  The main golden doc has no bones/skin (its hash deliberately did NOT move when the
 *  wave landed — the no-regression proof for boneless docs), so RootBone emission,
 *  Skin/Tendon binds, CubicWeight packing, and per-node overrides need their own
 *  deterministic doc. Pinned after the fixture's articulation was verified pixel-level
 *  in the official @rive-app/canvas runtime (public/riv-check.html's skinnedCheck —
 *  same two-bone bar, inner half holds while the outer half rotates down 90deg). */
const GOLDEN_SKINNED_SHA256 = '92e04a34643836e02f063dfe6b0f474c32f5331b446178714fb3bceb8f686454';

function goldenDoc(): RigDoc {
  const svg = readFileSync(join(__dirname, '../../public/PIP_MASTER.svg'), 'utf8');
  const doc = importSvgHeadless(svg, 'golden');
  const byLabel = (label: string) =>
    doc.parts.find((p) => p.label === label && p.kind === 'art')!;
  const rightArm = byLabel('right_arm');
  const leftArm = byLabel('left_arm');
  const face = byLabel('face');
  const shadow = byLabel('shadow');

  const clip: Clip = {
    name: 'golden',
    duration: 1200,
    tracks: [
      {
        target: rightArm.id,
        channel: 'rotate',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 300, value: -40, easing: 'easeIn' },
          { time: 700, value: 25, easing: 'easeOut' },
          { time: 1200, value: 0, easing: 'easeInOut' },
        ],
      },
      {
        target: leftArm.id,
        channel: 'tx',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          // A custom bezier on the arriving segment (overrides the preset everywhere).
          { time: 600, value: 14, easing: 'easeIn', bezier: [0.2, 0.8, 0.6, 1] },
          { time: 1200, value: 0, easing: 'linear' },
        ],
      },
      {
        target: leftArm.id,
        channel: 'ty',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1200, value: -9, easing: 'easeOut' },
        ],
      },
      {
        target: face.id,
        channel: 'sx',
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 600, value: 1.15, easing: 'easeInOut' },
          { time: 1200, value: 1, easing: 'easeInOut' },
        ],
      },
      {
        target: face.id,
        channel: 'sy',
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 600, value: 0.9, easing: 'easeInOut' },
          { time: 1200, value: 1, easing: 'easeInOut' },
        ],
      },
      {
        target: face.id,
        channel: 'opacity',
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 900, value: 0.35, easing: 'easeOut' },
          { time: 1200, value: 1, easing: 'linear' },
        ],
      },
      {
        target: rightArm.id,
        channel: 'z',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: -3, easing: 'linear' },
          { time: 1000, value: 0, easing: 'linear' },
        ],
      },
    ],
  };
  doc.clips = [clip];
  // Hidden-subtree exclusion path: the standalone shadow part emits nothing.
  shadow.hidden = true;
  doc.stateMachines = [
    {
      id: 'sm_golden',
      name: 'golden_machine',
      inputs: [{ id: 'in_go', name: 'go', type: 'bool', default: false }],
      states: [
        { id: 'st_entry', name: 'Entry', kind: 'entry' },
        { id: 'st_any', name: 'Any', kind: 'any' },
        { id: 'st_exit', name: 'Exit', kind: 'exit' },
        { id: 'st_a', name: 'A', kind: 'animation', clipName: 'golden', loop: true },
      ],
      transitions: [
        { id: 'tr_1', fromId: 'st_entry', toId: 'st_a', durationMs: 0, conditions: [] },
      ],
      listeners: [],
    },
  ] as RigDoc['stateMachines'];
  return normalizeDoc(doc);
}

/** The runtime-verified two-bone limb (public/riv-check.html's skinnedCheck fixture,
 *  plus a per-node override and a keyed bone tx so the RootBone-x mapping and the
 *  override-pinning path are inside the pinned bytes too). Hand-authored — fully
 *  deterministic, no import step. */
function goldenSkinnedDoc(): RigDoc {
  const bone = (
    id: string, label: string, pivot: { x: number; y: number },
    tip: { x: number; y: number }, parentId: string | null,
  ): RigPart => ({
    id, label, kind: 'bone', transform: '', pivot, boneTip: tip, pivotHint: null, parentId,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    paths: [],
  });
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const limb: RigPart = {
    id: 'p_limb', label: 'limb', kind: 'art', transform: '',
    pivot: { x: 50, y: 50 }, pivotHint: null, parentId: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    skin: {
      bones: [
        { id: 'p_b1', restWorldInv: identity, bindSeg: { p: { x: 10, y: 50 }, q: { x: 50, y: 50 } } },
        { id: 'p_b2', restWorldInv: identity, bindSeg: { p: { x: 50, y: 50 }, q: { x: 90, y: 50 } } },
      ],
      overrides: { limb_path: { '2': { a: 'p_b2', b: null, t: 0 } } },
    },
    paths: [{
      id: 'limb_path', label: 'limb_path',
      d: 'M 10,45 L 50,45 L 90,45 L 90,55 L 50,55 L 10,55 Z',
      fill: '#cc3366', fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1,
      transform: '',
    }],
  };
  const bend: Clip = {
    name: 'bend', duration: 1000,
    tracks: [
      {
        target: 'p_b2', channel: 'rotate', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 500, value: 90, easing: 'easeInOut' },
          { time: 1000, value: 0, easing: 'linear' },
        ],
      },
      {
        target: 'p_b1', channel: 'tx', keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1000, value: 4, easing: 'linear' },
        ],
      },
    ],
  };
  return normalizeDoc({
    name: 'golden_skinned', viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts: [
      bone('p_b1', 'b1', { x: 10, y: 50 }, { x: 50, y: 50 }, null),
      bone('p_b2', 'b2', { x: 50, y: 50 }, { x: 90, y: 50 }, 'p_b1'),
      limb,
    ],
    rootPivot: { x: 50, y: 50 }, clips: [bend],
  } as RigDoc);
}

describe('golden .riv byte-identity gate', () => {
  it('the golden doc exports to the exact pinned bytes', () => {
    const bytes = exportRiv(goldenDoc());
    const sha = createHash('sha256').update(bytes).digest('hex');
    // On mismatch, surface the actual hash for the re-pin protocol (see file header).
    if (sha !== GOLDEN_SHA256) console.log(`GOLDEN_ACTUAL=${sha}`);
    expect(sha).toBe(GOLDEN_SHA256);
  });

  it('export is deterministic (two runs, identical bytes)', () => {
    const a = exportRiv(goldenDoc());
    const b = exportRiv(goldenDoc());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('the skinned golden doc exports to the exact pinned bytes', () => {
    const bytes = exportRiv(goldenSkinnedDoc());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== GOLDEN_SKINNED_SHA256) console.log(`GOLDEN_SKINNED_ACTUAL=${sha}`);
    expect(sha).toBe(GOLDEN_SKINNED_SHA256);
  });

  it('skinned export is deterministic (two runs, identical bytes)', () => {
    const a = exportRiv(goldenSkinnedDoc());
    const b = exportRiv(goldenSkinnedDoc());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
