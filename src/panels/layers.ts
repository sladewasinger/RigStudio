/**
 * Layers panel: a folder-style tree — parts nest under their parent part (bone
 * hierarchy) and each part folds open to show the SVG objects (paths) inside it. Drag
 * a part onto another to parent it; drop it on the "un-parent" strip to detach.
 * Double-click renames (names carry through into exported files).
 */

import {
  state, notify, selectedPart, selectPart, setParent, movePartRelativeTo,
  ancestorChain, RigPart,
} from '../core/model';
import { renderPose, reorderCanvas, enterGroupsFor } from '../view';
import { checkpoint } from '../core/history';
import { dialog } from '../ui/dialogs';
import { showContextMenu } from '../ui/contextMenu';
import { buildPartContextMenu } from '../ui/actions';

// ---- Layers tree ----

/** Parts whose folders are open. Persists across re-renders within a session. */
const expanded = new Set<string>();

/**
 * The part ids in the order their rows render in the tree (depth-first, top part first,
 * children only under expanded folders) — the "visible row order" a Shift+range select
 * spans. Mirrors buildLayersPanel / partNode's traversal exactly (reverse doc order,
 * `!parentId` roots), so a range never includes a collapsed part.
 */
function visiblePartOrder(): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const out: string[] = [];
  const walk = (parts: RigPart[]): void => {
    for (const p of parts) {
      out.push(p.id);
      if (expanded.has(p.id)) {
        walk([...doc.parts].reverse().filter((c) => c.parentId === p.id));
      }
    }
  };
  walk([...doc.parts].reverse().filter((p) => !p.parentId));
  return out;
}

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
    // Shift = RANGE select between the anchor (current primary) and this row, in visible
    // (flattened, expanded-only) row order; Ctrl = toggle one row's membership; plain =
    // replace. The anchor stays put so chained Shift+clicks re-range from the same row.
    if (ev.shiftKey && state.selectedPartId) {
      const order = visiblePartOrder();
      const ai = order.indexOf(state.selectedPartId);
      const bi = order.indexOf(part.id);
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        state.selectedPartIds = order.slice(lo, hi + 1);
        state.selectedPathId = null;
      } else {
        selectPart(part.id);
        enterGroupsFor(part.id);
      }
    } else if (ev.ctrlKey && state.selectedPartIds.includes(part.id)) {
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
  row.ondblclick = (ev) => {
    ev.stopPropagation();
    beginInlineRename(row, name, part);
  };
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (!state.selectedPartIds.includes(part.id)) {
      selectPart(part.id);
      enterGroupsFor(part.id);
      notify();
      renderPose();
    } else {
      state.selectedPartId = part.id;
    }
    showContextMenu(buildPartContextMenu(part), ev.clientX, ev.clientY);
  });

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
      pathRow.ondblclick = (ev) => {
        ev.stopPropagation();
        beginInlineRename(pathRow, pathName, path);
      };
      pathLi.appendChild(pathRow);
      kids.appendChild(pathLi);
    }
    li.appendChild(kids);
  }
  return li;
}

/**
 * Swap `labelEl` for a text input in place (VS Code-style inline rename): select-all on
 * open, Enter commits with a checkpoint, Escape cancels, blur commits. A no-op rename
 * (empty or unchanged) just reverts the DOM without touching history.
 */
function beginInlineRename(row: HTMLElement, labelEl: HTMLElement, target: { label: string }): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'layer-rename-input';
  input.value = target.label;
  row.replaceChild(input, labelEl);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    input.removeEventListener('blur', commit);
    const val = input.value.trim().replace(/\s+/g, '_');
    if (val && val !== target.label) {
      checkpoint();
      target.label = val;
      notify(); // full rebuild replaces `row`; no need to restore labelEl ourselves
    } else if (input.isConnected) {
      row.replaceChild(labelEl, input);
    }
  };
  const cancel = () => {
    if (done) return;
    done = true;
    input.removeEventListener('blur', commit);
    row.replaceChild(labelEl, input);
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // don't let '%'/tool-key/etc. shortcuts fire while typing
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
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
      void dialog.alert('Cannot parent a part to its own descendant.');
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
      void dialog.alert('That drop would create a parenting cycle.');
      return;
    }
    if (zone === 'into') expanded.add(part.id);
    reorderCanvas();
    notify();
  });
}
