/**
 * Per-part transform fields (Setup rest pose + pivot + parent, or Animate keyed
 * rotate/translate/scale/z/opacity channels) and the Setup-only "Figure (root)"
 * pivot section. Bone parts use `boneSection.ts` instead — see the
 * `buildInspector` orchestration in `panel.ts`.
 */
import {
  state, RigDoc, RigPart, channelValue, setKeyframe, promotePathToPart, selectPart, notify,
} from '../../core/model';
import { renderPose, registerPart, reorderCanvas, syncPartPathDom } from '../../view';
import { checkpoint } from '../../core/history';
import { numberField, keyableField, poseEdited, buildParentSelector } from './shared';

// A skinned part's rotate/tx/ty carry its whole bone chain. Scale is applied after LBS
// around the part pivot, so it remains a useful whole-limb channel; skew stays locked
// because the skin renderer has no equivalent compositing rule for it.
const SKIN_SKEW_LOCK_TITLE =
  'Skew is not supported on bone-deformed artwork. Scale composes with the rig; use ' +
  'bones or node editing for shape changes.';

/** Disables a field built by `numberField`/`keyableField` (and its key-toggle, if any)
 *  with an explanatory title — used for a skinned part's scale/skew fields only. */
function lockField(field: HTMLElement, title: string): HTMLElement {
  const input = field.querySelector('input');
  if (input) { input.disabled = true; input.title = title; }
  const toggle = field.querySelector<HTMLButtonElement>('.key-toggle');
  if (toggle) { toggle.disabled = true; toggle.title = title; }
  return field;
}

function setupTransformTarget(part: RigPart): RigPart {
  if (!state.selectedPathId) return part;
  const promoted = promotePathToPart(part, state.selectedPathId);
  if (!promoted || promoted === part) return part;
  syncPartPathDom(part);
  registerPart(promoted);
  reorderCanvas();
  selectPart(promoted.id);
  notify();
  return promoted;
}

export function buildPartTransformFields(el: HTMLElement, part: RigPart, setup: boolean): void {
  if (setup) {
    el.appendChild(numberField('rest rotate (deg)', part.rest.rotate, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.rotate = v;
      poseEdited();
    }));
    el.appendChild(numberField('rest x', part.rest.tx, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.tx = v;
      poseEdited();
    }));
    el.appendChild(numberField('rest y', part.rest.ty, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.ty = v;
      poseEdited();
    }));
    const restSx = numberField('rest scale x', part.rest.sx, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.sx = v || 1;
      poseEdited();
    }, 0.01);
    const restSy = numberField('rest scale y', part.rest.sy, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.sy = v || 1;
      poseEdited();
    }, 0.01);
    const restKx = numberField('skew x (deg)', part.rest.kx, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.kx = Math.min(85, Math.max(-85, v));
      poseEdited();
    }, 0.5);
    const restKy = numberField('skew y (deg)', part.rest.ky, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.ky = Math.min(85, Math.max(-85, v));
      poseEdited();
    }, 0.5);
    if (part.skin) {
      lockField(restKx, SKIN_SKEW_LOCK_TITLE);
      lockField(restKy, SKIN_SKEW_LOCK_TITLE);
    }
    el.appendChild(restSx);
    el.appendChild(restSy);
    el.appendChild(restKx);
    el.appendChild(restKy);
    el.appendChild(numberField('rest opacity', part.rest.opacity, (v) => {
      checkpoint();
      setupTransformTarget(part).rest.opacity = Math.min(1, Math.max(0, v));
      poseEdited();
    }, 0.05));
    el.appendChild(numberField('pivot x', part.pivot.x, (v) => {
      checkpoint();
      setupTransformTarget(part).pivot.x = v;
      renderPose();
    }));
    el.appendChild(numberField('pivot y', part.pivot.y, (v) => {
      checkpoint();
      setupTransformTarget(part).pivot.y = v;
      renderPose();
    }));

    buildParentSelector(el, part);
  } else {
    // Displayed values are absolute (rest fills unkeyed channels); editing keys.
    // Each field gets a keyframe-toggle circle (filled = keyed at the playhead).
    const t = state.currentTime;
    el.appendChild(keyableField(
      'rotate (deg)', part.id, 'rotate', () => channelValue(part, 'rotate', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'rotate', v);
        poseEdited();
      },
    ));
    el.appendChild(keyableField(
      'translate x', part.id, 'tx', () => channelValue(part, 'tx', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'tx', v);
        poseEdited();
      },
    ));
    el.appendChild(keyableField(
      'translate y', part.id, 'ty', () => channelValue(part, 'ty', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'ty', v);
        poseEdited();
      },
    ));
    // Keyable part scale (absolute sx/sy, rest.sx/sy fallback): ordinary artwork scales
    // in its local transform; skinned artwork scales the final LBS result around its
    // explicit pivot. Both paths scrub and export through the same native channels.
    const keySx = keyableField(
      'scale x', part.id, 'sx', () => channelValue(part, 'sx', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'sx', v);
        poseEdited();
      }, 0.01,
    );
    const keySy = keyableField(
      'scale y', part.id, 'sy', () => channelValue(part, 'sy', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'sy', v);
        poseEdited();
      }, 0.01,
    );
    el.appendChild(keySx);
    el.appendChild(keySy);
    // Keyable draw-order OFFSET (stepped, absolute): higher = toward the viewer, 0 = the
    // authored stacking. Sampling holds the latest key (no easing), so it snaps between
    // ranks — the reach-behind-then-in-front use case.
    const zField = keyableField(
      'z offset', part.id, 'z', () => channelValue(part, 'z', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'z', v);
        poseEdited();
      },
    );
    zField.title = 'Draw-order offset (stepped, no easing): 0 = authored stacking, ' +
      'higher = toward the viewer. Snaps at each key.';
    el.appendChild(zField);
    // Keyable, CONTINUOUS (unlike z — this one eases normally): fade-in/fade-out.
    el.appendChild(keyableField(
      'opacity', part.id, 'opacity', () => channelValue(part, 'opacity', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'opacity', Math.min(1, Math.max(0, v)));
        poseEdited();
      }, 0.05,
    ));
  }
}

// Root (whole figure) — Setup-mode PIVOT fields only (AI Animate System v2 A0 "root
// demotion"). The Animate section that used to key root.ty/sx/sy is REMOVED: keying
// root moved the whole figure by dragging along every part with no track of its own —
// including a shadow or prop never meant to move (the "shadow follows the figure"
// bug). Whole-figure motion now targets a GROUP part instead, which only carries its
// own descendants — use the normal per-part fields above on that group. Legacy 'root'
// tracks from older projects are untouched by this: they still SAMPLE (model.ts),
// RENDER (view/pose.ts), and EXPORT (both exporters) exactly as before — this only
// removes the UI that lets NEW clips key them. rootPivot itself still anchors those
// legacy tracks, so its Setup-mode fields stay.
export function buildRootSection(el: HTMLElement, doc: RigDoc, setup: boolean): void {
  if (setup) {
    const rootTitle = document.createElement('h3');
    rootTitle.textContent = 'Figure (root)';
    el.appendChild(rootTitle);
    el.appendChild(numberField('root pivot x', doc.rootPivot.x, (v) => {
      checkpoint();
      doc.rootPivot.x = v;
      renderPose();
    }));
    el.appendChild(numberField('root pivot y', doc.rootPivot.y, (v) => {
      checkpoint();
      doc.rootPivot.y = v;
      renderPose();
    }));
  }
}
