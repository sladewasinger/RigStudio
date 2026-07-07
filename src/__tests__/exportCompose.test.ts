/**
 * Tests for the Compose (Kotlin) exporter. Builds small RigDocs with the shared
 * helpers and asserts on the generated source text: mood enum, pivot constants,
 * pose.at() rest-value defaults, parent-chain transform ordering, rest-scale
 * emission, and the arriving-key easing → `using` suffix mapping.
 */

import { describe, expect, it } from 'vitest';
import { exportCompose } from '../exportCompose';
import { Clip, RigPart } from '../model';
import { makeClip, makeDoc, makePart, makeTrack } from './helpers';

const PKG = 'com.example.rig';

function armPart(overrides: Partial<RigPart> = {}): RigPart {
  return makePart('p_arm', { label: 'arm', pivot: { x: 10, y: 20 }, ...overrides });
}

function exportDoc(parts: RigPart[], clips?: Clip[]): string {
  return exportCompose(makeDoc(parts, clips), PKG);
}

describe('exportCompose structure', () => {
  it('emits the package line and a mood enum entry per clip', () => {
    const code = exportDoc(
      [armPart()],
      [makeClip({ name: 'idle' }), makeClip({ name: 'wave dance' })],
    );
    expect(code.startsWith(`package ${PKG}`)).toBe(true);
    expect(code).toContain('enum class TestMood {'); // doc name 'test' → Test
    expect(code).toContain('    IDLE,');
    expect(code).toContain('    WAVE_DANCE,');
    // ...and the mood → choreography dispatch with camelCased names.
    expect(code).toContain('TestMood.IDLE -> idlePose(transition)');
    expect(code).toContain('TestMood.WAVE_DANCE -> waveDancePose(transition)');
    expect(code).toContain(
      'private fun waveDancePose(transition: InfiniteTransition): Map<String, Float> {',
    );
  });

  it('emits one Pivot_ Offset constant per part plus RootPivot', () => {
    const code = exportDoc([
      armPart(),
      makePart('p_body', { label: 'body', pivot: { x: 50, y: 60 } }),
    ]);
    expect(code).toContain('private val Pivot_arm = Offset(10f, 20f)');
    expect(code).toContain('private val Pivot_body = Offset(50f, 60f)');
    expect(code).toContain('private val RootPivot = Offset(50f, 80f)'); // makeDoc rootPivot
  });

  it('emits root figure translate/scale lines reading root.* pose channels', () => {
    const code = exportDoc([armPart()]);
    expect(code).toContain('translate(pose.at("root.tx"), pose.at("root.ty"))');
    expect(code).toContain(
      'scale(pose.at("root.sx", 1f), pose.at("root.sy", 1f), pivot = RootPivot)',
    );
  });
});

describe('exportCompose choreography', () => {
  it('animates keyed channels under "label.channel" with first/last endpoint values', () => {
    const track = makeTrack('p_arm', 'rotate', [
      [0, 0, 'linear'],
      [1000, 4, 'linear'],
    ]);
    const code = exportDoc([armPart()], [makeClip({ duration: 1000, tracks: [track] })]);
    expect(code).toContain('pose["arm.rotate"] = transition.animateFloat('); // id → label
    expect(code).toContain('        0f, 4f,');
    expect(code).toContain('durationMillis = 1000');
    expect(code).toContain('label = "arm.rotate"');
  });

  it('keys root tracks as "root.channel"', () => {
    const track = makeTrack('root', 'tx', [
      [0, 0, 'linear'],
      [1000, 5, 'linear'],
    ]);
    const code = exportDoc([armPart()], [makeClip({ tracks: [track] })]);
    expect(code).toContain('pose["root.tx"] = transition.animateFloat(');
  });

  it('maps the ARRIVING key easing to the `using` suffix of the previous keyframe line', () => {
    const track = makeTrack('p_arm', 'rotate', [
      [0, 0, 'linear'],
      [250, 1, 'easeInOut'],
      [500, 2, 'easeOut'],
      [750, 3, 'easeIn'],
      [1000, 4, 'linear'],
    ]);
    const code = exportDoc([armPart()], [makeClip({ duration: 1000, tracks: [track] })]);
    expect(code).toContain('0f at 0 using FastOutSlowInEasing'); // arriving easeInOut
    expect(code).toContain('1f at 250 using LinearOutSlowInEasing'); // arriving easeOut
    expect(code).toContain('2f at 500 using FastOutLinearInEasing'); // arriving easeIn
    expect(code).toContain('3f at 750\n'); // arriving linear → no suffix
    expect(code).toContain('4f at 1000\n'); // last key → no suffix
  });

  it('skips tracks with no keyframes', () => {
    const code = exportDoc(
      [armPart()],
      [makeClip({ tracks: [makeTrack('p_arm', 'rotate', [])] })],
    );
    expect(code).not.toContain('pose["arm.rotate"]');
  });
});

describe('exportCompose per-part draw', () => {
  it('uses pose.at with no default when rest is 0, and the rest value as default otherwise', () => {
    const code = exportDoc([
      armPart({ rest: { rotate: 30, tx: 0, ty: -4.5, sx: 1, sy: 1 } }),
    ]);
    expect(code).toContain('rotate(pose.at("arm.rotate", 30f), pivot = Pivot_arm)');
    expect(code).toContain('translate(pose.at("arm.tx"), pose.at("arm.ty", -4.5f))');
  });

  it('emits a rest-scale line around the local-space pivot when rest scale is not 1', () => {
    const code = exportDoc([
      armPart({ rest: { rotate: 0, tx: 0, ty: 0, sx: 1.5, sy: 2 } }),
    ]);
    // No baked transform → local pivot equals the document pivot.
    expect(code).toContain('scale(1.5f, 2f, pivot = Offset(10f, 20f))');
  });

  it('emits the rest scale after the baked transform lines, pivot mapped to pre-baked space', () => {
    const code = exportDoc([
      armPart({
        transform: 'translate(10,0)',
        rest: { rotate: 0, tx: 0, ty: 0, sx: 1.5, sy: 2 },
      }),
    ]);
    const baked = code.indexOf('translate(10f, 0f)');
    // invert(translate(10,0)) applied to pivot (10,20) → (0,20).
    const scale = code.indexOf('scale(1.5f, 2f, pivot = Offset(0f, 20f))');
    expect(baked).toBeGreaterThan(-1);
    expect(scale).toBeGreaterThan(baked);
  });

  it('emits no rest-scale line when rest scale is identity', () => {
    const code = exportDoc([armPart()]);
    expect(code).not.toContain('scale(1f, 1f');
  });

  it('replays the parent chain before the part itself (outermost first)', () => {
    const body = makePart('p_body', { label: 'body', pivot: { x: 50, y: 60 } });
    const arm = armPart({ parentId: 'p_body' });
    const code = exportDoc([body, arm]);

    const armFn = code.slice(code.indexOf('private fun DrawScope.drawPart_arm'));
    const bodyTranslate = armFn.indexOf('translate(pose.at("body.tx"), pose.at("body.ty"))');
    const bodyRotate = armFn.indexOf('rotate(pose.at("body.rotate"), pivot = Pivot_body)');
    const armTranslate = armFn.indexOf('translate(pose.at("arm.tx"), pose.at("arm.ty"))');
    const armRotate = armFn.indexOf('rotate(pose.at("arm.rotate"), pivot = Pivot_arm)');
    expect(bodyTranslate).toBeGreaterThan(-1);
    expect(bodyRotate).toBeGreaterThan(bodyTranslate);
    expect(armTranslate).toBeGreaterThan(bodyRotate);
    expect(armRotate).toBeGreaterThan(armTranslate);

    // The parent's own draw function does not pick up the child's channels.
    const bodyFn = code.slice(
      code.indexOf('private fun DrawScope.drawPart_body'),
      code.indexOf('private fun DrawScope.drawPart_arm'),
    );
    expect(bodyFn).not.toContain('pose.at("arm.');
  });
});
