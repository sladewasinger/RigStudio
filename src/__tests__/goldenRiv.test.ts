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
import { normalizeDoc, RigDoc, Clip } from '../core/model';

const GOLDEN_SHA256 = 'a1c6ff4b7e97d94293cf50c2d936115cff409aaf07a5968ddafb00a37511e3c6';

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
});
