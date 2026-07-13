/**
 * Field/row builders and small helpers shared across the inspector sections: the
 * repaint-after-edit helper, plain/keyable number fields, the color swatch field, and
 * the part parent selector (used by both the transform and bone sections).
 */
import {
  state, notify, setKeyframe, isAncestorOf, setParent, RigPart, Channel,
  keyAt, removeKeyAt,
} from '../../core/model';
import { renderPose } from '../../view';
import { checkpoint } from '../../core/history';

/** Repaint the canvas and keyframe lanes after an inspector edit. */
export function poseEdited(): void {
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

export function numberField(
  label: string, value: number, onChange: (v: number) => void, step = 1,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Math.round(value * 100) / 100);
  input.onchange = () => onChange(Number(input.value));
  row.appendChild(span);
  row.appendChild(input);
  return row;
}

/**
 * A numeric field for a keyable Animate-mode channel (part rotate/tx/ty, root
 * ty/sx/sy): a small toggle circle before the label — FILLED when the channel has a
 * keyframe exactly at the playhead (click removes it, emptying the track if it was
 * the last key, same as the timeline's key-delete), HOLLOW otherwise (click creates
 * one at the playhead using the field's current displayed value). `displayValue` is
 * re-read after a toggle so the field reflects whatever the channel falls back to
 * (rest, if the removed key was the only one). One checkpoint per click; the canvas/
 * timeline repaint via the existing poseEdited() pattern — this does NOT call
 * notify(), so it doesn't rebuild the rest of the inspector (matching every other
 * Animate-mode field here).
 */
export function keyableField(
  label: string, target: string, channel: Channel, displayValue: () => number,
  onChange: (v: number) => void, step = 1,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';

  const labelWrap = document.createElement('span');
  labelWrap.className = 'key-field-label';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'key-toggle';

  const span = document.createElement('span');
  span.textContent = label;

  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Math.round(displayValue() * 100) / 100);
  input.onchange = () => onChange(Number(input.value));

  const t = state.currentTime;
  const syncToggle = () => {
    const keyed = !!keyAt(target, channel, t);
    toggle.classList.toggle('is-keyed', keyed);
    toggle.title = keyed
      ? 'Keyframed at the playhead — click to remove'
      : 'Not keyed at the playhead — click to add';
  };
  syncToggle();

  toggle.onclick = (ev) => {
    ev.preventDefault();
    checkpoint();
    if (keyAt(target, channel, t)) {
      removeKeyAt(target, channel, t);
      input.value = String(Math.round(displayValue() * 100) / 100);
    } else {
      // "current displayed value" — whatever the field shows right now, including an
      // uncommitted edit the user typed but hasn't blurred off yet.
      setKeyframe(target, channel, Number(input.value));
    }
    poseEdited();
    syncToggle();
  };

  labelWrap.appendChild(toggle);
  labelWrap.appendChild(span);
  row.appendChild(labelWrap);
  row.appendChild(input);
  return row;
}

/** A color swatch with an on/off checkbox (null = no paint, like SVG "none"). */
export function colorField(
  label: string, value: string | null, onChange: (v: string | null) => void,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  row.appendChild(span);

  const wrap = document.createElement('span');
  wrap.className = 'color-wrap';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = value !== null;
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = normalizeHex(value) ?? '#000000';
  picker.disabled = value === null;
  enabled.onchange = () => {
    picker.disabled = !enabled.checked;
    onChange(enabled.checked ? picker.value : null);
  };
  picker.onchange = () => onChange(picker.value);
  wrap.appendChild(enabled);
  wrap.appendChild(picker);
  row.appendChild(wrap);
  return row;
}

/** <input type=color> only accepts #rrggbb. */
function normalizeHex(value: string | null): string | null {
  if (!value) return null;
  let hex = value.trim();
  if (!hex.startsWith('#')) return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

/** Parent selector (bone hierarchy) — anything but the part itself or a descendant. */
export function buildParentSelector(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const row = document.createElement('label');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = 'parent';
  const sel = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  sel.appendChild(none);
  for (const candidate of doc.parts) {
    if (candidate.id === part.id || isAncestorOf(part, candidate)) continue;
    const opt = document.createElement('option');
    opt.value = candidate.id;
    opt.textContent = candidate.label;
    if (part.parentId === candidate.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    checkpoint();
    setParent(part.id, sel.value || null);
    notify();
    renderPose();
  };
  row.appendChild(span);
  row.appendChild(sel);
  el.appendChild(row);
}
