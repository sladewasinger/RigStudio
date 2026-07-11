/**
 * Pure alignment/distribution math. Given root-space bounding boxes for a set of
 * parts, computes per-id translation deltas that snap them to a shared edge
 * (align) or spread them with equal gaps (distribute). No DOM, no doc mutation:
 * callers map the returned root-space deltas through parent transforms before
 * writing them into rest poses or keyframes.
 */

export interface Box { x: number; y: number; w: number; h: number }

export type AlignEdge = 'left' | 'centerH' | 'right' | 'top' | 'middleV' | 'bottom';
export type AlignReference = 'selection' | 'first' | 'last' | 'canvas';
export type DistributeMode = 'horizontal' | 'vertical';

interface Entry { id: string; box: Box }

/** Resolve ids against the box map, preserving order and skipping missing ids. */
function presentEntries(ids: string[], boxes: Map<string, Box>): Entry[] {
  const out: Entry[] = [];
  for (const id of ids) {
    const box = boxes.get(id);
    if (box) out.push({ id, box });
  }
  return out;
}

/** Union bounding box of one or more entries. */
function unionBox(entries: Entry[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { box } of entries) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function referenceBox(
  entries: Entry[],
  reference: AlignReference,
  canvas: Box,
): Box {
  switch (reference) {
    case 'selection':
      return unionBox(entries);
    case 'first':
      return entries[0].box;
    case 'last':
      return entries[entries.length - 1].box;
    case 'canvas':
      return canvas;
  }
}

/**
 * Root-space translation deltas that align each id's box to the reference.
 * - reference 'selection': the union bbox of all ids' boxes
 * - 'first' / 'last': the first/last id in `ids` (that id gets a zero delta)
 * - 'canvas': the canvas box argument
 * Ids missing from `boxes` are skipped. Returns a map id → {dx, dy} where the
 * unused axis is always 0 (left/centerH/right move only x; top/middleV/bottom only y).
 */
export function alignDeltas(
  ids: string[],
  boxes: Map<string, Box>,
  edge: AlignEdge,
  reference: AlignReference,
  canvas: Box,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  const entries = presentEntries(ids, boxes);
  if (entries.length === 0) return out;
  const ref = referenceBox(entries, reference, canvas);
  for (const { id, box } of entries) {
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case 'left':
        dx = ref.x - box.x;
        break;
      case 'centerH':
        dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
        break;
      case 'right':
        dx = ref.x + ref.w - (box.x + box.w);
        break;
      case 'top':
        dy = ref.y - box.y;
        break;
      case 'middleV':
        dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
        break;
      case 'bottom':
        dy = ref.y + ref.h - (box.y + box.h);
        break;
    }
    out.set(id, { dx, dy });
  }
  return out;
}

/**
 * Distribute with equal GAPS between adjacent boxes along the axis, keeping the
 * first and last (by position) boxes fixed. Boxes are ordered by their current
 * min-edge coordinate on that axis. With fewer than 3 boxes, or when the total
 * gap space is negative (overlapping boxes wider than the span), returns zero
 * deltas for everyone rather than inventing overlaps. Returns id → {dx, dy}.
 */
export function distributeDeltas(
  ids: string[],
  boxes: Map<string, Box>,
  mode: DistributeMode,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  const entries = presentEntries(ids, boxes);
  for (const { id } of entries) out.set(id, { dx: 0, dy: 0 });
  if (entries.length < 3) return out;

  const horizontal = mode === 'horizontal';
  const posOf = (box: Box): number => (horizontal ? box.x : box.y);
  const sizeOf = (box: Box): number => (horizontal ? box.w : box.h);

  const sorted = [...entries].sort((a, b) => posOf(a.box) - posOf(b.box));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Inkscape "make gaps equal": first and last stay put; the equal gap is the
  // leftover span not covered by the widths of everything before the last box.
  let occupied = 0;
  for (let i = 0; i < sorted.length - 1; i++) occupied += sizeOf(sorted[i].box);
  const gap = (posOf(last.box) - posOf(first.box) - occupied) / (sorted.length - 1);
  if (gap < 0) return out;

  let cursor = posOf(first.box);
  for (let i = 1; i < sorted.length - 1; i++) {
    cursor += sizeOf(sorted[i - 1].box) + gap;
    const d = cursor - posOf(sorted[i].box);
    out.set(sorted[i].id, horizontal ? { dx: d, dy: 0 } : { dx: 0, dy: d });
  }
  return out;
}
