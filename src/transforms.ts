/**
 * SVG transform-list parsing. Used both to seed pivots on import (a group authored as
 * rotate(a, cx, cy) has its joint at (cx, cy)) and to emit equivalent Jetpack Compose
 * transform calls on export.
 */

export type SvgTransform =
  | { type: 'translate'; tx: number; ty: number }
  | { type: 'scale'; sx: number; sy: number }
  | { type: 'rotate'; angle: number; cx: number; cy: number }
  | { type: 'matrix'; a: number; b: number; c: number; d: number; e: number; f: number };

const FN_RE = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;

export function parseTransformList(value: string | null | undefined): SvgTransform[] {
  const out: SvgTransform[] = [];
  if (!value) return out;
  for (const match of value.matchAll(FN_RE)) {
    const fn = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    switch (fn) {
      case 'translate':
        out.push({ type: 'translate', tx: args[0] ?? 0, ty: args[1] ?? 0 });
        break;
      case 'scale':
        out.push({ type: 'scale', sx: args[0] ?? 1, sy: args[1] ?? args[0] ?? 1 });
        break;
      case 'rotate':
        out.push({ type: 'rotate', angle: args[0] ?? 0, cx: args[1] ?? 0, cy: args[2] ?? 0 });
        break;
      case 'matrix':
        out.push({
          type: 'matrix',
          a: args[0] ?? 1, b: args[1] ?? 0, c: args[2] ?? 0,
          d: args[3] ?? 1, e: args[4] ?? 0, f: args[5] ?? 0,
        });
        break;
      default:
        // skewX/skewY are rare in rig art; approximate as identity but keep going.
        console.warn(`rig-studio: ignoring unsupported transform "${fn}"`);
    }
  }
  return out;
}

/** The fixed point of a transform list, if it is a single pivoted rotation. */
export function rotationPivotOf(value: string | null | undefined): { x: number; y: number } | null {
  const list = parseTransformList(value);
  if (list.length === 1 && list[0].type === 'rotate') {
    return { x: list[0].cx, y: list[0].cy };
  }
  return null;
}
