/**
 * Headless "take a pill" animation pipeline for Pip.
 *
 * Imports the master Pip artwork (Dosey's `media/PIP_MASTER.svg`) into a RigDoc, adds a
 * two-tone capsule pill in Pip's right hand, authors a single one-shot `take_pill` clip
 * (arm raises the pill to the mouth, the pill is swallowed, a gulp settles the body back
 * to rest), and exports:
 *   - `pip_take_pill.riv`  -> rig-studio/out/  AND  Dosey app res/raw/
 *   - `pip_take_pill.rig.json` (the "Save project" serialization) -> Dosey media/
 *
 * All choreography geometry (shoulder pivot, hand position, mouth target, arm-raise
 * angle, pill rest position, eye-blink pivot) is COMPUTED from the imported doc so the
 * script is repeatable against the real artwork — nothing about the pose is hard-coded.
 *
 * Runs headlessly: importSvg needs a DOMParser, which `ensureDomParser()` polyfills from
 * jsdom when the module runs under plain Node. Under Vitest's jsdom environment (the
 * `export:take-pill` npm script) DOMParser already exists and the polyfill is a no-op.
 *
 * NOTE on the model: parts animate rotate/tx/ty and (with the small exportRiv change in
 * this change-set) sx/sy. Part scale is what drives the pill's swallow and the eye blink.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Clip,
  Easing,
  Keyframe,
  RigDoc,
  RigPart,
  RigPath,
  Track,
  freshId,
  normalizeDoc,
  serializeDoc,
} from '../src/core/model';
import { importSvg } from '../src/io/importSvg';
import { exportRiv } from '../src/io/exportRiv';
import { Mat, applyMat, matrixOfTransform, multiply } from '../src/geometry/transforms';
import { parsePath } from '../src/geometry/paths';

// ---- File locations ----

export const SVG_SOURCE = 'C:/Users/Austin/AndroidStudioProjects/Dosey/media/PIP_MASTER.svg';
export const OUT_RIV_LOCAL = 'D:/repos/rig-studio/out/pip_take_pill.riv';
export const OUT_RIV_DOSEY =
  'C:/Users/Austin/AndroidStudioProjects/Dosey/app/src/main/res/raw/pip_take_pill.riv';
export const OUT_RIG_JSON =
  'C:/Users/Austin/AndroidStudioProjects/Dosey/media/pip_take_pill.rig.json';

// ---- Clip design (ms) ----

const CLIP_NAME = 'take_pill';
const CLIP_DURATION = 1600;

// Two-tone pill (the app's signature capsule).
const PILL_CREAM = '#FCF8F2';
const PILL_CORAL = '#E2664C';
const PILL_OUTLINE = '#2B2733';
const PILL_STROKE_W = 1.5;
const PILL_HALF_W = 5; // capsule ~10 wide
const PILL_STRAIGHT_HALF_H = 5; // + two r=5 caps => ~20 tall
const PILL_CAP_R = 5;

// Whole-figure squash pivots on the ground contact (the shadow ellipse centre).
const GROUND: Vec2 = { x: 104.75617, y: 231.7932 };

interface Vec2 {
  x: number;
  y: number;
}

// ---- Small geometry helpers ----

/** Every anchor + control point of a path's absolute command list, in its own space. */
function pathPoints(d: string): Vec2[] {
  const pts: Vec2[] = [];
  for (const c of parsePath(d)) {
    if (c.cmd === 'M' || c.cmd === 'L' || c.cmd === 'A') pts.push({ x: c.x, y: c.y });
    else if (c.cmd === 'C') pts.push({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x, y: c.y });
  }
  return pts;
}

function transformPoints(m: Mat, pts: Vec2[]): Vec2[] {
  return pts.map((p) => applyMat(m, p.x, p.y));
}

function bboxCenter(pts: Vec2[]): Vec2 {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Wrap degrees into (-180, 180]. */
function wrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

// ---- Doc queries ----

function partByLabel(doc: RigDoc, label: string): RigPart {
  const p = doc.parts.find((x) => x.label === label);
  if (!p) throw new Error(`part not found: ${label}`);
  return p;
}

/** The full baked matrix Rive/Lottie would use for a path (part chain, then path). No
 *  rest scale/skew on freshly imported parts, so this is just the two transforms. */
function bakedPathMatrix(part: RigPart, pth: RigPath): Mat {
  return multiply(matrixOfTransform(part.transform), matrixOfTransform(pth.transform));
}

// ---- Pill artwork ----

/** Author the two-tone vertical capsule in DOC space, centred on `c`. Three paths:
 *  cream top half, coral bottom half, dark outline (topmost). */
function pillPaths(c: Vec2): RigPath[] {
  const f = (n: number) => n.toFixed(4);
  const L = c.x - PILL_HALF_W;
  const R = c.x + PILL_HALF_W;
  const top = c.y - PILL_STRAIGHT_HALF_H;
  const bot = c.y + PILL_STRAIGHT_HALF_H;
  const r = PILL_CAP_R;
  const mk = (label: string, d: string, fill: string | null, stroke: string | null): RigPath => ({
    id: freshId('path'),
    label,
    d,
    nodeTypes: null,
    fill,
    fillOpacity: 1,
    stroke,
    strokeWidth: PILL_STROKE_W,
    strokeOpacity: 1,
    transform: '',
  });
  // sweep=1 caps bulge outward (up over the top, down under the bottom) in +y-down space.
  const cream = `M ${f(L)},${f(top)} A ${r} ${r} 0 0 1 ${f(R)},${f(top)} L ${f(R)},${f(c.y)} L ${f(L)},${f(c.y)} Z`;
  const coral = `M ${f(L)},${f(c.y)} L ${f(R)},${f(c.y)} L ${f(R)},${f(bot)} A ${r} ${r} 0 0 1 ${f(L)},${f(bot)} Z`;
  const outline = `M ${f(L)},${f(top)} A ${r} ${r} 0 0 1 ${f(R)},${f(top)} L ${f(R)},${f(bot)} A ${r} ${r} 0 0 1 ${f(L)},${f(bot)} Z`;
  return [
    mk('pill_top', cream, PILL_CREAM, null),
    mk('pill_bottom', coral, PILL_CORAL, null),
    mk('pill_outline', outline, null, PILL_OUTLINE),
  ];
}

// ---- Clip authoring ----

const kf = (time: number, value: number, easing: Easing = 'easeInOut'): Keyframe => ({
  time,
  value,
  easing,
});
const track = (target: string, channel: Track['channel'], keyframes: Keyframe[]): Track => ({
  target,
  channel,
  keyframes,
});

/** Volume-preserving companion width for a vertical squash `s` (mirrors PipRig.kt). */
const squashX = (s: number): number => 1 + (1 - s) * 0.7;

interface Choreo {
  leanGroupId: string;
  rightArmId: string;
  pillId: string;
  eyesId: string;
  armRaiseDeg: number;
}

function buildTakePillClip(c: Choreo): Clip {
  const { leanGroupId, rightArmId, pillId, eyesId, armRaiseDeg } = c;

  // Whole-figure squash timeline (about the ground), values of the vertical scale.
  const sy: Array<[number, number, Easing]> = [
    [0, 1.0, 'easeInOut'],
    [150, 0.97, 'easeOut'], // anticipation dip
    [700, 0.99, 'easeInOut'], // arrival, nearly settled
    [950, 1.0, 'easeInOut'],
    [1050, 0.88, 'easeIn'], // gulp: squash
    [1200, 1.06, 'easeOut'], // gulp: stretch
    [1350, 1.0, 'easeInOut'], // settle
    [1600, 1.0, 'easeInOut'], // rest
  ];

  const tracks: Track[] = [
    // Lean group: whole-figure lean toward the raising arm + the squash/stretch.
    track(leanGroupId, 'rotate', [
      kf(0, 0, 'easeInOut'),
      kf(150, 0, 'easeInOut'),
      kf(700, -2, 'easeOut'),
      kf(950, -2, 'easeInOut'),
      kf(1350, 0, 'easeInOut'),
      kf(1600, 0, 'easeInOut'),
    ]),
    track(leanGroupId, 'sy', sy.map(([t, v, e]) => kf(t, v, e))),
    track(leanGroupId, 'sx', sy.map(([t, v, e]) => kf(t, squashX(v), e))),

    // Right arm: rest -> raise the hand (and pill) to the mouth -> return to rest.
    track(rightArmId, 'rotate', [
      kf(0, 0, 'easeInOut'),
      kf(150, 0, 'easeInOut'), // hold through the anticipation
      kf(700, armRaiseDeg, 'easeOut'), // ease-out arrival at the mouth
      kf(950, armRaiseDeg, 'easeInOut'), // hold while swallowing
      kf(1350, 0, 'easeInOut'), // ease-in-out return
      kf(1600, 0, 'easeInOut'), // settle at rest
    ]),

    // Pill: full size in the hand, then scale to zero at the mouth (swallowed). It is
    // unique to this clip (not in the looping idle asset), so it legitimately ends at 0.
    track(pillId, 'sx', [kf(0, 1, 'easeInOut'), kf(700, 1, 'easeInOut'), kf(950, 0, 'easeIn'), kf(1600, 0, 'easeInOut')]),
    track(pillId, 'sy', [kf(0, 1, 'easeInOut'), kf(700, 1, 'easeInOut'), kf(950, 0, 'easeIn'), kf(1600, 0, 'easeInOut')]),

    // Eyes: one blink (vertical scale dip) as the pill goes down; back to rest.
    track(eyesId, 'sy', [kf(700, 1, 'easeInOut'), kf(800, 0.1, 'easeInOut'), kf(900, 1, 'easeInOut')]),
  ];

  return { name: CLIP_NAME, duration: CLIP_DURATION, loop: false, tracks };
}

// ---- Assembly ----

export interface BuildResult {
  doc: RigDoc;
  riv: Uint8Array;
  meta: {
    parts: Array<{ label: string; kind: string; parent: string | null; pivot: Vec2; paths: number }>;
    shoulder: Vec2;
    hand: Vec2;
    mouth: Vec2;
    eyesPivot: Vec2;
    pillRest: Vec2;
    armRaiseDeg: number;
    handRadius: number;
    mouthRadius: number;
  };
}

/** Import + rig + author, returning the finished (normalized) doc and its .riv bytes. */
export function buildTakePillProject(svgText: string): BuildResult {
  const doc = importSvg(svgText, 'pip_take_pill');

  const rightArm = partByLabel(doc, 'right_arm');
  const face = partByLabel(doc, 'face');
  const eyes = partByLabel(doc, 'eyes');

  // Shoulder pivot straight from the import (rotate(...) fixed point of the arm group).
  const shoulder: Vec2 = { x: rightArm.pivot.x, y: rightArm.pivot.y };

  // Hand: farthest arm-artwork point from the shoulder, in the drawn (rest) pose.
  const armPath = rightArm.paths.find((p) => p.label === 'arm') ?? rightArm.paths[0];
  const armDocPts = transformPoints(bakedPathMatrix(rightArm, armPath), pathPoints(armPath.d));
  const hand = armDocPts.reduce((far, p) => (dist(p, shoulder) > dist(far, shoulder) ? p : far), armDocPts[0]);

  // Mouth: doc-space centre of the mouth path (a direct path of the face group). Pick the
  // face's own mouth path (the one that is not the eyes) — it carries no eyes children.
  const mouthPath = face.paths[0];
  const mouth = bboxCenter(transformPoints(matrixOfTransform(face.transform), pathPoints(mouthPath.d)));

  // Eyes pivot: doc-space centre of both eye ellipses so the blink scales in place.
  const eyeDocPts = eyes.paths.flatMap((p) =>
    transformPoints(matrixOfTransform(eyes.transform), pathPoints(p.d)),
  );
  const eyesPivot = bboxCenter(eyeDocPts);
  eyes.pivot = eyesPivot;

  // Arm-raise angle: aim the hand direction at the mouth. Pill sits on that ray at the
  // mouth's radius, so the SAME rotation lands the pill exactly on the mouth.
  const a0 = Math.atan2(hand.y - shoulder.y, hand.x - shoulder.x);
  const a1 = Math.atan2(mouth.y - shoulder.y, mouth.x - shoulder.x);
  const armRaiseDeg = wrapDeg(((a1 - a0) * 180) / Math.PI);
  const mouthRadius = dist(mouth, shoulder);
  const pillRest: Vec2 = { x: shoulder.x + mouthRadius * Math.cos(a0), y: shoulder.y + mouthRadius * Math.sin(a0) };

  // Pill part: child of the right arm (rides its rotation), pivot at its own centre so
  // the swallow scale shrinks it in place.
  const pill: RigPart = {
    id: freshId('part'),
    label: 'pill',
    kind: 'art',
    transform: '',
    pivot: { ...pillRest },
    pivotHint: null,
    boneTip: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
    parentId: rightArm.id,
    paths: pillPaths(pillRest),
  };
  doc.parts.push(pill); // last in the array => topmost drawable (in Pip's hand, on top)

  // Lean/squash group at the ground: parent every visible body part to it (NOT the
  // shadow — it stays static on the ground) so one node leans + squashes the whole figure.
  const topLevelIds = doc.parts
    .filter((p) => p.parentId === null && p.label !== 'shadow' && p.id !== pill.id)
    .map((p) => p.id);
  const leanGroup: RigPart = {
    id: freshId('part'),
    label: 'lean_pivot',
    kind: 'group',
    transform: '',
    pivot: { ...GROUND },
    pivotHint: null,
    boneTip: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
    parentId: null,
    paths: [],
  };
  doc.parts.unshift(leanGroup); // partless => draw order unaffected; keep it first for clarity
  for (const id of topLevelIds) {
    const p = doc.parts.find((x) => x.id === id)!;
    p.parentId = leanGroup.id;
  }

  // Single one-shot clip.
  doc.clips = [
    buildTakePillClip({
      leanGroupId: leanGroup.id,
      rightArmId: rightArm.id,
      pillId: pill.id,
      eyesId: eyes.id,
      armRaiseDeg,
    }),
  ];

  normalizeDoc(doc); // fill back-compat defaults exactly as an app load would

  const riv = exportRiv(doc);

  return {
    doc,
    riv,
    meta: {
      parts: doc.parts.map((p) => ({
        label: p.label,
        kind: p.kind,
        parent: p.parentId ? doc.parts.find((x) => x.id === p.parentId)?.label ?? p.parentId : null,
        pivot: p.pivot,
        paths: p.paths.length,
      })),
      shoulder,
      hand,
      mouth,
      eyesPivot,
      pillRest,
      armRaiseDeg,
      handRadius: dist(hand, shoulder),
      mouthRadius,
    },
  };
}

// ---- File I/O (the actual "run") ----

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export interface RunResult extends BuildResult {
  wrote: string[];
}

/** Read the SVG, build everything, and write the three artifacts. */
export function run(): RunResult {
  const svgText = fs.readFileSync(SVG_SOURCE, 'utf8');
  const built = buildTakePillProject(svgText);

  for (const out of [OUT_RIV_LOCAL, OUT_RIV_DOSEY]) {
    ensureDir(out);
    fs.writeFileSync(out, built.riv);
  }
  ensureDir(OUT_RIG_JSON);
  fs.writeFileSync(OUT_RIG_JSON, serializeDoc(built.doc), 'utf8');

  return { ...built, wrote: [OUT_RIV_LOCAL, OUT_RIV_DOSEY, OUT_RIG_JSON] };
}

/** Polyfill DOMParser from jsdom when running under plain Node (no-op under jsdom envs). */
export async function ensureDomParser(): Promise<void> {
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser !== 'undefined') return;
  const { JSDOM } = await import('jsdom');
  (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM().window.DOMParser;
}
