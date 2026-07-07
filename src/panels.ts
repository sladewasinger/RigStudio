/**
 * Side panels: the layers list (select + rename parts) and the inspector (numeric pose
 * values, pivot coordinates, and the Claude animation assistant).
 */

import {
  state, notify, selectedPart, sampleChannel, setKeyframe, activeClip,
} from './model';
import { renderPose } from './view';
import { animateWithClaude } from './claude';
import { checkpoint } from './history';

/** Repaint the canvas and keyframe lanes after an inspector edit. */
function poseEdited(): void {
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

export function buildLayersPanel(el: HTMLElement): void {
  el.innerHTML = '<h2>Layers</h2>';
  const doc = state.doc;
  if (!doc) return;

  const list = document.createElement('ul');
  list.className = 'layer-list';
  // Topmost drawn part first, like every art tool.
  for (const part of [...doc.parts].reverse()) {
    const li = document.createElement('li');
    li.textContent = part.label;
    if (part.id === state.selectedPartId) li.classList.add('selected');
    li.onclick = () => {
      state.selectedPartId = part.id;
      notify();
      renderPose();
    };
    li.ondblclick = () => {
      const name = prompt('Rename layer', part.label);
      if (name) {
        checkpoint();
        part.label = name.trim().replace(/\s+/g, '_');
        notify();
      }
    };
    list.appendChild(li);
  }
  el.appendChild(list);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Double-click to rename. Names become identifiers in the exported Kotlin.';
  el.appendChild(hint);
}

export function buildInspector(el: HTMLElement): void {
  el.innerHTML = '<h2>Inspector</h2>';
  const doc = state.doc;
  if (!doc) return;

  // Mode switch
  const modeRow = document.createElement('div');
  modeRow.className = 'row';
  for (const mode of ['rig', 'nodes'] as const) {
    const b = document.createElement('button');
    b.textContent = mode === 'rig' ? 'Rig mode' : 'Node editing';
    if (state.mode === mode) b.classList.add('active');
    b.onclick = () => {
      state.mode = mode;
      notify();
      renderPose();
    };
    modeRow.appendChild(b);
  }
  el.appendChild(modeRow);

  const part = selectedPart();
  if (part) {
    const title = document.createElement('h3');
    title.textContent = part.label;
    el.appendChild(title);

    const t = state.currentTime;
    el.appendChild(numberField('rotate (deg)', sampleChannel(part.id, 'rotate', t), (v) => {
      checkpoint();
      setKeyframe(part.id, 'rotate', v);
      poseEdited();
    }));
    el.appendChild(numberField('translate x', sampleChannel(part.id, 'tx', t), (v) => {
      checkpoint();
      setKeyframe(part.id, 'tx', v);
      poseEdited();
    }));
    el.appendChild(numberField('translate y', sampleChannel(part.id, 'ty', t), (v) => {
      checkpoint();
      setKeyframe(part.id, 'ty', v);
      poseEdited();
    }));
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

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent =
      state.mode === 'rig'
        ? 'Drag on canvas = rotate around pivot (keyed at playhead). Shift+drag = move. Drag crosshair = set joint.'
        : 'Drag nodes to reshape. Alt+click a node = insert one after it. Ctrl+click = delete.';
    el.appendChild(help);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Select a part on the canvas or in Layers.';
    el.appendChild(p);
  }

  // Root (whole figure) channels — for jumps and squash-and-stretch.
  const rootTitle = document.createElement('h3');
  rootTitle.textContent = 'Figure (root)';
  el.appendChild(rootTitle);
  const t = state.currentTime;
  el.appendChild(numberField('jump y', sampleChannel('root', 'ty', t), (v) => {
    setKeyframe('root', 'ty', v);
    poseEdited();
  }));
  el.appendChild(numberField('scale x', sampleChannel('root', 'sx', t), (v) => {
    setKeyframe('root', 'sx', v);
    poseEdited();
  }, 0.01));
  el.appendChild(numberField('scale y', sampleChannel('root', 'sy', t), (v) => {
    setKeyframe('root', 'sy', v);
    poseEdited();
  }, 0.01));
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

  buildAiPanel(el);
}

function buildAiPanel(el: HTMLElement): void {
  const box = document.createElement('div');
  box.className = 'ai-panel';
  box.innerHTML = '<h3>Animate with Claude</h3>';

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Anthropic API key (stored locally)';
  keyInput.value = localStorage.getItem('rig-studio-api-key') ?? '';
  keyInput.onchange = () => localStorage.setItem('rig-studio-api-key', keyInput.value.trim());
  box.appendChild(keyInput);

  const promptBox = document.createElement('textarea');
  promptBox.placeholder = 'e.g. "make him wave with the right arm", "bend at the knees then jump"';
  promptBox.rows = 3;
  box.appendChild(promptBox);

  const status = document.createElement('p');
  status.className = 'hint';
  box.appendChild(status);

  const go = document.createElement('button');
  go.textContent = 'Animate current clip';
  go.onclick = async () => {
    const doc = state.doc;
    const clip = activeClip();
    const apiKey = keyInput.value.trim();
    if (!doc || !clip) return;
    if (!apiKey) {
      status.textContent = 'Enter an API key first.';
      return;
    }
    if (!promptBox.value.trim()) {
      status.textContent = 'Describe the motion you want.';
      return;
    }
    go.disabled = true;
    status.textContent = 'Choreographing… (this can take a minute)';
    try {
      const updated = await animateWithClaude(apiKey, doc, clip, promptBox.value.trim());
      checkpoint(); // one undo step reverts the whole AI edit
      clip.duration = updated.duration;
      clip.tracks = updated.tracks;
      state.currentTime = 0;
      state.playing = true;
      status.textContent = 'Done — playing the result.';
      notify();
      renderPose();
      document.dispatchEvent(new CustomEvent('rig-play'));
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      go.disabled = false;
    }
  };
  box.appendChild(go);
  el.appendChild(box);
}

function numberField(
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
