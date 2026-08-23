import { RigPart } from '../../core/model';
import {
  activeInfluenceTarget, applyInfluenceEditing, beginInfluenceEditing,
  cancelInfluenceEditing, influenceTargetFor, refineInfluenceNodes,
  resetInfluenceEditing, updateInfluenceBand,
} from '../../view';

export function buildInfluenceBandsSection(el: HTMLElement, part: RigPart): void {
  const available = influenceTargetFor(part);
  const active = activeInfluenceTarget();
  const title = document.createElement('h3');
  title.textContent = 'Group weights';
  el.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = available
    ? `${available.arts.length} descendant path part${available.arts.length === 1 ? '' : 's'} share ` +
      `${available.profile.bands.length} editable bone-joint crossover${available.profile.bands.length === 1 ? '' : 's'}. ` +
      'Generated weights include hidden paths and Bézier handles; manual node refinements win.'
    : 'Add a chain of at least two bones to this group or art subtree first. Every bound descendant must use the same chain.';
  el.appendChild(hint);

  if (!active || active.target.id !== part.id) {
    const edit = document.createElement('button');
    edit.textContent = 'Edit group weights';
    edit.disabled = !available;
    edit.title = available
      ? 'Show one shared crossover band per internal bone joint'
      : 'No usable shared bound chain in this subtree';
    edit.onclick = () => beginInfluenceEditing(part);
    el.appendChild(edit);
    return;
  }

  const session = active.profile;
  const selectedIndex = Math.max(0, Math.min(
    session.bands.length - 1, active.selectedBand ?? 0,
  ));
  const band = session.bands[selectedIndex] ?? session.bands[0];

  if (band) {
    const selectedHint = document.createElement('p');
    selectedHint.className = 'hint influence-joint-readout';
    selectedHint.textContent = `Editing Joint ${selectedIndex + 1}: ${band.parentBoneId} → ${band.childBoneId}`;
    selectedHint.setAttribute('aria-live', 'polite');
    el.appendChild(selectedHint);
    const addSlider = (
      label: string, value: number, min: number, max: number, step: number,
      apply: (value: number) => void,
    ) => {
      const row = document.createElement('label');
      row.className = 'field';
      const span = document.createElement('span');
      span.textContent = `${label} ${value.toFixed(1)}`;
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(min); input.max = String(max);
      input.step = String(step); input.value = String(value);
      input.oninput = () => {
        const next = Number(input.value);
        span.textContent = `${label} ${next.toFixed(1)}`;
        apply(next);
      };
      row.append(span, input);
      el.appendChild(row);
    };
    addSlider('center offset', band.center, -100, 100, 0.5,
      (value) => updateInfluenceBand(selectedIndex, { center: value }));
    addSlider('softness width', band.width, 1, 200, 0.5,
      (value) => updateInfluenceBand(selectedIndex, { width: value }));
  }

  const actions = document.createElement('div');
  actions.className = 'align-grid influence-actions';
  const button = (label: string, fn: () => void) => {
    const control = document.createElement('button');
    control.textContent = label;
    control.onclick = fn;
    actions.appendChild(control);
  };
  button('Apply / Done', () => { applyInfluenceEditing(); });
  button('Cancel', cancelInfluenceEditing);
  button('Reset Auto', resetInfluenceEditing);
  button('Refine nodes', refineInfluenceNodes);
  el.appendChild(actions);
}
