/**
 * H1b shared-math pin: `geometry/pose.ts` is the pure pose kernel extracted from
 * `view/pose.ts`; the live canvas now calls through a thin delegator (see that file's
 * header). This test proves the delegation wiring is exact — every `view/pose.ts`
 * export must return byte-identical output to calling `geometry/pose.ts` directly with
 * no sampler override — against the bundled PIP_MASTER sample (real bone-ish parenting,
 * e.g. eyes -> face and a nested body-in-body) plus a synthetic clip keying
 * rotate/tx/ty/sx/sy across several parts, not a toy single-part fixture.
 */
import { describe, expect, it } from 'vitest';
import PIP_SVG from '../../public/PIP_MASTER.svg?raw';
import { Clip, normalizeDoc, state, Track } from '../core/model';
import * as viewPose from '../view/pose';
import * as geomPose from '../geometry/pose';
import { importSvgHeadless } from '../headless/importSvgHeadless';
import { makeTrack } from './helpers';

function buildFixtureDoc() {
  const doc = importSvgHeadless(PIP_SVG, 'PIP_MASTER');
  normalizeDoc(doc);

  // Two parts share the label 'body' (an authored nested body-in-body) — grab both by
  // position rather than by (ambiguous) label.
  const bodies = doc.parts.filter((p) => p.label === 'body');
  const nestedBody = bodies[1] ?? bodies[0];
  const idOf = (label: string): string => {
    const part = doc.parts.find((p) => p.label === label);
    if (!part) throw new Error(`fixture part not found: ${label}`);
    return part.id;
  };

  const tracks: Track[] = [
    makeTrack(idOf('right_arm'), 'rotate', [[0, 0, 'linear'], [500, 45, 'easeOut'], [1000, -20, 'easeIn']]),
    makeTrack(idOf('right_arm'), 'tx', [[0, 0, 'linear'], [500, 10, 'linear']]),
    makeTrack(idOf('left_leg'), 'rotate', [[0, 0, 'linear'], [1000, 15, 'easeInOut']]),
    makeTrack(idOf('eyes'), 'sy', [[0, 1, 'linear'], [300, 0.1, 'linear'], [600, 1, 'linear']]),
    makeTrack(idOf('face'), 'ty', [[0, 0, 'linear'], [1000, 5, 'linear']]),
    makeTrack(nestedBody.id, 'sx', [[0, 1, 'linear'], [500, 1.2, 'linear']]),
  ];

  const clip: Clip = { name: 'test_clip', duration: 1000, tracks };
  doc.clips = [clip];
  return { doc, clip, nestedBody };
}

describe('geometry/pose.ts <-> view/pose.ts delegation', () => {
  it('every pose function agrees between the pure kernel and the view delegator', () => {
    const { doc, clip, nestedBody } = buildFixtureDoc();
    state.doc = doc;
    state.activeClipIndex = 0;

    const times = [0, 150, 300, 500, 600, 1000, null] as const;
    const sampleLabels = ['right_arm', 'left_leg', 'eyes', 'face', 'shadow'];
    const parts = [
      ...sampleLabels.map((label) => {
        const part = doc.parts.find((p) => p.label === label);
        if (!part) throw new Error(`fixture part not found: ${label}`);
        return part;
      }),
      nestedBody,
    ];

    expect(clip.tracks.length).toBeGreaterThan(0); // sanity: the fixture is actually keyed

    for (const part of parts) {
      for (const t of times) {
        expect(viewPose.groupTransformOf(part, t)).toBe(geomPose.groupTransformOf(part, t));
        expect(viewPose.fullPoseTransform(part, t)).toBe(geomPose.fullPoseTransform(part, t));
        expect(viewPose.ownPoseTransform(part, t)).toBe(geomPose.ownPoseTransform(part, t));
        expect(viewPose.innerLocalTransform(part, t)).toBe(geomPose.innerLocalTransform(part, t));
        expect(viewPose.effectiveScaleX(part, t)).toBe(geomPose.effectiveScaleX(part, t));
        expect(viewPose.effectiveScaleY(part, t)).toBe(geomPose.effectiveScaleY(part, t));
        expect(viewPose.effectiveZ(part, t)).toBe(geomPose.effectiveZ(part, t));
        expect(viewPose.effectiveOpacity(part, t)).toBe(geomPose.effectiveOpacity(part, t));
        expect(viewPose.effectivePivot(part, t)).toEqual(geomPose.effectivePivot(part, t));
        expect(viewPose.effectiveTip(part, t)).toEqual(geomPose.effectiveTip(part, t));
        expect(viewPose.chainMatOf(part, t)).toEqual(geomPose.chainMatOf(part, t));
        expect(viewPose.ownTranslateOf(part, t)).toEqual(geomPose.ownTranslateOf(part, t));
        expect(viewPose.localPivotOf(part)).toEqual(geomPose.localPivotOf(part));
      }
    }

    // Root transform doesn't take a part — checked once per time directly.
    for (const t of times) {
      expect(viewPose.rootPoseTransform(t)).toBe(geomPose.rootPoseTransform(t));
    }
  });

  it('sanity: the keyed tracks actually vary the output across sampled times (the pin above is not vacuously comparing constants)', () => {
    const { doc } = buildFixtureDoc();
    state.doc = doc;
    state.activeClipIndex = 0;
    const rightArm = doc.parts.find((p) => p.label === 'right_arm')!;
    const restTransform = geomPose.groupTransformOf(rightArm, 0);
    const raisedTransform = geomPose.groupTransformOf(rightArm, 500);
    expect(restTransform).not.toBe(raisedTransform);
  });
});
