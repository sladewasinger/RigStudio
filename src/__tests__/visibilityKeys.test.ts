import { describe, expect, it } from 'vitest';
import {
  channelValue, effectiveVisibilityAt, normalizeDoc, RigDoc, RigPart, sampleKeyList,
  serializeDoc, deserializeDoc,
} from '../core/model';
import { composePose } from '../headless/composePose';
import { exportLottie } from '../io/exportLottie';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP, TYPE } from './rivDecoder';

function part(id: string, parentId: string | null = null): RigPart {
  return {
    id, label: id, kind: 'art', transform: '', pivot: { x: 10, y: 10 }, pivotHint: null,
    parentId, rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 0.5 },
    paths: [{
      id: `${id}_path`, label: `${id}_path`, d: 'M0 0 L20 0 L20 20 Z', transform: '',
      fill: '#3366cc', fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1,
    }],
  };
}

function visibilityDoc(): RigDoc {
  const parent = part('parent');
  const child = part('child', parent.id);
  const doc: RigDoc = {
    name: 'visibility', viewBox: { x: 0, y: 0, w: 40, h: 40 }, parts: [parent, child],
    rootPivot: { x: 20, y: 20 }, fps: 10,
    clips: [{
      name: 'toggle', duration: 1000, tracks: [
        { target: parent.id, channel: 'visibility', keyframes: [
          { time: 300, value: 0, easing: 'easeInOut' },
          { time: 700, value: 1, easing: 'easeInOut' },
        ] },
        { target: child.id, channel: 'opacity', keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 1000, value: 0, easing: 'linear' },
        ] },
      ],
    }],
  };
  return normalizeDoc(doc);
}

describe('animation-local visibility', () => {
  it('holds stepped values, uses rest before the first key, cascades, and round-trips', () => {
    const doc = visibilityDoc();
    const clip = doc.clips[0];
    const parent = doc.parts[0], child = doc.parts[1];
    expect(sampleKeyList(clip.tracks[0].keyframes, 200, 1, true)).toBe(1);
    expect(effectiveVisibilityAt(doc, clip, child, 200)).toBe(1);
    expect(effectiveVisibilityAt(doc, clip, child, 500)).toBe(0);
    expect(effectiveVisibilityAt(doc, clip, child, 900)).toBe(1);
    parent.hidden = true;
    expect(effectiveVisibilityAt(doc, clip, child, 200)).toBe(0);
    expect(channelValue(parent, 'visibility', null)).toBe(0);
    const round = deserializeDoc(serializeDoc(doc));
    expect(round.clips[0].tracks.find((track) => track.channel === 'visibility')?.keyframes)
      .toEqual(clip.tracks[0].keyframes);
  });

  it('headless frames suppress the descendant only during the parent hold', () => {
    const doc = visibilityDoc(), clip = doc.clips[0];
    expect(composePose(doc, clip, 200)).toContain('data-part-id="child"');
    expect(composePose(doc, clip, 500)).not.toContain('data-part-id="child"');
    expect(composePose(doc, clip, 900)).toContain('data-part-id="child"');
  });

  it('Lottie bakes visibility multiplied by continuous opacity into paint-group opacity', () => {
    const doc = visibilityDoc();
    const json = JSON.parse(exportLottie(doc, 0));
    const childLayer = json.layers.find((layer: any) => layer.nm === 'child');
    const opacity = childLayer.shapes[0].it.find((item: any) => item.ty === 'tr').o;
    expect(opacity.a).toBe(1);
    const at = (frame: number) => opacity.k.find((key: any) => key.t === frame).s[0];
    expect(at(2)).toBeCloseTo(80, 3);
    expect(at(5)).toBe(0);
    expect(at(9)).toBeCloseTo(10, 3);
    expect(opacity.k.find((key: any) => key.t === 2).h, 'segment entering hide is held').toBe(1);
    expect(opacity.k.find((key: any) => key.t === 8).h, 'opacity-only segment still interpolates').toBeUndefined();
  });

  it('Rive emits frame-baked color alpha with the same visibility × opacity values', () => {
    const doc = visibilityDoc();
    const decoded = decodeRiv(exportRiv(doc));
    const animation = decoded.animations.find((candidate) => candidate.name === 'toggle')!;
    const childColor = decoded.objects.find((object) =>
      object.typeKey === TYPE.SOLID_COLOR && ((object.props[PROP.COLOR] as number) & 0xffffff) === 0x3366cc)!;
    const keyed = animation.objects.find((object) => object.objectId === childColor.index)!;
    const colors = keyed.props.find((property) => property.propertyKey === PROP.COLOR)!.keyframes;
    const alphaAt = (frame: number) => colors.find((key) => key.frame === frame)!.value >>> 24;
    expect(alphaAt(2)).toBe(Math.round(0.8 * 255));
    expect(alphaAt(5)).toBe(0);
    expect(alphaAt(9)).toBe(25);
    expect(colors.find((key) => key.frame === 2)!.interpType, 'segment entering hide is held').toBe(0);
    expect(colors.find((key) => key.frame === 8)!.interpType, 'opacity-only segment stays linear').toBe(1);
  });
});
