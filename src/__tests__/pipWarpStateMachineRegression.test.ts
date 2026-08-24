import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deserializeDoc, sampleKeyList, state } from '../core/model';
import { createSMInstance } from '../core/stateMachine';
import { evaluateRiggedWarpCommands } from '../geometry/skinPose';
import { PathCmd } from '../geometry/paths';
import { exportRiv } from '../io/riv';
import { riveFramePoseSampler, stateMachinePoseCompleteClips } from '../io/riv/animation';
import { decodeRiv, PROP } from './rivDecoder';

const projectText = readFileSync(
  new URL('./fixtures/pip-warp-state-machine.json', import.meta.url), 'utf8',
);

function points(commands: PathCmd[]) {
  return commands.flatMap((command) => command.cmd === 'C'
    ? [{ x: command.x1, y: command.y1 }, { x: command.x2, y: command.y2 }, { x: command.x, y: command.y }]
    : command.cmd === 'Z' ? [] : [{ x: command.x, y: command.y }]);
}

function maxError(actual: PathCmd[], expected: PathCmd[]): number {
  const left = points(actual), right = points(expected);
  expect(left).toHaveLength(right.length);
  return Math.max(...left.map((point, index) => Math.hypot(
    point.x - right[index].x, point.y - right[index].y,
  )));
}

describe('real Pip Warp state-machine and Rive parity', () => {
  it('builds export-only pose closure so idle actively resets every hold_pill property', () => {
    const doc = deserializeDoc(projectText);
    const authoredIdle = doc.clips[0];
    expect(authoredIdle.tracks.some((track) => track.target === 'warp_1248')).toBe(false);
    const completed = stateMachinePoseCompleteClips(doc);
    const idle = completed.get('idle')!;
    const hold = completed.get('hold_pill')!;
    const keys = (clip: typeof idle) => new Set(clip.tracks.map((track) => `${track.target}|${track.channel}`));
    expect(keys(idle)).toEqual(keys(hold));
    const idleWarp = idle.tracks.find((track) => track.target === 'warp_1248' && track.channel === 'warp')!;
    expect(idleWarp.keyframes.map((key) => [key.time, key.value])).toEqual([[0, 0], [3000, 0]]);
    expect(doc.clips[0], 'closure never mutates authored lanes').toBe(authoredIdle);
    expect(doc.clips[0].tracks.some((track) => track.target === 'warp_1248')).toBe(false);
  });

  it('drives the hold_pill Warp channel through the machine trigger and blends from rest', () => {
    const doc = deserializeDoc(projectText);
    const machine = doc.stateMachines![0];
    const runtime = createSMInstance(doc, machine);
    expect(runtime.status().stateId).toBe('state_1210');

    runtime.fireTrigger('trigger_pill');
    runtime.advance(0);
    expect(runtime.status().stateId).toBe('state_1213');
    expect(runtime.channelValue('warp_1248', 'warp')).toBe(0);

    runtime.advance(250);
    // 500ms state blend: idle has no Warp channel (rest 0), hold_pill is also still 0.
    expect(runtime.status().blend?.progress).toBeCloseTo(.5, 8);
    expect(runtime.channelValue('warp_1248', 'warp')).toBe(0);
    runtime.advance(570);
    expect(runtime.status().blend).toBeNull();
    expect(runtime.channelValue('warp_1248', 'warp')).toBeCloseTo(1, 8);

    runtime.fireTrigger('trigger_idle');
    runtime.advance(0);
    runtime.advance(500);
    expect(runtime.status().stateId).toBe('state_1210');
    expect(runtime.channelValue('warp_1248', 'warp')).toBe(0);
  });

  it('bakes Warp compensation against Rive integer-frame bone timing without duplicate frames', () => {
    const doc = deserializeDoc(projectText);
    state.doc = doc;
    state.activeClipIndex = 1;
    const clip = doc.clips[1];
    const fps = doc.fps ?? 60;
    const warp = doc.warps![0];
    const warpTrack = clip.tracks.find((track) => track.target === warp.id && track.channel === 'warp')!;
    let observedClockDrift = 0;

    for (const frame of [35, 42, 49, 90, 308, 326]) {
      const time = frame / fps * 1000;
      const amount = sampleKeyList(warpTrack.keyframes, time, 0);
      const runtimeSampler = riveFramePoseSampler(doc, clip, time);
      const runtimeAmount = runtimeSampler(warp.id, 'warp');
      for (const pair of warp.pairs) {
        const editorClock = evaluateRiggedWarpCommands(doc, pair, amount, time).current;
        const riveClock = evaluateRiggedWarpCommands(
          doc, pair, runtimeAmount, time, runtimeSampler,
        ).current;
        observedClockDrift = Math.max(observedClockDrift, maxError(editorClock, riveClock));
      }
    }
    expect(observedClockDrift, 'millisecond sampling differs measurably from native frame timing')
      .toBeGreaterThan(.01);

    const decoded = decodeRiv(exportRiv(doc));
    const animation = decoded.animations.find((candidate) => candidate.name === 'hold_pill')!;
    const vertexProperties = animation.objects.flatMap((object) => object.props).filter((property) =>
      [PROP.VERT_X, PROP.VERT_Y, PROP.IN_ROT, PROP.IN_DIST, PROP.OUT_ROT, PROP.OUT_DIST]
        .includes(property.propertyKey));
    expect(vertexProperties.length).toBeGreaterThan(0);
    for (const property of vertexProperties) {
      const frames = property.keyframes.map((key) => key.frame);
      expect(new Set(frames).size).toBe(frames.length);
      expect(frames[0]).toBe(0);
      expect(frames[frames.length - 1]).toBe(Math.round(clip.duration / 1000 * fps));
    }

    const idleAnimation = decoded.animations.find((candidate) => candidate.name === 'idle')!;
    const propertySet = (animation: typeof idleAnimation) => new Set(animation.objects.flatMap((object) =>
      object.props.map((property) => `${object.objectId}|${property.propertyKey}`)));
    const idleProperties = propertySet(idleAnimation);
    for (const property of propertySet(animation)) {
      expect(idleProperties.has(property), `idle resets native property ${property}`).toBe(true);
    }
  });
});
