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
  state, notify, selectedPart, selectedPath, sampleChannel, channelValue, setKeyframe,
  activeClip, selectPart, setParent, isAncestorOf, movePartRelativeTo, RigPart,
} from './model';
import { renderPose, updatePathAttrs, reorderCanvas } from './view';
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

  // Drag to reorder (top/bottom edge = above/below) or to parent (middle).
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('text/rig-part', part.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  wirePartRowDrop(row, part);

  li.appendChild(row);

  if (isOpen) {
    const kids = document.createElement('ul');
    kids.className = 'layer-children';
    for (const child of children) kids.appendChild(partNode(child));
    for (const path of [...part.paths].reverse()) {
      const pathLi = document.createElement('li');
      const pathRow = document.createElement('div');
      pathRow.className = 'layer-row path';
      if (state.selectedPathId === path.id) pathRow.classList.add('selected');
      pathRow.innerHTML = `<span class="path-icon">◇</span>`;
      const pathName = document.createElement('span');
      pathName.className = 'layer-name';
      pathName.textContent = path.label;
      pathRow.appendChild(pathName);
      pathRow.onclick = () => {
        // Enter the part and select this object — the inspector shows its style and
        // node editing scopes to it.
        selectPart(part.id);
        state.selectedPathId = path.id;
        notify();
        renderPose();
      };
      pathRow.ondblclick = () => {
        const newName = prompt('Rename object', path.label);
        if (newName) {
          checkpoint();
          path.label = newName.trim().replace(/\s+/g, '_');
          notify();
        }
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

const DROP_CLASSES = ['drop-target', 'drop-above', 'drop-below'];

/** Which drop action the pointer position means: near the edges reorders, middle parents. */
function dropZoneOf(ev: DragEvent, el: HTMLElement): 'above' | 'into' | 'below' {
  const r = el.getBoundingClientRect();
  const f = (ev.clientY - r.top) / r.height;
  if (f < 0.25) return 'above';
  if (f > 0.75) return 'below';
  return 'into';
}

/**
 * Part rows accept three drops: top edge = draw just above this part, bottom edge =
 * just below (both adopt this part's parent — sibling insertion), middle = parent
 * the dragged part into this one.
 */
function wirePartRowDrop(row: HTMLElement, part: RigPart): void {
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('text/rig-part')) return;
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.toggle('drop-target', zone === 'into');
    row.classList.toggle('drop-above', zone === 'above');
    row.classList.toggle('drop-below', zone === 'below');
  });
  row.addEventListener('dragleave', () => row.classList.remove(...DROP_CLASSES));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const zone = dropZoneOf(ev, row);
    row.classList.remove(...DROP_CLASSES);
    const draggedId = ev.dataTransfer?.getData('text/rig-part');
    if (!draggedId || draggedId === part.id) return;
    checkpoint();
    const ok = zone === 'into'
      ? setParent(draggedId, part.id)
      : movePartRelativeTo(draggedId, part.id, zone);
    if (!ok) {
      alert('That drop would create a parenting cycle.');
      return;
    }
    if (zone === 'into') expanded.add(part.id);
    reorderCanvas();
    notify();
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
      el.appendChild(numberField('rest scale x', part.rest.sx, (v) => {
        checkpoint();
        part.rest.sx = v || 1;
        poseEdited();
      }, 0.01));
      el.appendChild(numberField('rest scale y', part.rest.sy, (v) => {
        checkpoint();
        part.rest.sy = v || 1;
        poseEdited();
      }, 0.01));
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
      // Displayed values are absolute (rest fills unkeyed channels); editing keys.
      const t = state.currentTime;
      el.appendChild(numberField('rotate (deg)', channelValue(part, 'rotate', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'rotate', v);
        poseEdited();
      }));
      el.appendChild(numberField('translate x', channelValue(part, 'tx', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'tx', v);
        poseEdited();
      }));
      el.appendChild(numberField('translate y', channelValue(part, 'ty', t), (v) => {
        checkpoint();
        setKeyframe(part.id, 'ty', v);
        poseEdited();
      }));
    }

    if (setup) buildPathSection(el);

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

/** Style editor for the "entered" path (fill/stroke), Setup mode only. */
function buildPathSection(el: HTMLElement): void {
  const sel = selectedPath();
  if (!sel) return;
  const { path } = sel;

  const title = document.createElement('h3');
  title.textContent = `object: ${path.label}`;
  el.appendChild(title);

  const apply = () => {
    updatePathAttrs(path);
    renderPose();
  };

  el.appendChild(colorField('fill', path.fill, (v) => {
    checkpoint();
    path.fill = v;
    apply();
  }));
  el.appendChild(numberField('fill opacity', path.fillOpacity, (v) => {
    checkpoint();
    path.fillOpacity = Math.min(1, Math.max(0, v));
    apply();
  }, 0.05));
  el.appendChild(colorField('stroke', path.stroke, (v) => {
    checkpoint();
    path.stroke = v;
    apply();
  }));
  el.appendChild(numberField('stroke width', path.strokeWidth, (v) => {
    checkpoint();
    path.strokeWidth = Math.max(0, v);
    apply();
  }, 0.1));
  el.appendChild(numberField('stroke opacity', path.strokeOpacity, (v) => {
    checkpoint();
    path.strokeOpacity = Math.min(1, Math.max(0, v));
    apply();
  }, 0.05));

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Escape or a blank canvas click exits the object. Node editing scopes to it.';
  el.appendChild(hint);
}

/** A color swatch with an on/off checkbox (null = no paint, like SVG "none"). */
function colorField(
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
