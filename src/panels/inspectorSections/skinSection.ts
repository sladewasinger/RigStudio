// ---- Skinning ----
import { state, notify, RigPart } from '../../core/model';
import {
  unbindSelectedSkin, selectedNodeCount, setNodeBinding, clearNodeBinding,
  recomputeAutoWeights, primaryNodeBinding,
} from '../../view';
import { checkpoint } from '../../core/history';

export function buildSkinSection(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const bones = (part.skin?.bones ?? [])
    .map((b) => doc.parts.find((p) => p.id === b.id))
    .filter((p): p is RigPart => !!p);

  const title = document.createElement('h3');
  title.textContent = 'Bones & binding';
  el.appendChild(title);

  const list = document.createElement('p');
  list.className = 'hint';
  const names = bones.length ? bones.map((b) => b.label).join(', ') : '(deleted bones)';
  list.textContent = `Deformed by: ${names}. This part has no scale/rotate ` +
    'handles; pose its bones (or drag it with the IK tool to bend the chain) and the ' +
    'artwork follows with auto weights. Exports render bound parts rigidly.';
  el.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'align-grid';
  const unbind = document.createElement('button');
  unbind.textContent = 'unbind';
  unbind.title = 'Remove the binding — the part turns rigid again';
  unbind.onclick = () => {
    checkpoint();
    unbindSelectedSkin();
    notify();
  };
  actions.appendChild(unbind);

  const recompute = document.createElement('button');
  recompute.textContent = 'recompute auto weights';
  recompute.title = 'Rebuild auto weights from the current bones (clears any per-node overrides)';
  recompute.disabled = !part.skin; // enabled whenever the part is skinned
  recompute.onclick = () => {
    // Only spend an undo step when overrides actually get dropped; a pure recompute
    // (no overrides) rebuilds the runtime weight cache without mutating the doc.
    const hadOverrides = !!part.skin?.overrides;
    if (hadOverrides) checkpoint();
    recomputeAutoWeights();
    notify();
  };
  actions.appendChild(recompute);
  el.appendChild(actions);

  // Per-node binding editor — only in node editing, where nodes can be selected.
  if (state.editorMode === 'setup' && state.mode === 'nodes') {
    buildNodeBindingEditor(el, part, bones);
  }
}

/**
 * Manual refinement (Bones 2.0): bind the selected path nodes to a bone, with an
 * origin↔tip % slider that blends bone `a` (1−t) with bone `b` (t). `b` auto-populates
 * with the bone whose origin meets a's tip (a's child bone), so the slider walks the
 * weight across that joint. Applies to every selected node under one checkpoint.
 */
function buildNodeBindingEditor(el: HTMLElement, part: RigPart, bones: RigPart[]): void {
  const title = document.createElement('h3');
  title.textContent = 'Node binding';
  el.appendChild(title);

  if (bones.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'This part is bound to no resolvable bones.';
    el.appendChild(hint);
    return;
  }

  const count = selectedNodeCount();
  if (count === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Select path nodes (click / rubber-band), then pin their weight ' +
      'to a bone here. Structural node edits drop a path’s overrides.';
    el.appendChild(hint);
    return;
  }

  const cur = primaryNodeBinding();
  // The child bone whose origin meets a bone's tip — the natural "next joint" for the
  // origin↔tip blend.
  const childOf = (aId: string): RigPart | null =>
    bones.find((b) => b.parentId === aId) ?? null;

  let aId = cur?.override?.a ?? bones[0].id;
  if (!bones.some((b) => b.id === aId)) aId = bones[0].id;
  let bId: string | null = cur?.override?.b ?? childOf(aId)?.id ?? null;
  let t = cur?.override ? cur.override.t : 1;

  // Current-binding readout when a single node is selected.
  if (count === 1) {
    const info = document.createElement('p');
    info.className = 'hint';
    if (cur?.override) {
      const la = bones.find((b) => b.id === cur.override!.a)?.label ?? '?';
      const lb = cur.override.b ? bones.find((b) => b.id === cur.override!.b)?.label ?? '?' : null;
      info.textContent = lb
        ? `Node override: ${la} ${Math.round((1 - cur.override.t) * 100)}% / ${lb} ${Math.round(cur.override.t * 100)}%.`
        : `Node override: 100% ${la}.`;
    } else {
      info.textContent = 'Node uses auto weights.';
    }
    el.appendChild(info);
  } else {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `${count} nodes selected.`;
    el.appendChild(info);
  }

  const boneSelect = (
    label: string, value: string | null, includeNone: boolean,
  ): { row: HTMLElement; sel: HTMLSelectElement } => {
    const row = document.createElement('label');
    row.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    const sel = document.createElement('select');
    if (includeNone) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(none)';
      if (value === null) none.selected = true;
      sel.appendChild(none);
    }
    for (const b of bones) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.label;
      if (b.id === value) opt.selected = true;
      sel.appendChild(opt);
    }
    row.appendChild(span);
    row.appendChild(sel);
    return { row, sel };
  };

  const aCtrl = boneSelect('origin bone (a)', aId, false);
  const bCtrl = boneSelect('tip bone (b)', bId, true);

  // t readout + slider (origin a ↔ tip b).
  const tRow = document.createElement('label');
  tRow.className = 'field';
  const tSpan = document.createElement('span');
  const tLabel = () => `tip weight ${Math.round(t * 100)}%`;
  tSpan.textContent = tLabel();
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(Math.round(t * 100));
  slider.disabled = bId === null;
  slider.oninput = () => {
    t = Number(slider.value) / 100;
    tSpan.textContent = tLabel();
  };
  tRow.appendChild(tSpan);
  tRow.appendChild(slider);

  aCtrl.sel.onchange = () => {
    aId = aCtrl.sel.value || bones[0].id;
    // Re-point b at the new a's child joint (in place — no full rebuild that would drop
    // the just-picked value).
    bId = childOf(aId)?.id ?? null;
    bCtrl.sel.value = bId ?? '';
    slider.disabled = bId === null;
  };
  bCtrl.sel.onchange = () => {
    bId = bCtrl.sel.value || null;
    slider.disabled = bId === null;
  };
  el.appendChild(aCtrl.row);
  el.appendChild(bCtrl.row);
  el.appendChild(tRow);

  const grid = document.createElement('div');
  grid.className = 'align-grid';
  const apply = document.createElement('button');
  apply.textContent = 'apply to selected nodes';
  apply.onclick = () => {
    checkpoint();
    if (!setNodeBinding(aId, bId, t)) return;
    notify();
  };
  grid.appendChild(apply);
  const clear = document.createElement('button');
  clear.textContent = 'clear override';
  clear.onclick = () => {
    checkpoint();
    if (!clearNodeBinding()) return;
    notify();
  };
  grid.appendChild(clear);
  el.appendChild(grid);
}
