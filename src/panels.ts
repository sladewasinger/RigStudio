/**
 * Side panels.
 *
 * Layers: a folder-style tree — parts nest under their parent part (bone hierarchy)
 * and each part folds open to show the SVG objects (paths) inside it. Drag a part onto
 * another to parent it; drop it on the "un-parent" strip to detach. Double-click
 * renames (names become Kotlin identifiers on export).
 *
 * Inspector: numeric fields for the selection. In Setup mode these edit the REST pose,
 * pivots, and parenting; in Animate mode they write keyframes at the playhead. Plus the
 * Claude animation assistant (choreograph / critique, optionally with a rendered
 * snapshot of the current pose for spatial grounding).
 */

import {
  state, notify, selectedPart, sampleChannel, setKeyframe, activeClip, selectPart,
  setParent, isAncestorOf, RigPart,
} from './model';
import { renderPose } from './view';
import { animateWithClaude, critiqueWithClaude } from './claude';
import { checkpoint } from './history';

/** Repaint the canvas and keyframe lanes after an inspector edit. */
function poseEdited(): void {
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

// ---- Layers tree ----

/** Parts whose folders are open. Persists across re-renders within a session. */
const expanded = new Set<string>();

export function buildLayersPanel(el: HTMLElement): void {
  el.innerHTML = '<h2>Layers</h2>';
  const doc = state.doc;
  if (!doc) return;

  const tree = document.createElement('ul');
  tree.className = 'layer-tree';
  // Topmost drawn part first, like every art tool.
  const roots = [...doc.parts].reverse().filter((p) => !p.parentId);
  for (const part of roots) tree.appendChild(partNode(part));
  el.appendChild(tree);

  // Drop strip: drag a part here to detach it from its parent.
  const unparent = document.createElement('div');
  unparent.className = 'unparent-zone';
  unparent.textContent = '⤒ drop a part here to un-parent it';
  wireDropTarget(unparent, null);
  el.appendChild(unparent);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Click ▸ to fold parts open. Drag one part onto another to parent it (limbs chain). ' +
    'Double-click renames.';
  el.appendChild(hint);
}

function partNode(part: RigPart): HTMLElement {
  const doc = state.doc!;
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'layer-row part';
  if (part.id === state.selectedPartId) row.classList.add('selected');
  else if (state.selectedPartIds.includes(part.id)) row.classList.add('in-selection');

  const isOpen = expanded.has(part.id);
  const children = [...doc.parts].reverse().filter((p) => p.parentId === part.id);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = isOpen ? '▾' : '▸';
  chevron.onclick = (ev) => {
    ev.stopPropagation();
    if (isOpen) expanded.delete(part.id);
    else expanded.add(part.id);
    notify();
  };
  row.appendChild(chevron);

  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = part.label;
  row.appendChild(name);

  const count = document.createElement('span');
  count.className = 'layer-count';
  count.textContent = children.length > 0 ? `${part.paths.length}+${children.length}` : `${part.paths.length}`;
  row.appendChild(count);

  row.onclick = (ev) => {
    selectPart(part.id, ev.shiftKey);
    notify();
    renderPose();
  };
  row.ondblclick = () => {
    const newName = prompt('Rename layer', part.label);
    if (newName) {
      checkpoint();
      part.label = newName.trim().replace(/\s+/g, '_');
      notify();
    }
  };

  // Drag-to-parent
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('text/rig-part', part.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  wireDropTarget(row, part.id);

  li.appendChild(row);

  if (isOpen) {
    const kids = document.createElement('ul');
    kids.className = 'layer-children';
    for (const child of children) kids.appendChild(partNode(child));
    for (const path of [...part.paths].reverse()) {
      const pathLi = document.createElement('li');
      const pathRow = document.createElement('div');
      pathRow.className = 'layer-row path';
      pathRow.innerHTML = `<span class="path-icon">◇</span>`;
      const pathName = document.createElement('span');
      pathName.className = 'layer-name';
      pathName.textContent = path.label;
      pathRow.appendChild(pathName);
      pathRow.onclick = () => {
        selectPart(part.id);
        notify();
        renderPose();
      };
      pathLi.appendChild(pathRow);
      kids.appendChild(pathLi);
    }
    li.appendChild(kids);
  }
  return li;
}

/** Accept part drags; newParentId null = detach. */
function wireDropTarget(el: HTMLElement, newParentId: string | null): void {
  el.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drop-target');
    const childId = ev.dataTransfer?.getData('text/rig-part');
    if (!childId || childId === newParentId) return;
    checkpoint();
    if (!setParent(childId, newParentId)) {
      alert('Cannot parent a part to its own descendant.');
      return;
    }
    if (newParentId) expanded.add(newParentId);
    notify();
    renderPose();
  });
}

// ---- Inspector ----

export function buildInspector(el: HTMLElement): void {
  el.innerHTML = '<h2>Inspector</h2>';
  const doc = state.doc;
  if (!doc) return;
  const setup = state.editorMode === 'setup';

  // Canvas tool switch (node editing is a Setup activity).
  if (setup) {
    const modeRow = document.createElement('div');
    modeRow.className = 'row';
    for (const mode of ['rig', 'nodes'] as const) {
      const b = document.createElement('button');
      b.textContent = mode === 'rig' ? 'Pose tool' : 'Node editing';
      if (state.mode === mode) b.classList.add('active');
      b.onclick = () => {
        state.mode = mode;
        notify();
        renderPose();
      };
      modeRow.appendChild(b);
    }
    el.appendChild(modeRow);
  }

  const part = selectedPart();
  if (part) {
    const title = document.createElement('h3');
    title.textContent = part.label + (setup ? ' — rest pose' : ' — keyed at playhead');
    el.appendChild(title);

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

      // Parent selector (bone hierarchy) — anything but itself or a descendant.
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
    } else {
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
    }

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent = setup
      ? state.mode === 'rig'
        ? 'Setup: drags reshape the character (never keyed). Drag crosshair = set joint. Shift+drag = move.'
        : 'Drag nodes to reshape. Alt+click a node = insert one after it. Ctrl+click = delete.'
      : 'Animate: drags record keyframes at the playhead. Ctrl = 15° snap. Shift+drag = move.';
    el.appendChild(help);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Select a part on the canvas or in Layers. Shift+click selects several.';
    el.appendChild(p);
  }

  // Root (whole figure) — animated channels in Animate mode, its pivot in Setup mode.
  const rootTitle = document.createElement('h3');
  rootTitle.textContent = 'Figure (root)';
  el.appendChild(rootTitle);
  if (setup) {
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
  } else {
    const t = state.currentTime;
    el.appendChild(numberField('jump y', sampleChannel('root', 'ty', t), (v) => {
      checkpoint();
      setKeyframe('root', 'ty', v);
      poseEdited();
    }));
    el.appendChild(numberField('scale x', sampleChannel('root', 'sx', t), (v) => {
      checkpoint();
      setKeyframe('root', 'sx', v);
      poseEdited();
    }, 0.01));
    el.appendChild(numberField('scale y', sampleChannel('root', 'sy', t), (v) => {
      checkpoint();
      setKeyframe('root', 'sy', v);
      poseEdited();
    }, 0.01));
  }

  buildAiPanel(el);
}

// ---- Claude assistant ----

/**
 * Rasterize the current canvas (sans overlay/onion) to a PNG for the vision-grounded
 * assistant calls. Returns base64 image data (no data: prefix).
 */
async function snapshotPose(): Promise<string | null> {
  const live = document.getElementById('rig-svg') as SVGSVGElement | null;
  const doc = state.doc;
  if (!live || !doc) return null;
  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#overlay')?.remove();
  clone.querySelector('#onion')?.remove();
  // Full-document framing regardless of the user's current zoom.
  const { x, y, w, h } = doc.viewBox;
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  const outW = 512;
  const outH = Math.round((512 * h) / w);
  clone.setAttribute('width', String(outW));
  clone.setAttribute('height', String(outH));

  const svgText = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('snapshot render failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL('image/png').split(',')[1] ?? null;
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

  const shotLabel = document.createElement('label');
  shotLabel.className = 'field';
  const shotToggle = document.createElement('input');
  shotToggle.type = 'checkbox';
  shotToggle.checked = localStorage.getItem('rig-studio-attach-shot') !== '0';
  shotToggle.onchange = () =>
    localStorage.setItem('rig-studio-attach-shot', shotToggle.checked ? '1' : '0');
  const shotSpan = document.createElement('span');
  shotSpan.textContent = 'attach pose snapshot (vision)';
  shotLabel.appendChild(shotSpan);
  shotLabel.appendChild(shotToggle);
  box.appendChild(shotLabel);

  const status = document.createElement('p');
  status.className = 'hint';
  box.appendChild(status);

  const critiqueOut = document.createElement('div');
  critiqueOut.className = 'critique-out';
  critiqueOut.hidden = true;

  const requireCtx = (): { doc: NonNullable<typeof state.doc>; apiKey: string } | null => {
    const doc = state.doc;
    const apiKey = keyInput.value.trim();
    if (!doc || !activeClip()) return null;
    if (!apiKey) {
      status.textContent = 'Enter an API key first.';
      return null;
    }
    return { doc, apiKey };
  };

  const go = document.createElement('button');
  go.textContent = 'Animate current clip';
  go.onclick = async () => {
    const ctx = requireCtx();
    const clip = activeClip();
    if (!ctx || !clip) return;
    if (!promptBox.value.trim()) {
      status.textContent = 'Describe the motion you want.';
      return;
    }
    go.disabled = true;
    status.textContent = 'Choreographing… (this can take a minute)';
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const updated = await animateWithClaude(
        ctx.apiKey, ctx.doc, clip, promptBox.value.trim(), image,
      );
      checkpoint(); // one undo step reverts the whole AI edit
      clip.duration = updated.duration;
      clip.tracks = updated.tracks;
      state.editorMode = 'animate';
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

  const critique = document.createElement('button');
  critique.textContent = 'Critique this animation';
  critique.onclick = async () => {
    const ctx = requireCtx();
    const clip = activeClip();
    if (!ctx || !clip) return;
    critique.disabled = true;
    status.textContent = 'Reviewing the clip…';
    critiqueOut.hidden = true;
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const text = await critiqueWithClaude(ctx.apiKey, ctx.doc, clip, image);
      critiqueOut.textContent = text;
      critiqueOut.hidden = false;
      status.textContent = '';
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      critique.disabled = false;
    }
  };
  box.appendChild(critique);
  box.appendChild(critiqueOut);

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
