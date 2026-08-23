import { notify, state } from '../../../core/model';
import { influenceBandFrame } from '../../../geometry/skin';
import { ctx, DragState } from '../../context';
import { pointerInRoot } from '../../coords';
import { activeInfluenceTarget, updateInfluenceBand } from '../../influenceBands';
import { renderPose } from '../../render';
import { HitContext } from '../hit';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const INFLUENCE_BAND_PIPELINE: GesturePipeline = {
  name: 'influenceBand',
  claim(hit: HitContext, ev: PointerEvent) {
    if (!hit.influenceBand || ev.button !== 0 || state.editorMode !== 'setup') return null;
    const active = activeInfluenceTarget();
    if (!active || !Number.isInteger(hit.influenceBand.index)) return null;
    ctx.influenceSession!.selectedBand = hit.influenceBand.index;
    const drag: Extract<DragState, { kind: 'influenceBand' }> = {
      kind: 'influenceBand', targetId: active.target.id,
      bandIndex: hit.influenceBand.index, handle: hit.influenceBand.handle,
      startClient: { x: ev.clientX, y: ev.clientY }, active: false,
    };
    capturePointer(ev);
    notify();
    renderPose();
    return drag;
  },
  move(ev: PointerEvent, drag: DragState) {
    if (drag.kind !== 'influenceBand') return;
    const active = activeInfluenceTarget();
    const band = active?.profile.bands[drag.bandIndex];
    const frame = band && active ? influenceBandFrame(band, active.bones) : null;
    if (!band || !frame) return;
    const point = pointerInRoot(ev);
    const projection =
      (point.x - frame.joint.x) * frame.axis.x + (point.y - frame.joint.y) * frame.axis.y;
    if (drag.handle === 'center') updateInfluenceBand(drag.bandIndex, { center: projection });
    else updateInfluenceBand(drag.bandIndex, { width: Math.max(1, Math.abs(projection - band.center) * 2) });
  },
};
