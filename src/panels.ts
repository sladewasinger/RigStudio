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
  state, notify, selectedPart, selectedParts, selectedPath, sampleChannel, channelValue,
  setKeyframe, activeClip, selectPart, setParent, isAncestorOf, movePartRelativeTo,
  groupParts, ungroupPart, applyRigChanges, ancestorChain, RigPart, Track, Channel,
} from './model';
import {
  renderPose, updatePathAttrs, reorderCanvas, flipSelected, partRootBoxes,
  applyRootDeltas, registerPart, unregisterPart, startBonePlacement, hasSelectedNode,
  applyNodeOp, NodeOp, enterGroupsFor, bindSelectedToBones, unbindSelectedSkin,
  selectedNodeCount, primaryNodeType,
} from './view';
import { alignDeltas, distributeDeltas, AlignEdge, AlignReference } from './align';
import { animateWithClaude, critiqueWithClaude } from './claude';
import { checkpoint } from './history';

/** Repaint the canvas and keyframe lanes after an inspector edit. */
function poseEdited(): void {
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

// ---- Icons (inline SVG, stroke = currentColor) ----

const ICON_PATHS: Record<string, string> = {
  select: '<path d="M4 2 L12.5 8 L8.7 8.9 L10.6 13.4 L8.7 14.2 L6.8 9.7 L4 12 Z" fill="currentColor" stroke="none"/>',
  translate: '<path d="M8 1.5v13M1.5 8h13M8 1.5l-2 2M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
  rotate: '<path d="M13.5 8a5.5 5.5 0 1 1-2-4.2"/><path d="M11.2 1.6l0.4 2.5-2.5 0.3" />',
  ik: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  flipH: '<path d="M8 1.5v13" stroke-dasharray="2 1.6"/><path d="M6 4.5L2 8l4 3.5zM10 4.5L14 8l-4 3.5z" fill="currentColor" stroke="none"/>',
  flipV: '<path d="M1.5 8h13" stroke-dasharray="2 1.6"/><path d="M4.5 6L8 2l3.5 4zM4.5 10L8 14l-3.5-4z" fill="currentColor" stroke="none"/>',
  group: '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="6" y="6" width="8" height="8" rx="1"/>',
  ungroup: '<rect x="2" y="2" width="7" height="7" rx="1"/><rect x="7" y="7" width="7" height="7" rx="1" stroke-dasharray="2 1.6"/><path d="M12 2l2 2M14 2l-2 2"/>',
  bone: '<path d="M3.4 3.4 L11 6.6 L12.6 12.6 L6.6 11 Z M3.4 3.4a1.6 1.6 0 1 0 .1.1" fill="currentColor" stroke="none" fill-opacity="0.85"/>',
  bind: '<path d="M3 13c2-5 3-8 5-11M8 13c1.5-3.5 2.5-6 4-9" /><path d="M2.5 6h11M4 10h9" stroke-dasharray="1.6 1.4"/>',
  alignL: '<path d="M2 2v12"/><rect x="4" y="3.5" width="8" height="3" fill="currentColor" stroke="none"/><rect x="4" y="9.5" width="5" height="3" fill="currentColor" stroke="none"/>',
  alignCH: '<path d="M8 2v12"/><rect x="3" y="3.5" width="10" height="3" fill="currentColor" stroke="none"/><rect x="5" y="9.5" width="6" height="3" fill="currentColor" stroke="none"/>',
  alignR: '<path d="M14 2v12"/><rect x="4" y="3.5" width="8" height="3" fill="currentColor" stroke="none"/><rect x="7" y="9.5" width="5" height="3" fill="currentColor" stroke="none"/>',
  alignT: '<path d="M2 2h12"/><rect x="3.5" y="4" width="3" height="8" fill="currentColor" stroke="none"/><rect x="9.5" y="4" width="3" height="5" fill="currentColor" stroke="none"/>',
  alignM: '<path d="M2 8h12"/><rect x="3.5" y="3" width="3" height="10" fill="currentColor" stroke="none"/><rect x="9.5" y="5" width="3" height="6" fill="currentColor" stroke="none"/>',
  alignB: '<path d="M2 14h12"/><rect x="3.5" y="4" width="3" height="8" fill="currentColor" stroke="none"/><rect x="9.5" y="7" width="3" height="5" fill="currentColor" stroke="none"/>',
  distH: '<path d="M2 2v12M14 2v12"/><rect x="6" y="5" width="4" height="6" fill="currentColor" stroke="none"/>',
  distV: '<path d="M2 2h12M2 14h12"/><rect x="5" y="6" width="6" height="4" fill="currentColor" stroke="none"/>',
};

/** An inline 16×16 line icon; falls back to the raw name for unknown keys. */
function icon(name: keyof typeof ICON_PATHS): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML =
    `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" ` +
    `stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ` +
    `stroke-linejoin="round">${ICON_PATHS[name] ?? ''}</svg>`;
  return span;
}

function iconButton(
  name: keyof typeof ICON_PATHS, label: string, title: string, onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.appendChild(icon(name));
  if (label) {
    const t = document.createElement('span');
    t.textContent = label;
    b.appendChild(t);
  }
  b.title = title;
  b.onclick = onClick;
  b.classList.add('icon-btn');
  return b;
}

// ---- Canvas tools bar + shared editing actions ----

/** Flip the selection (also bound to H/V keys in main.ts). */
export function flipAction(axis: 'h' | 'v'): void {
  if (state.editorMode !== 'setup') return;
  if (!selectedParts().some((p) => p.paths.length > 0)) return;
  checkpoint();
  flipSelected(axis);
  notify();
}

/** Wrap the selection in a group null (Ctrl+G). */
export function groupAction(): void {
  if (state.editorMode !== 'setup' || state.selectedPartIds.length === 0) return;
  const ids = [...state.selectedPartIds];
  // Pivot at the center of the selection's rendered bbox; bones-only selections
  // fall back to the average of their joints.
  const boxes = partRootBoxes(ids);
  let pivot: { x: number; y: number };
  if (boxes.size > 0) {
    const all = [...boxes.values()];
    const x0 = Math.min(...all.map((b) => b.x));
    const y0 = Math.min(...all.map((b) => b.y));
    const x1 = Math.max(...all.map((b) => b.x + b.w));
    const y1 = Math.max(...all.map((b) => b.y + b.h));
    pivot = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  } else {
    const parts = selectedParts();
    pivot = {
      x: parts.reduce((s, p) => s + p.pivot.x, 0) / parts.length,
      y: parts.reduce((s, p) => s + p.pivot.y, 0) / parts.length,
    };
  }
  checkpoint();
  const group = groupParts(ids, pivot);
  if (!group) return;
  registerPart(group);
  reorderCanvas();
  selectPart(group.id);
  notify();
}

/** Dissolve the selected group/bone (Ctrl+Shift+G). */
export function ungroupAction(): void {
  const part = selectedPart();
  if (state.editorMode !== 'setup' || !part || part.paths.length > 0) return;
  checkpoint();
  if (!ungroupPart(part.id)) {
    alert('This null is animated — delete its keyframes first, then ungroup.');
    return;
  }
  unregisterPart(part.id);
  notify();
  renderPose();
}

/** Bind the selected art parts to the selected bones (skinning). */
export function bindAction(): void {
  checkpoint();
  const err = bindSelectedToBones();
  if (err) {
    alert(err);
    return;
  }
  notify();
}

export function buildCanvasTools(el: HTMLElement): void {
  el.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;
  const setup = state.editorMode === 'setup';
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'tool-sep';
    el.appendChild(s);
  };

  // Tool switcher (both modes): select / translate / rotate / IK, keys V T R I.
  const tools = document.createElement('div');
  tools.className = 'tool-switch';
  const toolDefs: [typeof state.tool, keyof typeof ICON_PATHS, string][] = [
    ['select', 'select', 'Select (V) — Setup drags move, Animate drags rotate'],
    ['translate', 'translate', 'Translate (T) — drag the X/Y arrows or the part'],
    ['rotate', 'rotate', 'Rotate (R) — drag the ring or the part'],
    ['ik', 'ik', 'IK (I) — drag a limb end; its parent joints solve to follow'],
  ];
  for (const [tool, ic, title] of toolDefs) {
    const b = document.createElement('button');
    b.appendChild(icon(ic));
    b.title = title;
    if (state.tool === tool) b.classList.add('active');
    b.onclick = () => {
      state.tool = tool;
      notify();
      renderPose();
    };
    tools.appendChild(b);
  }
  el.appendChild(tools);
  sep();

  if (setup) {
    const anyArt = selectedParts().some((p) => p.paths.length > 0);
    const part = selectedPart();
    const add = (b: HTMLButtonElement, enabled: boolean) => {
      b.disabled = !enabled;
      el.appendChild(b);
      return b;
    };

    add(iconButton('flipH', '', 'Flip the selection horizontally, in place (Shift+H)',
      () => flipAction('h')), anyArt);
    add(iconButton('flipV', '', 'Flip the selection vertically, in place (Shift+V)',
      () => flipAction('v')), anyArt);
    sep();
    add(iconButton('group', 'group', 'Wrap the selection in a group (Ctrl+G)', groupAction),
      state.selectedPartIds.length > 0);
    add(iconButton('ungroup', '', 'Dissolve the selected group/bone (Ctrl+Shift+G)', ungroupAction),
      !!part && part.paths.length === 0);
    sep();
    const boneBtn = add(iconButton('bone', 'bone',
      'Press on the canvas to place the joint, drag to the bone tip, release. Escape cancels.',
      () => {
        startBonePlacement();
        boneBtn.classList.add('armed');
      }), true);
    const arts = selectedParts().filter((p) => p.paths.length > 0);
    const bones = selectedParts().filter((p) => p.kind === 'bone');
    add(iconButton('bind', 'bind', 'Skin the selected art to the selected bones (auto weights)',
      bindAction), arts.length > 0 && bones.length > 0);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = part
      ? 'Drag moves · click again for scale/rotate handles · double-click enters'
      : 'Click selects · Shift adds · scroll zooms · middle-drag pans';
    el.appendChild(hint);
  } else {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Animate — drags key at the playhead. IK tool bends parent chains.';
    el.appendChild(hint);
  }
}

// ---- Layers tree ----

/** Parts whose folders are open. Persists across re-renders within a session. */
const expanded = new Set<string>();

export function buildLayersPanel(el: HTMLElement): void {
  el.innerHTML = '<h2>Layers</h2>';
  const doc = state.doc;
  if (!doc) return;

  // Never hide the selection inside a collapsed branch (e.g. a freshly placed bone).
  const selected = selectedPart();
  if (selected) {
    for (const ancestor of ancestorChain(selected)) expanded.add(ancestor.id);
  }

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

  if (part.kind !== 'art' || part.skin) {
    const kindIcon = document.createElement('span');
    kindIcon.className = `layer-kind ${part.skin ? 'skin' : part.kind}`;
    kindIcon.textContent = part.skin ? '≋' : part.kind === 'bone' ? '◆' : '▣';
    kindIcon.title = part.skin ? 'skinned to bones' : part.kind;
    row.appendChild(kindIcon);
  }

  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = part.label;
  row.appendChild(name);

  const count = document.createElement('span');
  count.className = 'layer-count';
  count.textContent = children.length > 0 ? `${part.paths.length}+${children.length}` : `${part.paths.length}`;
  row.appendChild(count);

  row.onclick = (ev) => {
    // Ctrl toggles membership in the multi-selection; Shift adds; plain replaces.
    if (ev.ctrlKey && state.selectedPartIds.includes(part.id)) {
      state.selectedPartIds = state.selectedPartIds.filter((id) => id !== part.id);
      if (state.selectedPartId === part.id) {
        state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1] ?? null;
      }
    } else {
      selectPart(part.id, ev.shiftKey || ev.ctrlKey);
      // Picking a part in the tree opens its groups so canvas drags hit IT, not them.
      enterGroupsFor(part.id);
    }
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
      el.appendChild(numberField('skew x (deg)', part.rest.kx, (v) => {
        checkpoint();
        part.rest.kx = Math.min(85, Math.max(-85, v));
        poseEdited();
      }, 0.5));
      el.appendChild(numberField('skew y (deg)', part.rest.ky, (v) => {
        checkpoint();
        part.rest.ky = Math.min(85, Math.max(-85, v));
        poseEdited();
      }, 0.5));
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

    if (part.skin) buildSkinSection(el, part);
    if (setup) buildPathSection(el);
    if (setup && state.mode === 'nodes') buildNodeOpsSection(el);
    if (setup && state.mode === 'rig') buildAlignSection(el);

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

// ---- Skinning ----

function buildSkinSection(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const title = document.createElement('h3');
  title.textContent = 'Skinning';
  el.appendChild(title);

  const list = document.createElement('p');
  list.className = 'hint';
  const names = (part.skin?.bones ?? [])
    .map((b) => doc.parts.find((p) => p.id === b.id)?.label ?? '(deleted bone)')
    .join(', ');
  list.textContent = `Deformed by: ${names}. Pose the bones — the artwork follows with ` +
    'auto weights. Exports render skinned parts rigidly (editor/runtime feature).';
  el.appendChild(list);

  const unbind = document.createElement('button');
  unbind.textContent = 'unbind (back to rigid)';
  unbind.onclick = () => {
    checkpoint();
    unbindSelectedSkin();
    notify();
  };
  el.appendChild(unbind);
}

// ---- Align & distribute ----

let alignReference: AlignReference = 'selection';

function buildAlignSection(el: HTMLElement): void {
  const doc = state.doc!;
  const ids = state.selectedPartIds;
  if (ids.length < 1) return;

  const title = document.createElement('h3');
  title.textContent = 'Align & distribute';
  el.appendChild(title);

  const refRow = document.createElement('label');
  refRow.className = 'field';
  const refSpan = document.createElement('span');
  refSpan.textContent = 'relative to';
  const refSel = document.createElement('select');
  for (const [value, label] of [
    ['selection', 'selection bounds'],
    ['first', 'first selected'],
    ['last', 'last selected'],
    ['canvas', 'canvas'],
  ] as [AlignReference, string][]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (alignReference === value) opt.selected = true;
    refSel.appendChild(opt);
  }
  refSel.onchange = () => {
    alignReference = refSel.value as AlignReference;
  };
  refRow.appendChild(refSpan);
  refRow.appendChild(refSel);
  el.appendChild(refRow);

  const apply = (edge: AlignEdge) => {
    const boxes = partRootBoxes(ids);
    const deltas = alignDeltas(ids, boxes, edge, alignReference, doc.viewBox);
    if ([...deltas.values()].every((d) => d.dx === 0 && d.dy === 0)) return;
    checkpoint();
    applyRootDeltas(deltas);
    notify();
  };
  const distribute = (mode: 'horizontal' | 'vertical') => {
    const boxes = partRootBoxes(ids);
    const deltas = distributeDeltas(ids, boxes, mode);
    if ([...deltas.values()].every((d) => d.dx === 0 && d.dy === 0)) return;
    checkpoint();
    applyRootDeltas(deltas);
    notify();
  };

  const grid = document.createElement('div');
  grid.className = 'align-grid';
  const alignBtn = (ic: keyof typeof ICON_PATHS, title: string, edge: AlignEdge) => {
    grid.appendChild(iconButton(ic, '', title, () => apply(edge)));
  };
  alignBtn('alignL', 'Align left edges', 'left');
  alignBtn('alignCH', 'Center horizontally', 'centerH');
  alignBtn('alignR', 'Align right edges', 'right');
  alignBtn('alignT', 'Align top edges', 'top');
  alignBtn('alignM', 'Center vertically', 'middleV');
  alignBtn('alignB', 'Align bottom edges', 'bottom');
  el.appendChild(grid);

  const dist = document.createElement('div');
  dist.className = 'align-grid';
  const distBtn = (ic: keyof typeof ICON_PATHS, title: string, mode: 'horizontal' | 'vertical') => {
    const b = iconButton(ic, 'gaps', title, () => distribute(mode));
    b.disabled = ids.length < 3;
    dist.appendChild(b);
  };
  distBtn('distH', 'Equalize horizontal gaps (needs 3+)', 'horizontal');
  distBtn('distV', 'Equalize vertical gaps (needs 3+)', 'vertical');
  el.appendChild(dist);
}

// ---- Node operations (node-editing mode) ----

function buildNodeOpsSection(el: HTMLElement): void {
  const title = document.createElement('h3');
  const count = selectedNodeCount();
  const typeChar = primaryNodeType();
  const typeName =
    typeChar === 's' ? 'smooth' : typeChar === 'z' ? 'symmetric' : typeChar === 'c' ? 'corner' : 'untyped';
  title.textContent =
    count > 1 ? `Selected nodes (${count})` : count === 1 ? `Selected node — ${typeName}` : 'Nodes';
  el.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'align-grid';
  const enabled = hasSelectedNode();
  const op = (text: string, title: string, nodeOp: NodeOp) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.disabled = !enabled;
    b.onclick = () => {
      checkpoint();
      applyNodeOp(nodeOp);
    };
    grid.appendChild(b);
  };
  op('smooth', 'Align both handles through the node, keeping their lengths', 'smooth');
  op('symmetric', 'Align both handles and equalize their lengths', 'symmetric');
  op('corner', 'Retract both handles (sharp corner)', 'retract');
  op('→ curve', 'Turn the segment after this node into a curve', 'toCurve');
  op('→ line', 'Turn the segment after this node into a straight line', 'toLine');
  el.appendChild(grid);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = enabled
    ? 'Ops set the node type persistently. Smooth/symmetric nodes mirror their ' +
      'handles while dragging (Alt breaks). Shift+click or rubber-band adds nodes; ' +
      'drag moves them all; Delete removes; arrows nudge.'
    : 'Click a node to select it — Shift adds, drag empty space rubber-band-selects.';
  el.appendChild(hint);
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

  const rigLabel = document.createElement('label');
  rigLabel.className = 'field';
  const rigToggle = document.createElement('input');
  rigToggle.type = 'checkbox';
  rigToggle.checked = localStorage.getItem('rig-studio-allow-rig-edits') === '1';
  rigToggle.onchange = () =>
    localStorage.setItem('rig-studio-allow-rig-edits', rigToggle.checked ? '1' : '0');
  const rigSpan = document.createElement('span');
  rigSpan.textContent = 'allow rig changes (bones / parenting / pivots)';
  rigLabel.appendChild(rigSpan);
  rigLabel.appendChild(rigToggle);
  box.appendChild(rigLabel);

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
      const result = await animateWithClaude(
        ctx.apiKey, ctx.doc, clip, promptBox.value.trim(), image, rigToggle.checked,
      );
      checkpoint(); // one undo step reverts the whole AI edit — rig changes included
      let labelToId = new Map(ctx.doc.parts.map((p) => [p.label, p.id]));
      let structural = '';
      if (result.rig) {
        labelToId = applyRigChanges(result.rig);
        ctx.doc.parts.forEach(registerPart); // canvas groups for any new bones
        const added = result.rig.addBones?.length ?? 0;
        if (added > 0) structural = ` (+${added} bone${added === 1 ? '' : 's'})`;
      }
      // Resolve track targets (labels → ids) against the possibly-extended rig.
      const tracks: Track[] = [];
      for (const t of result.clip.tracks) {
        const target = t.target === 'root' ? 'root' : labelToId.get(t.target);
        if (!target) continue;
        tracks.push({ target, channel: t.channel as Channel, keyframes: t.keyframes });
      }
      clip.duration = result.clip.duration;
      clip.tracks = tracks;
      state.editorMode = 'animate';
      state.currentTime = 0;
      state.playing = true;
      status.textContent = `Done — playing the result${structural}.`;
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
