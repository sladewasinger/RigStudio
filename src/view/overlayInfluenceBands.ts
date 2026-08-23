import { state } from '../core/model';
import { influenceBandFrame } from '../geometry/skin';
import { ctx, SVG_NS } from './context';
import { handleSize } from './coords';
import { activeInfluenceTarget } from './influenceBands';

export function renderInfluenceBands(): boolean {
  const active = activeInfluenceTarget();
  if (!active || !ctx.overlay || state.editorMode !== 'setup') return false;
  const size = handleSize();
  const rootTransform = ctx.rootGroup?.getAttribute('transform') ?? '';
  const holder = document.createElementNS(SVG_NS, 'g');
  holder.setAttribute('class', 'influence-bands');
  if (rootTransform) holder.setAttribute('transform', rootTransform);
  active.profile.bands.forEach((band, index) => {
    const frame = influenceBandFrame(band, active.bones);
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
    group.innerHTML =
      `<line class="influence-band-axis" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" />` +
      `<line class="influence-band-edge" x1="${start.x - normal.x * extent}" y1="${start.y - normal.y * extent}" x2="${start.x + normal.x * extent}" y2="${start.y + normal.y * extent}" />` +
      `<line class="influence-band-edge" x1="${end.x - normal.x * extent}" y1="${end.y - normal.y * extent}" x2="${end.x + normal.x * extent}" y2="${end.y + normal.y * extent}" />` +
      `<circle class="influence-band-center" data-role="influence-band" data-band-index="${index}" data-band-handle="center" cx="${frame.center.x}" cy="${frame.center.y}" r="${size * 1.25}" />` +
      `<circle class="influence-band-width" data-role="influence-band" data-band-index="${index}" data-band-handle="widthStart" cx="${start.x}" cy="${start.y}" r="${size}" />` +
      `<circle class="influence-band-width" data-role="influence-band" data-band-index="${index}" data-band-handle="widthEnd" cx="${end.x}" cy="${end.y}" r="${size}" />` +
      `<text class="influence-band-label" x="${frame.center.x + normal.x * extent}" y="${frame.center.y + normal.y * extent}">Joint ${index + 1}</text>`;
    holder.appendChild(group);
  });
  ctx.overlay.appendChild(holder);
  return true;
}
