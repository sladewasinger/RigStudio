import {
  state, notify, selectedParts, createWarpDefinition, warpPathFingerprint,
  WarpDefinition, WarpPathPair, freshId, setKeyframeAt,
} from '../core/model';
import { checkpoint } from '../core/history';
import { renderPose } from '../view';
import { dialog } from '../ui/dialogs';

let host: HTMLElement | null = null;

export function ensureWarpWorkspace(): HTMLElement {
  if (host?.isConnected) return host;
  host = document.createElement('section');
  host.id = 'warp-workspace';
  host.setAttribute('aria-label', 'Warp Setup');
  document.body.appendChild(host);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.warpSetupId) return;
    state.warpSetupId = null;
    state.warpPreviewAmount = 0;
    notify();
    renderPose();
  });
  return host;
}

export async function createWarpFromSelection(): Promise<void> {
  const doc = state.doc;
  const selection = selectedParts();
  if (!doc || state.editorMode !== 'setup' || selection.length !== 2) return;
  const name = await dialog.prompt('Warp transition name', `${selection[0].label} ↔ ${selection[1].label}`);
  if (!name) return;
  const built = createWarpDefinition(doc, selection[0].id, selection[1].id, name);
  checkpoint();
  doc.warps ??= [];
  doc.warps.push(built.definition);
  state.warpSetupId = built.definition.id;
  state.warpPreviewAmount = 0;
  buildWarpWorkspace();
  notify();
  renderPose();
}

function pathLabel(pair: WarpPathPair, side: 'source' | 'target'): string {
  const partId = side === 'source' ? pair.sourcePartId : pair.targetPartId;
  const pathId = side === 'source' ? pair.sourcePathId : pair.targetPathId;
  const part = state.doc?.parts.find((candidate) => candidate.id === partId);
  const path = part?.paths.find((candidate) => candidate.id === pathId);
  return `${part?.label ?? '?'} / ${path?.label ?? '?'}`;
}

function allPaths(rootId: string): { partId: string; pathId: string; label: string }[] {
  const doc = state.doc!;
  const descendants = new Set<string>();
  const visit = (id: string) => {
    descendants.add(id);
    doc.parts.filter((part) => part.parentId === id).forEach((part) => visit(part.id));
  };
  visit(rootId);
  return doc.parts.filter((part) => descendants.has(part.id)).flatMap((part) =>
    part.paths.map((path) => ({ partId: part.id, pathId: path.id, label: `${part.label} / ${path.label}` })),
  );
}

function rebuild(warp: WarpDefinition): void {
  const built = createWarpDefinition(state.doc!, warp.sourcePartId, warp.targetPartId, warp.name);
  warp.pairs = built.definition.pairs;
}

function pairSelect(warp: WarpDefinition, source: { partId: string; pathId: string; label: string }): HTMLSelectElement {
  const select = document.createElement('select');
  select.innerHTML = '<option value="">Pair with…</option>';
  const used = new Set(warp.pairs.map((pair) => pair.targetPathId));
  for (const target of allPaths(warp.targetPartId).filter((path) => !used.has(path.pathId))) {
    const option = document.createElement('option');
    option.value = `${target.partId}|${target.pathId}`;
    option.textContent = target.label;
    select.appendChild(option);
  }
  select.setAttribute('aria-label', `Pair ${source.label}`);
  select.onchange = () => {
    if (!select.value) return;
    const [targetPartId, targetPathId] = select.value.split('|');
    const sourcePath = state.doc!.parts.find((part) => part.id === source.partId)!.paths.find((path) => path.id === source.pathId)!;
    const targetPath = state.doc!.parts.find((part) => part.id === targetPartId)!.paths.find((path) => path.id === targetPathId)!;
    checkpoint();
    warp.pairs.push({ id: freshId('warp_pair'), sourcePartId: source.partId, sourcePathId: source.pathId,
      targetPartId, targetPathId, sourceFingerprint: warpPathFingerprint(sourcePath), targetFingerprint: warpPathFingerprint(targetPath) });
    notify(); renderPose();
  };
  return select;
}

export function buildWarpWorkspace(): void {
  const panel = ensureWarpWorkspace();
  panel.innerHTML = '';
  const warp = state.doc?.warps?.find((candidate) => candidate.id === state.warpSetupId);
  panel.classList.toggle('open', !!warp);
  if (!warp || !state.doc) return;
  const header = document.createElement('header');
  header.innerHTML = `<div><strong>Warp Setup</strong><span>${warp.name}</span></div>`;
  const close = document.createElement('button'); close.textContent = '×'; close.title = 'Close Warp Setup (Escape)';
  close.onclick = () => { state.warpSetupId = null; state.warpPreviewAmount = 0; notify(); renderPose(); };
  header.appendChild(close); panel.appendChild(header);

  const roles = document.createElement('div'); roles.className = 'warp-roles';
  const source = state.doc.parts.find((part) => part.id === warp.sourcePartId);
  const target = state.doc.parts.find((part) => part.id === warp.targetPartId);
  roles.append(`Carrier: ${source?.label ?? '?'}  →  Reference: ${target?.label ?? '?'}`);
  const swap = document.createElement('button'); swap.textContent = '⇄ Swap';
  swap.onclick = () => { checkpoint(); [warp.sourcePartId, warp.targetPartId] = [warp.targetPartId, warp.sourcePartId]; rebuild(warp); notify(); renderPose(); };
  roles.appendChild(swap); panel.appendChild(roles);

  const preview = document.createElement('label'); preview.className = 'warp-preview';
  const previewName = document.createElement('span'); previewName.textContent = 'Preview';
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(state.warpPreviewAmount * 100);
  slider.setAttribute('aria-label', 'Warp preview percent');
  const output = document.createElement('output'); output.textContent = `${Math.round(state.warpPreviewAmount * 100)}%`;
  slider.oninput = () => { state.warpPreviewAmount = Number(slider.value) / 100; output.textContent = `${slider.value}%`; renderPose(); };
  preview.append(previewName, slider, output); panel.appendChild(preview);

  const heading = document.createElement('div'); heading.className = 'warp-section-title';
  heading.innerHTML = `<strong>Correspondence</strong><span>${warp.pairs.length} confirmed</span>`;
  const rebuildButton = document.createElement('button'); rebuildButton.textContent = 'Rebuild auto';
  rebuildButton.onclick = async () => { if (warp.pairs.length && !await dialog.confirm('Replace confirmed pairs with safe exact-name matches?')) return; checkpoint(); rebuild(warp); notify(); renderPose(); };
  heading.appendChild(rebuildButton); panel.appendChild(heading);

  const list = document.createElement('div'); list.className = 'warp-pairs';
  for (const pair of warp.pairs) {
    const row = document.createElement('div'); row.className = 'warp-pair'; row.tabIndex = 0;
    row.innerHTML = `<span>${pathLabel(pair, 'source')}</span><b>→</b><span>${pathLabel(pair, 'target')}</span><small>Exact name · confirmed</small>`;
    const actions = document.createElement('div');
    const reverse = document.createElement('button'); reverse.textContent = pair.reverse ? 'Direction reversed' : 'Reverse path';
    reverse.onclick = () => { checkpoint(); pair.reverse = !pair.reverse; notify(); renderPose(); };
    const seam = document.createElement('button'); seam.textContent = `Move seam (${pair.seam ?? 0})`;
    seam.onclick = () => { checkpoint(); pair.seam = (pair.seam ?? 0) + 1; notify(); renderPose(); };
    const unpair = document.createElement('button'); unpair.textContent = 'Unpair';
    unpair.onclick = () => { checkpoint(); warp.pairs = warp.pairs.filter((candidate) => candidate.id !== pair.id); notify(); renderPose(); };
    actions.append(reverse, seam, unpair); row.appendChild(actions); list.appendChild(row);
  }
  const pairedSources = new Set(warp.pairs.map((pair) => pair.sourcePathId));
  for (const unmatched of allPaths(warp.sourcePartId).filter((path) => !pairedSources.has(path.pathId))) {
    const row = document.createElement('div'); row.className = 'warp-pair warning';
    row.innerHTML = `<span>${unmatched.label}</span><b>→</b><span>Unmatched · fades out</span>`;
    row.appendChild(pairSelect(warp, unmatched)); list.appendChild(row);
  }
  panel.appendChild(list);

  const footer = document.createElement('footer');
  const addKey = document.createElement('button'); addKey.textContent = state.editorMode === 'animate' ? '◆ Key preview value' : 'Open in Animate';
  addKey.onclick = () => { if (state.editorMode !== 'animate') state.editorMode = 'animate'; checkpoint(); setKeyframeAt(warp.id, 'warp', state.currentTime, state.warpPreviewAmount); notify(); renderPose(); };
  const done = document.createElement('button'); done.className = 'primary'; done.textContent = 'Done'; done.onclick = close.onclick;
  footer.append(addKey, done); panel.appendChild(footer);
}
