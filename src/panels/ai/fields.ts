/**
 * Static form fields for the AI panel (api key, prompt, filmstrip/rig/protect toggles,
 * status line, busy indicator, critique output) — the "DOM/build" half of the former
 * `panels/ai.ts` monolith. Self-contained field wiring (localStorage-backed toggles,
 * the prompt textarea, Cancel) lives here; `./panel.ts` assembles these into the panel
 * and wires the action buttons to `./requests.ts`; `./previewBar.ts` builds the separate
 * preview-review card.
 */
import { ai } from './state';

export interface AiFields {
  keyInput: HTMLInputElement;
  promptBox: HTMLTextAreaElement;
  shotToggle: HTMLInputElement;
  rigToggle: HTMLInputElement;
  protectToggle: HTMLInputElement;
  status: HTMLParagraphElement;
  busyRow: HTMLElement;
  critiqueOut: HTMLElement;
  createBtn: HTMLButtonElement;
  modifyBtn: HTMLButtonElement;
  critiqueBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
}

function infoSpan(title: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'ai-info';
  span.textContent = 'ⓘ'; // circled "i"
  span.title = title;
  return span;
}

/** Builds every static field, wires its own self-contained handlers (localStorage
 *  persistence, promptText mirroring, Cancel), and reflects `ai.critiqueText`/
 *  `ai.status` into the DOM at build time. Does NOT append anything or wire the
 *  action buttons (Create/Modify/Critique) — `./panel.ts` owns layout order and
 *  request wiring. */
export function buildAiFields(): AiFields {
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Anthropic API key (stored locally)';
  keyInput.value = localStorage.getItem('rig-studio-api-key') ?? '';
  keyInput.onchange = () => localStorage.setItem('rig-studio-api-key', keyInput.value.trim());

  const promptBox = document.createElement('textarea');
  promptBox.placeholder = 'e.g. "wave with the right arm", "bend at the knees then jump"';
  promptBox.rows = 3;
  promptBox.value = ai.promptText;
  promptBox.oninput = () => { ai.promptText = promptBox.value; };

  const shotToggle = document.createElement('input');
  shotToggle.type = 'checkbox';
  shotToggle.checked = localStorage.getItem('rig-studio-attach-shot') !== '0';
  shotToggle.onchange = () =>
    localStorage.setItem('rig-studio-attach-shot', shotToggle.checked ? '1' : '0');

  const rigToggle = document.createElement('input');
  rigToggle.type = 'checkbox';
  rigToggle.checked = localStorage.getItem('rig-studio-allow-rig-edits') === '1';
  rigToggle.onchange = () =>
    localStorage.setItem('rig-studio-allow-rig-edits', rigToggle.checked ? '1' : '0');

  const protectToggle = document.createElement('input');
  protectToggle.type = 'checkbox';
  protectToggle.checked = localStorage.getItem('rig-studio-protect-playhead') === '1';
  protectToggle.onchange = () =>
    localStorage.setItem('rig-studio-protect-playhead', protectToggle.checked ? '1' : '0');

  const status = document.createElement('p');
  status.className = 'hint';
  status.textContent = ai.status;

  const busyRow = document.createElement('p');
  busyRow.className = 'hint ai-busy-indicator';
  busyRow.hidden = !ai.busy;
  const busyDot = document.createElement('span');
  busyDot.className = 'ai-busy-dot';
  const busyText = document.createElement('span');
  busyText.textContent = 'Waiting on Claude…';
  busyRow.append(busyDot, busyText);

  const critiqueOut = document.createElement('div');
  critiqueOut.className = 'critique-out';
  critiqueOut.hidden = ai.critiqueText === null;
  if (ai.critiqueText) critiqueOut.textContent = ai.critiqueText;

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create new animation';
  createBtn.title =
    'Ask Claude for a brand-new clip realizing this direction. The current clip is sent ' +
    'as reference context only — it is never modified.';
  const modifyBtn = document.createElement('button');
  modifyBtn.textContent = 'Modify current animation';
  modifyBtn.title = 'Ask Claude to edit the active clip in place.';
  const critiqueBtn = document.createElement('button');
  critiqueBtn.textContent = 'Critique this animation';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = !ai.busy;
  cancelBtn.onclick = () => ai.abort?.abort();

  return {
    keyInput, promptBox, shotToggle, rigToggle, protectToggle, status, busyRow,
    critiqueOut, createBtn, modifyBtn, critiqueBtn, cancelBtn,
  };
}

/** api key + prompt textarea only — split out from `mountAiToggleFields` so
 *  `./panel.ts` can insert the AI Animate System v2 A4 thread strip "under the prompt
 *  box" (between this and the toggle rows), per the wave brief. */
export function mountAiIntroFields(box: HTMLElement, f: AiFields): void {
  box.appendChild(f.keyInput);
  box.appendChild(f.promptBox);
}

/** Toggle rows + status/busy readouts, appended AFTER the thread strip. */
export function mountAiToggleFields(box: HTMLElement, f: AiFields): void {
  const shotLabel = document.createElement('label');
  shotLabel.className = 'field';
  const shotSpan = document.createElement('span');
  shotSpan.textContent = 'attach rendered frames (filmstrip) ';
  shotSpan.appendChild(infoSpan(
    'Renders up to 6 frames across the clip (denser where its motion actually changes) ' +
    'and sends them to Claude so it sees the animation, not just one pose. On Retry with ' +
    'a candidate showing, the frames come from the CANDIDATE instead of the document. ' +
    'Falls back to a single current-pose snapshot if rendering fails.',
  ));
  shotLabel.append(shotSpan, f.shotToggle);
  box.appendChild(shotLabel);

  const rigLabel = document.createElement('label');
  rigLabel.className = 'field';
  const rigSpan = document.createElement('span');
  rigSpan.textContent = 'allow rig changes (bones / parenting / pivots / auto-bind)';
  rigLabel.append(rigSpan, f.rigToggle);
  box.appendChild(rigLabel);

  const protectLabel = document.createElement('label');
  protectLabel.className = 'field';
  const protectSpan = document.createElement('span');
  protectSpan.textContent = 'protect playhead keyframes (Modify) ';
  protectSpan.appendChild(infoSpan(
    'Modify only. Locks every keyframe already at the current playhead time (across all ' +
    'tracks of this clip) so Claude cannot move, re-value, or remove them — enforced both ' +
    'in the prompt and by restoring them after the response is applied.',
  ));
  protectLabel.append(protectSpan, f.protectToggle);
  box.appendChild(protectLabel);

  box.appendChild(f.status);
  box.appendChild(f.busyRow);
}

/** Trailing rows (action buttons + critique output) — appended AFTER the preview bar
 *  (when one is showing), matching the original panel's DOM order. */
export function mountAiActions(box: HTMLElement, f: AiFields): void {
  box.appendChild(f.createBtn);
  box.appendChild(f.modifyBtn);
  box.appendChild(f.critiqueBtn);
  box.appendChild(f.cancelBtn);
  box.appendChild(f.critiqueOut);
}

/** Toggle the whole-editor inert overlay (pointer-events + dim) while a request runs.
 *  `.ai-panel` opts back into pointer events (ui.css) so Cancel stays clickable. */
export function setEditorInert(active: boolean): void {
  document.getElementById('layout')?.classList.toggle('ai-busy', active);
}

/** Disables every field but keeps Cancel visible exactly while `busy`. */
export function applyBusyState(f: AiFields, busy: boolean): void {
  f.keyInput.disabled = busy;
  f.promptBox.disabled = busy;
  f.shotToggle.disabled = busy;
  f.rigToggle.disabled = busy;
  f.protectToggle.disabled = busy;
  f.createBtn.disabled = busy;
  f.modifyBtn.disabled = busy;
  f.critiqueBtn.disabled = busy;
  f.cancelBtn.hidden = !busy;
  f.busyRow.hidden = !busy;
  setEditorInert(busy);
}
