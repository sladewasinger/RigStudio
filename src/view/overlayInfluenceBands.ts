import { state } from '../core/model';
import { influenceBandFrame } from '../geometry/skin';
import { ctx, SVG_NS } from './context';
import { handleSize } from './coords';
import { activeInfluenceTarget } from './influenceBands';

export interface AnnotationLayout {
  showNumber: boolean;
  callout?: { x: number; y: number };
}

/** Screen-space annotation layout: active first, dense neighbors lose only their text. */
export function layoutInfluenceAnnotations(
  centers: { x: number; y: number }[], activeIndex: number,
  viewport: { left: number; top: number; right: number; bottom: number },
  activeAxis: { x: number; y: number } = { x: 1, y: 0 },
): AnnotationLayout[] {
  const result = centers.map(() => ({ showNumber: false } as AnnotationLayout));
  const accepted: { x: number; y: number }[] = [];
  const order = [activeIndex, ...centers.map((_, index) => index).filter((index) => index !== activeIndex)];
  for (const index of order) {
    const center = centers[index];
    if (!center) continue;
    const collides = accepted.some((prior) => Math.hypot(prior.x - center.x, prior.y - center.y) < 18);
    result[index].showNumber = index === activeIndex || !collides;
    if (result[index].showNumber) accepted.push(center);
  }
  const active = centers[activeIndex];
  if (active) {
    const halfW = 31, halfH = 10, gap = 18;
    const axisLen = Math.hypot(activeAxis.x, activeAxis.y) || 1;
    const axis = { x: activeAxis.x / axisLen, y: activeAxis.y / axisLen };
    const normal = { x: -axis.y, y: axis.x };
    const candidate = (direction: { x: number; y: number }) => {
      const distance = halfW * Math.abs(direction.x) + halfH * Math.abs(direction.y) + gap;
      return { x: active.x + direction.x * distance, y: active.y + direction.y * distance };
    };
    // Perpendicular first keeps the callout clear of the center/width handles, which
    // lie on the bone axis. Opposite side and along-axis positions are fallbacks.
    const candidates = [
      candidate(normal), candidate({ x: -normal.x, y: -normal.y }),
      candidate(axis), candidate({ x: -axis.x, y: -axis.y }),
    ];
    const fits = (point: { x: number; y: number }) =>
      point.x - halfW >= viewport.left && point.x + halfW <= viewport.right &&
      point.y - halfH >= viewport.top && point.y + halfH <= viewport.bottom;
    const chosen = candidates.find(fits) ?? candidates[0];
    result[activeIndex].callout = {
      x: Math.max(viewport.left + halfW, Math.min(viewport.right - halfW, chosen.x)),
      y: Math.max(viewport.top + halfH, Math.min(viewport.bottom - halfH, chosen.y)),
    };
  }
  return result;
}

export function renderInfluenceBands(): boolean {
  const active = activeInfluenceTarget();
  const svg = ctx.svg;
  if (!active || !ctx.overlay || !svg || state.editorMode !== 'setup') return false;
  const size = handleSize();
  const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'influence-bands');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  const ctm = ctx.rootGroup?.getScreenCTM() ?? null;
  const viewportRect = svg.getBoundingClientRect();
  const frames = active.profile.bands.map((band) => influenceBandFrame(band, active.bones));
  const centersClient = frames.map((frame) => {
    if (!frame || !ctm) return { x: -1e6, y: -1e6 };
    const point = svg.createSVGPoint();
    point.x = frame.center.x; point.y = frame.center.y;
    const client = point.matrixTransform(ctm);
    return { x: client.x, y: client.y };
  });
  const selectedIndex = Math.max(0, Math.min(
    active.profile.bands.length - 1, ctx.influenceSession?.selectedBand ?? 0,
  ));
  let activeAxisClient = { x: 1, y: 0 };
  const activeFrame = frames[selectedIndex];
  if (ctm && activeFrame) {
    const origin = svg.createSVGPoint();
    origin.x = activeFrame.center.x; origin.y = activeFrame.center.y;
    const endpoint = svg.createSVGPoint();
    endpoint.x = activeFrame.center.x + activeFrame.axis.x;
    endpoint.y = activeFrame.center.y + activeFrame.axis.y;
    const a = origin.matrixTransform(ctm), b = endpoint.matrixTransform(ctm);
    activeAxisClient = { x: b.x - a.x, y: b.y - a.y };
  }
  const annotationLayout = layoutInfluenceAnnotations(centersClient, selectedIndex, {
    left: viewportRect.left + 4, top: viewportRect.top + 4,
    right: viewportRect.right - 4, bottom: viewportRect.bottom - 4,
  }, activeAxisClient);
  active.profile.bands.forEach((band, index) => {
    const frame = frames[index];
    if (!frame) return;
    const normal = { x: -frame.axis.y, y: frame.axis.x };
    const extent = size * 5;
    const start = {
      x: frame.center.x - frame.axis.x * frame.halfWidth,
      y: frame.center.y - frame.axis.y * frame.halfWidth,
    };
    const end = {
      x: frame.center.x + frame.axis.x * frame.halfWidth,
      y: frame.center.y + frame.axis.y * frame.halfWidth,
    };
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('influence-band');
    if (ctx.influenceSession?.selectedBand === index) group.classList.add('selected');
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', `Joint ${index + 1} influence band from ${band.parentBoneId} to ${band.childBoneId}`);
    group.innerHTML =
      `<line class="influence-band-axis" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" />` +
      `<line class="influence-band-edge" x1="${start.x - normal.x * extent}" y1="${start.y - normal.y * extent}" x2="${start.x + normal.x * extent}" y2="${start.y + normal.y * extent}" />` +
      `<line class="influence-band-edge" x1="${end.x - normal.x * extent}" y1="${end.y - normal.y * extent}" x2="${end.x + normal.x * extent}" y2="${end.y + normal.y * extent}" />` +
      `<circle class="influence-band-center" data-role="influence-band" data-band-index="${index}" data-band-handle="center" aria-label="Move Joint ${index + 1} crossover" cx="${frame.center.x}" cy="${frame.center.y}" r="${size * 1.25}"><title>Move Joint ${index + 1} crossover</title></circle>` +
      `<circle class="influence-band-width" data-role="influence-band" data-band-index="${index}" data-band-handle="widthStart" aria-label="Adjust Joint ${index + 1} softness" cx="${start.x}" cy="${start.y}" r="${size}"><title>Adjust Joint ${index + 1} softness</title></circle>` +
      `<circle class="influence-band-width" data-role="influence-band" data-band-index="${index}" data-band-handle="widthEnd" aria-label="Adjust Joint ${index + 1} softness" cx="${end.x}" cy="${end.y}" r="${size}"><title>Adjust Joint ${index + 1} softness</title></circle>`;
    if (annotationLayout[index]?.showNumber) {
      const badge = document.createElementNS(SVG_NS, 'text');
      badge.setAttribute('class', 'influence-band-badge');
      badge.setAttribute('x', String(frame.center.x));
      badge.setAttribute('y', String(frame.center.y));
      badge.setAttribute('font-size', String(size * 1.35));
      badge.textContent = String(index + 1);
      group.appendChild(badge);
    }
    const callout = annotationLayout[index]?.callout;
    if (callout && ctm) {
      const rootPoint = svg.createSVGPoint();
      rootPoint.x = callout.x; rootPoint.y = callout.y;
      const local = rootPoint.matrixTransform(ctm.inverse());
      const calloutGroup = document.createElementNS(SVG_NS, 'g');
      calloutGroup.setAttribute('class', 'influence-band-callout');
      const w = size * 8.4, h = size * 2.8;
      calloutGroup.innerHTML =
        `<rect x="${local.x - w / 2}" y="${local.y - h / 2}" width="${w}" height="${h}" rx="${size * 0.8}" />` +
        `<text x="${local.x}" y="${local.y}" font-size="${size * 1.45}">Joint ${index + 1}</text>`;
      group.appendChild(calloutGroup);
    }
    holder.appendChild(group);
  });
  ctx.overlay.appendChild(holder);
  return true;
}
