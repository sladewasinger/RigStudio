/**
 * Inspector: numeric fields for the selection. In Setup mode these edit the REST pose,
 * pivots, and parenting; in Animate mode they write keyframes at the playhead. Also
 * hosts the skinning summary, align & distribute, node-editing ops, and object
 * (fill/stroke) sections, and mounts the Claude assistant panel at the bottom.
 */
import { state, notify, selectedPart } from '../../core/model';
import { renderPose } from '../../view';
import { buildBoneRestSection } from './boneSection';
import { buildPartTransformFields, buildRootSection } from './transformSection';
import { buildStackingRow } from './stackingSection';
import { buildSkinSection } from './skinSection';
import { buildAlignSection } from './alignSection';
import { buildNodeOpsSection } from './nodeOpsSection';
import { buildPathSection, buildArtboardSection } from './objectSection';
import { buildAiPanel } from '../ai';
import { buildEmptyState } from '../../ui/emptyState';

// ---- Inspector ----

export function buildInspector(el: HTMLElement): void {
  el.innerHTML = '<h2>Inspector</h2>';
  const doc = state.doc;
  if (!doc) {
    buildEmptyState(el, 'Nothing to inspect yet — open an SVG or a saved project first.');
    return;
  }
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

    if (setup && part.kind === 'bone') {
      // Bone position model: a chain's ROOT has a position (+ rotation + length); a CHILD
      // bone is rotation + length only, its origin riding the parent tip. No raw pivot/
      // rest-translate fields — those would let the shared joint drift independently.
      buildBoneRestSection(el, part);
    } else {
      buildPartTransformFields(el, part, setup);
    }

    if (setup) buildStackingRow(el, part);
    if (part.skin) buildSkinSection(el, part);
    if (setup) buildPathSection(el);
    if (setup && state.mode === 'nodes') buildNodeOpsSection(el);
    if (setup && state.mode === 'rig') buildAlignSection(el);

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent = setup
      ? state.mode === 'rig'
        ? 'Edit: drags reshape the character (never keyed). Drag crosshair = set joint. Shift+drag = move.'
        : 'Drag nodes to reshape. Alt+click a segment = insert a node there. Ctrl+click a node = delete.'
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

  buildRootSection(el, doc, setup);

  buildAiPanel(el);
}
