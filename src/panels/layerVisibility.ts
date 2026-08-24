import {
  activeClip, channelValue, effectiveVisibilityAt, keyAt, RigPart, setKeyframe, state, notify,
} from '../core/model';
import { checkpoint } from '../core/history';
import { renderPose } from '../view';
import { icon } from './icons';

export interface LayerVisibilityState {
  ownVisible: boolean;
  effectivelyVisible: boolean;
  animated: boolean;
  keyed: boolean;
}

export function layerVisibilityState(part: RigPart): LayerVisibilityState {
  const doc = state.doc!;
  const clip = state.editorMode === 'animate' ? activeClip() : null;
  const ownVisible = channelValue(part, 'visibility', clip ? state.currentTime : null) >= 0.5;
  return {
    ownVisible,
    effectivelyVisible: effectiveVisibilityAt(doc, clip, part, clip ? state.currentTime : null) >= 0.5,
    animated: !!clip?.tracks.some((track) =>
      track.target === part.id && track.channel === 'visibility' && track.keyframes.length > 0),
    keyed: !!(clip && keyAt(part.id, 'visibility', state.currentTime)),
  };
}

export function buildPartVisibilityEye(part: RigPart, visibility: LayerVisibilityState): HTMLButtonElement {
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'layer-eye';
  eye.appendChild(icon(visibility.ownVisible ? 'eyeOpen' : 'eyeClosed'));
  eye.classList.toggle('visibility-animated', visibility.animated);
  eye.classList.toggle('visibility-keyed', visibility.keyed);
  eye.title = state.editorMode === 'animate'
    ? `${visibility.ownVisible ? 'Hide' : 'Show'} at ${Math.round(state.currentTime)} ms` +
      (visibility.keyed ? ' (visibility key at playhead)' : visibility.animated ? ' (visibility animated in this clip)' : '') +
      (!visibility.effectivelyVisible && visibility.ownVisible ? ' — hidden by parent' : '')
    : (part.hidden ? 'Show this part in the rest pose' : 'Hide this part in the rest pose');
  eye.onclick = (event) => {
    event.stopPropagation();
    checkpoint();
    if (state.editorMode === 'animate' && activeClip()) {
      const selected = new Set(state.selectedPartIds);
      const multi = selected.has(part.id) && selected.size > 1;
      const candidates = multi
        ? state.doc!.parts.filter((candidate) => selected.has(candidate.id))
        : [part];
      const targets = candidates.filter((candidate) => {
        if (!multi) return true;
        let parentId = candidate.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          if (selected.has(parentId)) return false;
          seen.add(parentId);
          parentId = state.doc!.parts.find((item) => item.id === parentId)?.parentId ?? null;
        }
        return true;
      });
      for (const target of targets) setKeyframe(target.id, 'visibility', visibility.ownVisible ? 0 : 1);
    } else {
      part.hidden = part.hidden ? undefined : true;
    }
    renderPose();
    notify();
  };
  return eye;
}
