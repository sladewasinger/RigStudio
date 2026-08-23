/**
 * Regression scenarios for exact animated Rive draw order. The decoder resolves each
 * real Shape's keyed DrawTarget to its invisible rank sentinel, reconstructing the
 * runtime paint order without sharing any planner implementation with the exporter.
 */
import { describe, expect, it } from 'vitest';
import { Clip, RigDoc, RigPart, RigPath } from '../core/model';
import { exportRiv } from '../io/riv';
import { decodeRiv, PROP } from './rivDecoder';

const REST = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 };

function path(id: string): RigPath {
  return {
    id, label: id, d: 'M 10,10 L 90,10 L 90,90 L 10,90 Z', fill: '#cc3366',
    fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '',
  };
}

function part(id: string, options: Partial<RigPart> = {}): RigPart {
  return {
    id, label: id, kind: 'art', transform: '', pivot: { x: 0, y: 0 }, pivotHint: null,
    rest: { ...REST }, parentId: null, paths: [path(`${id}_path`)], ...options,
  };
}

function zTrack(target: string, keys: [number, number][]) {
  return {
    target, channel: 'z' as const,
    keyframes: keys.map(([time, value]) => ({ time, value, easing: 'linear' as const })),
  };
}

function doc(parts: RigPart[], tracks: Clip['tracks'], duration = 1000): RigDoc {
  return {
    name: 'animated-order', viewBox: { x: 0, y: 0, w: 100, h: 100 }, parts,
    rootPivot: { x: 50, y: 50 }, clips: [{ name: 'move', duration, tracks }],
  };
}

function exportedOrderAt(source: RigDoc, frame: number): string[] {
  const decoded = decodeRiv(exportRiv(source));
  const objectsByIndex = new Map(decoded.objects.filter((o) => o.index >= 0).map((o) => [o.index, o]));
  const animation = decoded.animations.find((candidate) => candidate.name === 'move')!;
  const ranked: { name: string; rank: number }[] = [];

  for (const keyed of animation.objects) {
    const property = keyed.props.find((candidate) => candidate.propertyKey === PROP.DRAW_TARGET_ID);
    if (!property) continue;
    const rules = objectsByIndex.get(keyed.objectId)!;
    const shape = objectsByIndex.get(Number(rules.props[PROP.PARENT_ID]))!;
    const key = [...property.keyframes].reverse().find((candidate) => candidate.frame <= frame)!;
    const target = objectsByIndex.get(key.value)!;
    const anchor = objectsByIndex.get(Number(target.props[PROP.DRAWABLE_ID]))!;
    const match = /^Rig Studio draw rank (\d+)$/.exec(String(anchor.props[PROP.NAME]));
    expect(match, `target for ${String(shape.props[PROP.NAME])} is a rank anchor`).toBeTruthy();
    ranked.push({ name: String(shape.props[PROP.NAME]), rank: Number(match![1]) });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((item) => item.name);
}

describe('exportRiv exact animated draw order', () => {
  it("updates B when C's later key changes B's rank", () => {
    const source = doc(
      ['A', 'B', 'C', 'D'].map((id) => part(id)),
      [zTrack('B', [[0, 20]]), zTrack('C', [[0, 0], [500, 30]])],
    );
    expect(exportedOrderAt(source, 0)).toEqual(['A_path', 'C_path', 'D_path', 'B_path']);
    expect(exportedOrderAt(source, 30)).toEqual(['A_path', 'D_path', 'B_path', 'C_path']);
  });

  it('orders three adjacent animated objects instead of dropping the middle one', () => {
    const source = doc(
      ['A', 'B', 'C', 'D', 'E'].map((id) => part(id)),
      [
        zTrack('B', [[0, 0], [500, 30]]), zTrack('C', [[0, 0], [500, 20]]),
        zTrack('D', [[0, 0], [500, 10]]),
      ],
    );
    expect(exportedOrderAt(source, 0)).toEqual(['A_path', 'B_path', 'C_path', 'D_path', 'E_path']);
    expect(exportedOrderAt(source, 30)).toEqual(['A_path', 'E_path', 'D_path', 'C_path', 'B_path']);
  });

  it('moves a keyed parent together with its drawable descendant subtree', () => {
    const parent = part('parent');
    const child = part('child', { parentId: 'parent' });
    const other = part('other');
    const source = doc([parent, child, other], [zTrack('parent', [[0, 0], [500, 100]])]);
    expect(exportedOrderAt(source, 0)).toEqual(['parent_path', 'child_path', 'other_path']);
    expect(exportedOrderAt(source, 30)).toEqual(['other_path', 'parent_path', 'child_path']);
  });

  it('keeps interleaved parent runs fixed while swapping child part slots', () => {
    const container = part('container', {
      paths: [path('under'), path('over')],
      childOrder: [
        { kind: 'path', id: 'under' }, { kind: 'part', id: 'left' },
        { kind: 'part', id: 'right' }, { kind: 'path', id: 'over' },
      ],
    });
    const left = part('left', { parentId: 'container' });
    const right = part('right', { parentId: 'container' });
    const source = doc([container, left, right], [zTrack('left', [[0, 0], [500, 100]])]);
    expect(exportedOrderAt(source, 0)).toEqual(['under', 'left_path', 'right_path', 'over']);
    expect(exportedOrderAt(source, 30)).toEqual(['under', 'right_path', 'left_path', 'over']);
  });

  it('emits frame-zero rest order when the first z key occurs later', () => {
    const source = doc(
      ['A', 'B', 'C'].map((id) => part(id)),
      [zTrack('B', [[500, 100]])],
    );
    expect(exportedOrderAt(source, 0)).toEqual(['A_path', 'B_path', 'C_path']);
    expect(exportedOrderAt(source, 30)).toEqual(['A_path', 'C_path', 'B_path']);
  });

  it('throws an actionable error instead of silently approximating a malformed paint graph', () => {
    const dangling = part('dangling', { parentId: 'missing-parent' });
    const source = doc([dangling, part('other')], [zTrack('dangling', [[0, 10]])]);
    expect(() => exportRiv(source)).toThrow(
      /Cannot export exact Rive z-order.*Repair dangling\/cyclic parenting or duplicate path ids/,
    );
  });
});
