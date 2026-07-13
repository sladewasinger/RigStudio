/**
 * Per-part transform fields (Setup rest pose + pivot + parent, or Animate keyed
 * rotate/translate/scale/z/opacity channels) and the Setup-only "Figure (root)"
 * pivot section. Bone parts use `boneSection.ts` instead — see the
 * `buildInspector` orchestration in `panel.ts`.
 */
import { state, RigDoc, RigPart, channelValue, setKeyframe } from '../../core/model';
import { renderPose } from '../../view';
import { checkpoint } from '../../core/history';
import { numberField, keyableField, poseEdited, buildParentSelector } from './shared';

// A skinned part's rotate/tx/ty carry its whole bone chain (the bones are parented under
// it), so those stay live — but its scale/skew never propagate to a part's children in
// the editor (unlike a Rive Node at runtime), so offering them here would be a channel
// the canvas can't actually show (user ruling 2026-07-12, "Allow rotate+translate" —
// CLAUDE.md "Skinned-part UX"; WYSIWYG per the ruling's own wording).
const SKIN_SCALE_LOCK_TITLE =
  "Blocked on a skinned part — scale/skew never propagate to a part's children in the " +
  'editor, unlike a Rive Node at runtime. Pose the limb with rotate/translate, or reshape ' +
  'its bones.';

/** Disables a field built by `numberField`/`keyableField` (and its key-toggle, if any)
 *  with an explanatory title — used for a skinned part's scale/skew fields only. */
function lockField(field: HTMLElement, title: string): HTMLElement {
  const input = field.querySelector('input');
  if (input) { input.disabled = true; input.title = title; }
  const toggle = field.querySelector<HTMLButtonElement>('.key-toggle');
  if (toggle) { toggle.disabled = true; toggle.title = title; }
  return field;
}

export function buildPartTransformFields(el: HTMLElement, part: RigPart, setup: boolean): void {
  if (setup) {
    el.appendChild(numberField('rest rotate (deg)', part.rest.rotate, (v) => {
      checkpoint();
      part.rest.rotate = v;
      poseEdited();
    }));
    el.appendChild(numberField('rest x', part.rest.tx, (v) => {
      checkpoint();
      part.rest.tx = v;
      poseEdited();
    }));
    el.appendChild(numberField('rest y', part.rest.ty, (v) => {
      checkpoint();
      part.rest.ty = v;
      poseEdited();
    }));
    const restSx = numberField('rest scale x', part.rest.sx, (v) => {
      checkpoint();
      part.rest.sx = v || 1;
      poseEdited();
    }, 0.01);
    const restSy = numberField('rest scale y', part.rest.sy, (v) => {
      checkpoint();
      part.rest.sy = v || 1;
      poseEdited();
    }, 0.01);
    const restKx = numberField('skew x (deg)', part.rest.kx, (v) => {
      checkpoint();
      part.rest.kx = Math.min(85, Math.max(-85, v));
      poseEdited();
    }, 0.5);
    const restKy = numberField('skew y (deg)', part.rest.ky, (v) => {
      checkpoint();
      part.rest.ky = Math.min(85, Math.max(-85, v));
      poseEdited();
    }, 0.5);
    if (part.skin) {
      lockField(restSx, SKIN_SCALE_LOCK_TITLE);
      lockField(restSy, SKIN_SCALE_LOCK_TITLE);
      lockField(restKx, SKIN_SCALE_LOCK_TITLE);
      lockField(restKy, SKIN_SCALE_LOCK_TITLE);
    }
    el.appendChild(restSx);
    el.appendChild(restSy);
    el.appendChild(restKx);
    el.appendChild(restKy);
    el.appendChild(numberField('rest opacity', part.rest.opacity, (v) => {
      checkpoint();
      part.rest.opacity = Math.min(1, Math.max(0, v));
      poseEdited();
    }, 0.05));
    el.appendChild(numberField('pivot x', part.pivot.x, (v) => {
      checkpoint();
      part.pivot.x = v;
      renderPose();
    }));
    el.appendChild(numberField('pivot y', part.pivot.y, (v) => {
      checkpoint();
      part.pivot.y = v;
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
    // Keyable part scale (absolute sx/sy, rest.sx/sy fallback): the innermost slot rest
    // scale occupies (around the pivot, not propagating to children) — Animate scrub
    // shows it, and the .riv export replays it as an absolute Node scale. Shown for every
    // part like the other pose fields; a skinned part deforms by its bones, and scale
    // still never propagates to its children in the editor (unlike a Rive Node at
    // runtime), so THIS pair stays locked even though rotate/translate now key live
    // (user ruling 2026-07-12, "Allow rotate+translate").
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
    if (part.skin) {
      lockField(keySx, SKIN_SCALE_LOCK_TITLE);
      lockField(keySy, SKIN_SCALE_LOCK_TITLE);
    }
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
