import { state, activeClip, notify } from '../../core/model';
import { checkpoint } from '../../core/history';
import { renderPose } from '../../view';
import {
  copySelectedKeys, deleteSelectedKeys, selectedKeyEntries, SelectedKeyEntry,
} from '../../timeline/timeline';

function readout(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field visibility-key-readout';
  const name = document.createElement('span');
  name.textContent = label;
  const output = document.createElement('output');
  output.textContent = value;
  row.append(name, output);
  return row;
}

function ownerName(entry: SelectedKeyEntry): string {
  if (entry.track.target === 'root') return 'Figure (root)';
  const part = state.doc?.parts.find((candidate) => candidate.id === entry.track.target);
  return part?.label ?? entry.track.target;
}

function common(values: string[]): string {
  return new Set(values).size === 1 ? values[0] : 'Mixed';
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = action;
  return button;
}

function buildActions(el: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'row visibility-key-actions';
  const copy = actionButton('Copy keyframes', () => {
    const count = copySelectedKeys();
    copy.textContent = count === 1 ? 'Copied keyframe' : `Copied ${count} keyframes`;
  });
  row.append(copy, actionButton('Delete keyframes', deleteSelectedKeys));
  el.appendChild(row);
}

function editTime(entry: SelectedKeyEntry, input: HTMLInputElement): void {
  const requested = Number(input.value);
  if (!Number.isFinite(requested)) {
    input.value = String(entry.key.time);
    return;
  }
  const time = Math.min(activeClip()?.duration ?? Infinity, Math.max(0, requested));
  if (time === entry.key.time) return;
  checkpoint();
  entry.key.time = time;
  entry.track.keyframes.sort((a, b) => a.time - b.time);
  state.currentTime = time;
  notify();
  renderPose();
}

function setVisibility(entry: SelectedKeyEntry, visible: boolean): void {
  const value = visible ? 1 : 0;
  if (entry.key.value === value) return;
  checkpoint();
  entry.key.value = value;
  notify();
  renderPose();
}

function buildSingle(el: HTMLElement, entry: SelectedKeyEntry): void {
  const title = document.createElement('h3');
  title.textContent = `${ownerName(entry)} — Visibility`;
  el.appendChild(title);
  el.appendChild(readout('Owner', ownerName(entry)));
  el.appendChild(readout('Property', 'Visibility'));

  const valueRow = document.createElement('div');
  valueRow.className = 'field visibility-key-value';
  const valueLabel = document.createElement('span');
  valueLabel.textContent = 'Value';
  const choices = document.createElement('div');
  choices.className = 'row visibility-key-choices';
  const visible = actionButton('Visible', () => setVisibility(entry, true));
  const hidden = actionButton('Hidden', () => setVisibility(entry, false));
  visible.classList.toggle('active', entry.key.value >= 0.5);
  hidden.classList.toggle('active', entry.key.value < 0.5);
  visible.setAttribute('aria-pressed', String(entry.key.value >= 0.5));
  hidden.setAttribute('aria-pressed', String(entry.key.value < 0.5));
  choices.append(visible, hidden);
  valueRow.append(valueLabel, choices);
  el.appendChild(valueRow);

  const timeRow = document.createElement('label');
  timeRow.className = 'field visibility-key-time';
  const timeLabel = document.createElement('span');
  timeLabel.textContent = 'Time (ms)';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = String(activeClip()?.duration ?? '');
  input.step = '10';
  input.value = String(entry.key.time);
  input.onchange = () => editTime(entry, input);
  timeRow.append(timeLabel, input);
  el.appendChild(timeRow);
  el.appendChild(readout('Behavior', 'Stepped · holds until next key'));
  buildActions(el);
}

function buildMultiple(el: HTMLElement, entries: SelectedKeyEntry[]): void {
  const title = document.createElement('h3');
  title.textContent = `${entries.length} keyframes selected`;
  el.appendChild(title);
  el.appendChild(readout('Owner', common(entries.map(ownerName))));
  el.appendChild(readout('Property', common(entries.map(({ track }) =>
    track.channel === 'visibility' ? 'Visibility' : track.channel))));
  el.appendChild(readout('Value', common(entries.map(({ key, track }) =>
    track.channel === 'visibility' ? (key.value >= 0.5 ? 'Visible' : 'Hidden') : String(key.value)))));
  el.appendChild(readout('Time', common(entries.map(({ key }) => `${key.time} ms`))));
  el.appendChild(readout('Behavior', entries.every(({ track }) => track.channel === 'visibility')
    ? 'Stepped · holds until next key' : 'Mixed'));
  buildActions(el);
}

/** Render selected visibility keys as the Inspector's primary context. Returns true
 * when the ordinary part Inspector should be suppressed. */
export function buildVisibilityKeySection(el: HTMLElement): boolean {
  const entries = selectedKeyEntries();
  if (entries.length === 0 || !entries.some(({ track }) => track.channel === 'visibility')) return false;
  if (entries.length === 1) buildSingle(el, entries[0]);
  else buildMultiple(el, entries);
  return true;
}
