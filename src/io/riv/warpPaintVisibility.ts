import { Clip, effectiveVisibilityAt, RigDoc, RigPart } from '../../core/model';
import { argb, INTERP_HOLD, INTERP_LINEAR } from './keys';

interface WarpPaint {
  sourceHex: string;
  targetHex: string;
  sourceOpacity: number;
  targetOpacity: number;
}

const mixHex = (left: string, right: string, amount: number): string => {
  const channel = (offset: number) => Math.round(parseInt(left.slice(offset, offset + 2), 16) +
    (parseInt(right.slice(offset, offset + 2), 16) - parseInt(left.slice(offset, offset + 2), 16)) * amount);
  return `#${[1, 3, 5].map((offset) => channel(offset).toString(16).padStart(2, '0')).join('')}`;
};

export function planWarpPaintVisibility(
  doc: RigDoc, clip: Clip, carrier: RigPart, paint: WarpPaint,
  baked: { time: number; value: number }[], fps: number,
): { frame: number; value: number; interpType: number; interpId: number }[] {
  return baked.map((key, index) => {
    const amount = Math.min(1, Math.max(0, key.value));
    const visibility = effectiveVisibilityAt(doc, clip, carrier, key.time);
    const nextVisibility = baked[index + 1]
      ? effectiveVisibilityAt(doc, clip, carrier, baked[index + 1].time) : visibility;
    const opacity = paint.sourceOpacity + (paint.targetOpacity - paint.sourceOpacity) * amount;
    return {
      frame: Math.max(0, Math.round((key.time / 1000) * fps)),
      value: argb(mixHex(paint.sourceHex, paint.targetHex, amount), opacity * visibility),
      interpType: nextVisibility !== visibility ? INTERP_HOLD : INTERP_LINEAR, interpId: -1,
    };
  });
}
