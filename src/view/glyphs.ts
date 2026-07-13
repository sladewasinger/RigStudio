/**
 * Pure SVG-fragment builders for canvas glyph chrome — string math only, no DOM/ctx
 * access, so overlay.ts (and anything else at its layer) can call these without growing
 * its own line budget for geometry that has nothing to do with rendering orchestration.
 */

/**
 * The classic bone silhouette between two points (joint fat end, pointed tip). The
 * origin→tip SPAN legitimately scales with zoom (it's the true joint positions), but
 * per the screen-constant-chrome GOTCHA the kite's CROSS-SECTION must not: `w` (and the
 * along-axis offset of its widest point) derive only from `size` (handleSize(), already
 * screen-constant), never from `len` (a fixed doc-space quantity whose on-screen size
 * grows with zoom) — that mixed-unit `Math.min(len*k, size*k)` used to win on whichever
 * term was smaller, so the girth crept wider through most of a zoom-in before a
 * high-zoom crossover finally capped it (the reported "bone glyphs not zoom-stable"
 * bug). `len` still bounds where the widest point sits ALONG the segment, purely so a
 * very short bone's kite doesn't overshoot its own tip — that's a shape/proportion
 * clamp, not a girth one, and doesn't reintroduce the bug.
 */
export function boneKitePath(p: { x: number; y: number }, q: { x: number; y: number }, size: number): string {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const ux = dx / len, uy = dy / len;
  const w = size * 1.6;
  const off = Math.min(len * 0.5, size * 2);
  const bx = p.x + ux * off;
  const by = p.y + uy * off;
  return (
    `<path d="M ${p.x},${p.y} L ${bx - uy * w},${by + ux * w} L ${q.x},${q.y} ` +
    `L ${bx + uy * w},${by - ux * w} Z" />` +
    `<circle cx="${p.x}" cy="${p.y}" r="${w * 0.5}" />`
  );
}

/** The pivot/origin marker's three concentric shapes (grab ring, visible ring, center
 *  dot) shared by overlay.ts's primary selected-pivot crosshair and the freeze-mode
 *  per-bone origin markers (Post-A Fix 1) — only the crosshair LINES differ between them. */
export function jointDotHtml(x: number, y: number, size: number): string {
  return (
    `<circle class="pivot-grab" cx="${x}" cy="${y}" r="${size * 1.6}" />` +
    `<circle class="pivot-ring" cx="${x}" cy="${y}" r="${size * 1.1}" />` +
    `<circle class="pivot-dot" cx="${x}" cy="${y}" r="${size * 0.3}" />`
  );
}
