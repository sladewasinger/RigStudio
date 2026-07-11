/**
 * Inspector: numeric fields for the selection. In Setup mode these edit the REST pose,
 * pivots, and parenting; in Animate mode they write keyframes at the playhead. Also
 * hosts the skinning summary, align & distribute, node-editing ops, and object
 * (fill/stroke) sections, and mounts the Claude assistant panel at the bottom.
 */

import {
  state, notify, selectedPart, selectedPath, sampleChannel, channelValue,
  setKeyframe, isAncestorOf, setParent, RigPart, Channel, ensureArtboard,
  keyAt, removeKeyAt,
} from '../core/model';
import {
  renderPose, updatePathAttrs, partRootBoxes, applyRootDeltas, hasSelectedNode,
  applyNodeOp, NodeOp, unbindSelectedSkin, selectedNodeCount, primaryNodeType,
  canJoinNodes, canDeleteSegment, joinSelectedNodes, deleteSelectedSegment,
  setNodeBinding, clearNodeBinding, resetNodeBindings, primaryNodeBinding,
} from '../view';
import { alignDeltas, distributeDeltas, AlignEdge, AlignReference } from '../geometry/align';
import { checkpoint } from '../core/history';
import { iconButton, ICON_PATHS } from './icons';
import { buildAiPanel } from './ai';

/** Repaint the canvas and keyframe lanes after an inspector edit. */
function poseEdited(): void {
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
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
      // Each field gets a keyframe-toggle circle (filled = keyed at the playhead).
      const t = state.currentTime;
      el.appendChild(keyableField(
        'rotate (deg)', part.id, 'rotate', () => channelValue(part, 'rotate', t), (v) => {
          checkpoint();
          setKeyframe(part.id, 'rotate', v);
          poseEdited();
        },
      ));
      el.appendChild(keyableField(
        'translate x', part.id, 'tx', () => channelValue(part, 'tx', t), (v) => {
          checkpoint();
          setKeyframe(part.id, 'tx', v);
          poseEdited();
        },
      ));
      el.appendChild(keyableField(
        'translate y', part.id, 'ty', () => channelValue(part, 'ty', t), (v) => {
          checkpoint();
          setKeyframe(part.id, 'ty', v);
          poseEdited();
        },
      ));
    }

    if (part.skin) buildSkinSection(el, part);
    if (setup) buildPathSection(el);
    if (setup && state.mode === 'nodes') buildNodeOpsSection(el);
    if (setup && state.mode === 'rig') buildAlignSection(el);

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent = setup
      ? state.mode === 'rig'
        ? 'Edit: drags reshape the character (never keyed). Drag crosshair = set joint. Shift+drag = move.'
        : 'Drag nodes to reshape. Alt+click a node = insert one after it. Ctrl+click = delete.'
      : 'Animate: drags record keyframes at the playhead. Ctrl = 15° snap. Shift+drag = move.';
    el.appendChild(help);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Select a part on the canvas or in Layers. Shift+click selects several.';
    el.appendChild(p);

    // Document properties spot: nothing selected, Edit mode.
    if (setup) buildArtboardSection(el);
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
    el.appendChild(keyableField(
      'jump y', 'root', 'ty', () => sampleChannel('root', 'ty', t), (v) => {
        checkpoint();
        setKeyframe('root', 'ty', v);
        poseEdited();
      },
    ));
    el.appendChild(keyableField(
      'scale x', 'root', 'sx', () => sampleChannel('root', 'sx', t), (v) => {
        checkpoint();
        setKeyframe('root', 'sx', v);
        poseEdited();
      }, 0.01,
    ));
    el.appendChild(keyableField(
      'scale y', 'root', 'sy', () => sampleChannel('root', 'sy', t), (v) => {
        checkpoint();
        setKeyframe('root', 'sy', v);
        poseEdited();
      }, 0.01,
    ));
  }

  buildAiPanel(el);
}

// ---- Artboard (page frame) ----

/** Document-properties spot: shown in Edit mode with nothing selected. */
function buildArtboardSection(el: HTMLElement): void {
  const doc = state.doc!;
  // ensureArtboard seeds a disabled default from viewBox for docs that never went
  // through normalizeDoc (a fresh SVG import); it's a structural default, not a user
  // edit, so no checkpoint here.
  const ab = ensureArtboard(doc);

  const title = document.createElement('h3');
  title.textContent = 'Artboard';
  el.appendChild(title);

  const enabledRow = document.createElement('label');
  enabledRow.className = 'field';
  const enabledSpan = document.createElement('span');
  enabledSpan.textContent = 'enabled';
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  // The global `input, select, textarea { width: 100% }` rule (style.css) otherwise
  // stretches a bare checkbox into a full-width box; other checkboxes in this panel
  // sidestep it via a wrapping class (.color-wrap, .ai-panel) — inline style here
  // since this one isn't in either wrapper.
  enabledInput.style.width = 'auto';
  enabledInput.checked = ab.enabled;
  enabledInput.onchange = () => {
    checkpoint();
    ab.enabled = enabledInput.checked;
    renderPose();
  };
  enabledRow.appendChild(enabledSpan);
  enabledRow.appendChild(enabledInput);
  el.appendChild(enabledRow);

  el.appendChild(numberField('x', ab.x, (v) => {
    checkpoint();
    ab.x = v;
    renderPose();
  }));
  el.appendChild(numberField('y', ab.y, (v) => {
    checkpoint();
    ab.y = v;
    renderPose();
  }));
  el.appendChild(numberField('width', ab.w, (v) => {
    checkpoint();
    ab.w = Math.max(1, v);
    renderPose();
  }));
  el.appendChild(numberField('height', ab.h, (v) => {
    checkpoint();
    ab.h = Math.max(1, v);
    renderPose();
  }));

  const grid = document.createElement('div');
  grid.className = 'align-grid';

  const fromArtwork = document.createElement('button');
  fromArtwork.textContent = 'from artwork';
  fromArtwork.title = 'Fit the artboard to the union bounding box of all artwork';
  fromArtwork.onclick = () => {
    const ids = doc.parts.map((p) => p.id);
    const boxes = partRootBoxes(ids);
    if (boxes.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes.values()) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    checkpoint();
    ab.x = minX;
    ab.y = minY;
    ab.w = Math.max(1, maxX - minX);
    ab.h = Math.max(1, maxY - minY);
    renderPose();
    notify();
  };
  grid.appendChild(fromArtwork);

  const fromViewBox = document.createElement('button');
  fromViewBox.textContent = 'from viewBox';
  fromViewBox.title = 'Reset the artboard to the imported SVG viewBox';
  fromViewBox.onclick = () => {
    checkpoint();
    ab.x = doc.viewBox.x;
    ab.y = doc.viewBox.y;
    ab.w = doc.viewBox.w;
    ab.h = doc.viewBox.h;
    renderPose();
    notify();
  };
  grid.appendChild(fromViewBox);
  el.appendChild(grid);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Optional page frame, drawn behind the artwork. When enabled, ' +
    'exports (Rive/Lottie) use it as their reference frame instead of the viewBox.';
  el.appendChild(hint);
}

// ---- Skinning ----

function buildSkinSection(el: HTMLElement, part: RigPart): void {
  const doc = state.doc!;
  const bones = (part.skin?.bones ?? [])
    .map((b) => doc.parts.find((p) => p.id === b.id))
    .filter((p): p is RigPart => !!p);

  const title = document.createElement('h3');
  title.textContent = 'Skinning';
  el.appendChild(title);

  const list = document.createElement('p');
  list.className = 'hint';
  const names = bones.length ? bones.map((b) => b.label).join(', ') : '(deleted bones)';
  list.textContent = `Deformed by: ${names}. Pose the bones — the artwork follows with ` +
    'auto weights. Exports render skinned parts rigidly (editor/runtime feature).';
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
  recompute.title = 'Clear all per-node overrides and return to pure auto weighting';
  recompute.disabled = !part.skin?.overrides;
  recompute.onclick = () => {
    if (!part.skin?.overrides) return; // guard before checkpoint — no empty undo step
    checkpoint();
    resetNodeBindings();
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

  // Structural ops: break a segment, or weld / bridge two path ends.
  const grid2 = document.createElement('div');
  grid2.className = 'align-grid';
  const joinOk = canJoinNodes();
  const delOk = canDeleteSegment();
  const structBtn = (text: string, title: string, ok: boolean, run: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.disabled = !ok;
    b.onclick = run;
    grid2.appendChild(b);
  };
  structBtn(
    'join',
    joinOk ? 'Weld the two selected end nodes into one' : 'Select 2 end nodes',
    joinOk, () => joinSelectedNodes('weld'),
  );
  structBtn(
    'join seg',
    joinOk ? 'Connect the two selected end nodes with a straight segment' : 'Select 2 end nodes',
    joinOk, () => joinSelectedNodes('segment'),
  );
  structBtn(
    'del seg',
    delOk ? 'Delete the segment between the two selected adjacent nodes' : 'Select 2 adjacent nodes',
    delOk, () => deleteSelectedSegment(),
  );
  el.appendChild(grid2);

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
function keyableField(
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
