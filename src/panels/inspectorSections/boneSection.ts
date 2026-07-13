// ---- Bone position model ----
import { state, RigPart, boneLength, setBoneLength, translateBoneChain } from '../../core/model';
import { rebindFrozenChain } from '../../view';
import { checkpoint } from '../../core/history';
import { numberField, poseEdited, buildParentSelector } from './shared';

/**
 * Setup-mode fields for a BONE. A chain's ROOT bone gets position (its origin) + rotation
 * + length; a CHILD bone gets rotation + length only, its origin riding the parent's tip
 * (one shared joint — never independently editable, so no raw pivot / rest-translate
 * fields). An ATTACHED root (unified skeleton — cross-chain loose child, origin NOT at
 * the parent's tip) is a chain root, not a shared joint: it gets offset x/y fields bound
 * to rest.tx/ty in the parent frame — the same fields the attach fold and the freeze
 * origin drag write. Editing length moves the tip along the bone's current axis and
 * carries any child origins with it; editing position translates the whole chain.
 */
export function buildBoneRestSection(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const parentBone = part.parentId
    ? doc.parts.find((p) => p.id === part.parentId && p.kind === 'bone')
    : null;

  // Freeze-mode bone edits reshape the rig against static art: after the pose mutates,
  // refresh the bind so the skinned art stays put (outside freeze it deforms — posing the
  // limb — through the LBS delta, exactly like the canvas drags).
  const afterBoneEdit = () => {
    if (state.freezeMode) rebindFrozenChain(part.id);
    poseEdited();
  };

  el.appendChild(numberField('rotation (deg)', part.rest.rotate, (v) => {
    checkpoint();
    part.rest.rotate = v;
    afterBoneEdit();
  }));
  el.appendChild(numberField('length', boneLength(part), (v) => {
    checkpoint();
    setBoneLength(doc.parts, part, Math.max(0, v));
    afterBoneEdit();
  }, 0.5));

  if (!parentBone) {
    // Root of the chain: it alone carries a position; moving it translates the whole limb.
    el.appendChild(numberField('position x', part.pivot.x, (v) => {
      checkpoint();
      translateBoneChain(doc.parts, part.id, v - part.pivot.x, 0);
      afterBoneEdit();
    }));
    el.appendChild(numberField('position y', part.pivot.y, (v) => {
      checkpoint();
      translateBoneChain(doc.parts, part.id, 0, v - part.pivot.y);
      afterBoneEdit();
    }));
  } else if (part.attachedRoot) {
    // Attached root (cross-chain loose child): its position is the rest.tx/ty offset in
    // the PARENT bone's frame — the exact fields the attach fold and the freeze origin
    // drag write. Writing them shifts the whole attached sub-chain through ordinary
    // chain composition; the cross-chain parent is untouched by construction.
    el.appendChild(numberField(`offset x (in ${parentBone.label}'s frame)`, part.rest.tx, (v) => {
      checkpoint();
      part.rest.tx = v;
      afterBoneEdit();
    }));
    el.appendChild(numberField(`offset y (in ${parentBone.label}'s frame)`, part.rest.ty, (v) => {
      checkpoint();
      part.rest.ty = v;
      afterBoneEdit();
    }));
  } else {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `Origin follows ${parentBone.label}'s tip (shared joint). ` +
      'Fit this bone with rotation + length.';
    el.appendChild(info);
  }

  buildParentSelector(el, part);
}
