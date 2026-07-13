// ---- Node operations (node-editing mode) ----
import { state, notify, selectedPart, RigPart, chainBonesOfPart } from '../../core/model';
import {
  hasSelectedNode, applyNodeOp, NodeOp, selectedNodeCount, primaryNodeType,
  selectedNodesType, canJoinNodes, canDeleteSegment, joinSelectedNodes, deleteSelectedSegment,
  bindSelectedNodesToBone,
} from '../../view';
import { checkpoint } from '../../core/history';
import { dialog } from '../../ui/dialogs';

/**
 * "bind to bone…" (v2.13 follow-up — replaces the old top-bar whole-part bind button):
 * a bone tip/origin can never be co-selected alongside path nodes (node mode's canvas
 * click-routing claims every press for bend/marquee before a part selection could land
 * — `view/interactions.ts`), so this always opens the picker dialog rather than trying
 * a "fast path" that can't actually occur. Lists the part's OWN chain bones (hierarchy-
 * as-assignment — see `chainBonesOfPart`) with a tip/origin choice; binds the part first
 * if it isn't already skinned (the whole-part bind stays available programmatically,
 * just not from a button), then pins the selected nodes via `bindSelectedNodesToBone`
 * (`view/rigOps.ts`), which maps the pick onto the existing {a,b,t} override model.
 */
async function openBindToBoneDialog(part: RigPart, chainBones: RigPart[]): Promise<void> {
  const result = await dialog.form('Bind to bone', [
    {
      name: 'bone', label: 'chain bone', type: 'select',
      options: chainBones.map((b) => ({ value: b.id, label: b.label })),
      value: chainBones[0].id,
    },
    {
      name: 'end', label: 'at its', type: 'select',
      options: [
        { value: 'tip', label: 'tip (toward its child)' },
        { value: 'origin', label: 'origin (toward its parent)' },
      ],
      value: 'tip',
    },
  ], { okText: 'Bind' });
  if (!result) return;
  const end = result.end === 'origin' ? 'origin' : 'tip';
  checkpoint();
  if (!bindSelectedNodesToBone(part, String(result.bone), end)) return;
  notify();
}

export function buildNodeOpsSection(el: HTMLElement): void {
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
  // CLAUDE.md item 4: subtly highlight the button matching the WHOLE selection's
  // current type (mixed/untyped selections highlight nothing) — `selectedNodesType()`
  // already returns null for exactly that case, matching `OP_FLAG` in typeOps.ts.
  const sharedType = selectedNodesType();
  const TYPE_FLAG: Partial<Record<NodeOp, string>> = { smooth: 's', symmetric: 'z', retract: 'c' };
  const op = (text: string, title: string, nodeOp: NodeOp) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.disabled = !enabled;
    if (sharedType && TYPE_FLAG[nodeOp] === sharedType) b.classList.add('node-type-active');
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

  // "bind to bone…" (v2.13): only offered when this part actually has a bone chain of
  // its own (hierarchy-as-assignment — placing a chain under a part IS the assignment).
  const part = selectedPart();
  const chainBones = part ? chainBonesOfPart(state.doc?.parts ?? [], part) : [];
  if (part && chainBones.length > 0) {
    const bindGrid = document.createElement('div');
    bindGrid.className = 'align-grid';
    const bindBtn = document.createElement('button');
    bindBtn.textContent = 'bind to bone…';
    bindBtn.title = enabled
      ? "Pin the selected nodes to one of this part's chain bones"
      : 'Select path nodes first';
    bindBtn.disabled = !enabled;
    bindBtn.onclick = () => { void openBindToBoneDialog(part, chainBones); };
    bindGrid.appendChild(bindBtn);
    el.appendChild(bindGrid);
  }

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = enabled
    ? 'Ops set the node type persistently. Smooth/symmetric nodes mirror their ' +
      'handles while dragging (Alt breaks). Shift+click or rubber-band adds nodes; ' +
      'drag moves them all; Delete removes; arrows nudge.'
    : 'Click a node to select it — Shift adds, drag empty space rubber-band-selects.';
  el.appendChild(hint);
}
