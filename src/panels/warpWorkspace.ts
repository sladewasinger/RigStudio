import { state, notify, selectedParts, createWarpDefinition, WarpDefinition, setKeyframeAt, activeClip, sampleKeyList } from '../core/model';
import { checkpoint } from '../core/history';
import { renderPose } from '../view';
import { dialog } from '../ui/dialogs';

const openDock = () => document.dispatchEvent(new CustomEvent('rig-open-dock-tab', { detail: 'warps' }));
const nameOf = (id: string) => state.doc?.parts.find((part) => part.id === id)?.label ?? 'Missing';
const selectCarrier = (warp: WarpDefinition) => {
  state.selectedPartId = warp.sourcePartId;
  state.selectedPartIds = [warp.sourcePartId];
  state.selectedPathId = null;
};
const button = (label: string, fn: () => void | Promise<void>, style = '') => {
  const result = document.createElement('button'); result.textContent = label; result.className = style;
  result.onclick = () => void fn(); return result;
};

export function ensureWarpWorkspace(): HTMLElement { openDock(); return document.getElementById('inspector')!; }

export async function createWarpFromSelection(): Promise<void> {
  const selection = selectedParts();
  if (!state.doc || state.editorMode !== 'animate' || selection.length !== 2) return;
  const name = await dialog.prompt('Warp transition name', `${selection[0].label} ↔ ${selection[1].label}`);
  if (!name) return;
  const definition = createWarpDefinition(state.doc, selection[0].id, selection[1].id, name).definition;
  checkpoint(); (state.doc.warps ??= []).push(definition);
  state.warpSetupId = definition.id; state.warpPreviewAmount = 0;
  selectCarrier(definition);
  openDock(); notify(); renderPose();
}

export function warpForSelection(): WarpDefinition | null {
  if (!state.doc) return null;
  const ids = new Set<string>(); let part = selectedParts()[0];
  while (part) { ids.add(part.id); part = part.parentId ? state.doc.parts.find((item) => item.id === part.parentId)! : undefined!; }
  return state.doc.warps?.find((warp) => ids.has(warp.sourcePartId) || ids.has(warp.targetPartId)) ?? null;
}

export function openSelectedWarp(): boolean {
  const warp = warpForSelection(); if (!warp) return false;
  state.warpSetupId = warp.id; selectCarrier(warp); openDock(); notify(); renderPose(); return true;
}

function amount(warp: WarpDefinition): number {
  const track = activeClip()?.tracks.find((item) => item.target === warp.id && item.channel === 'warp');
  return sampleKeyList(track?.keyframes ?? [], state.currentTime, 0);
}

function rebuild(warp: WarpDefinition): void {
  warp.pairs = createWarpDefinition(state.doc!, warp.sourcePartId, warp.targetPartId, warp.name).definition.pairs;
}

function selectWarp(warp: WarpDefinition): void {
  state.warpSetupId = warp.id; state.warpPreviewAmount = amount(warp);
  state.warpPreviewActive = false;
  selectCarrier(warp);
  document.querySelector(`[data-warp-lane="${warp.id}"]`)?.scrollIntoView({ block: 'nearest' });
  notify(); renderPose();
}

function buildCorrespondence(host: HTMLElement, warp: WarpDefinition): void {
  const details = document.createElement('details'); details.className = 'warp-correspondence';
  const summary = document.createElement('summary'); summary.textContent = `Correspondence · ${warp.pairs.length} confirmed`;
  details.appendChild(summary);
  const rebuildButton = button('Rebuild safe matches', async () => {
    if (warp.pairs.length && !await dialog.confirm('Replace confirmed pairs with safe exact-name matches?')) return;
    checkpoint(); rebuild(warp); notify(); renderPose();
  });
  details.appendChild(rebuildButton);
  const list = document.createElement('div'); list.className = 'warp-pairs';
  for (const pair of warp.pairs) {
    const sourcePart = state.doc!.parts.find((part) => part.id === pair.sourcePartId);
    const targetPart = state.doc!.parts.find((part) => part.id === pair.targetPartId);
    const source = `${sourcePart?.label ?? '?'} / ${sourcePart?.paths.find((path) => path.id === pair.sourcePathId)?.label ?? '?'}`;
    const target = `${targetPart?.label ?? '?'} / ${targetPart?.paths.find((path) => path.id === pair.targetPathId)?.label ?? '?'}`;
    const row = document.createElement('div'); row.className = 'warp-pair'; row.tabIndex = 0;
    row.innerHTML = `<span>${source}</span><b>→</b><span>${target}</span><small>Exact name · confirmed</small>`;
    const highlight = (on: boolean) => [pair.sourcePathId, pair.targetPathId].forEach((id) => document.querySelector(`[data-path-id="${id}"]`)?.classList.toggle('warp-pair-highlight', on));
    row.onmouseenter = row.onfocus = () => highlight(true); row.onmouseleave = row.onblur = () => highlight(false);
    const actions = document.createElement('div'); actions.className = 'warp-inline-actions';
    actions.append(button(pair.reverse ? 'Reversed' : 'Reverse path', () => { checkpoint(); pair.reverse = !pair.reverse; notify(); renderPose(); }), button(`Move seam (${pair.seam ?? 0})`, () => { checkpoint(); pair.seam = (pair.seam ?? 0) + 1; notify(); renderPose(); }), button('Unpair', () => { checkpoint(); warp.pairs = warp.pairs.filter((item) => item.id !== pair.id); notify(); renderPose(); }));
    row.appendChild(actions); list.appendChild(row);
  }
  const pairedSources = new Set(warp.pairs.map((pair) => pair.sourcePathId));
  const collect = (root: string) => { const ids = new Set<string>(); const visit = (id: string) => { ids.add(id); state.doc!.parts.filter((part) => part.parentId === id).forEach((part) => visit(part.id)); }; visit(root); return state.doc!.parts.filter((part) => ids.has(part.id)).flatMap((part) => part.paths.map((path) => ({ part, path }))); };
  for (const source of collect(warp.sourcePartId).filter((item) => !pairedSources.has(item.path.id))) {
    const row = document.createElement('div'); row.className = 'warp-pair warning';
    row.innerHTML = `<span>${source.part.label} / ${source.path.label}</span><b>→</b><span>Unmatched · crossfades</span>`;
    const select = document.createElement('select'); select.innerHTML = '<option value="">Pair with…</option>'; select.setAttribute('aria-label', `Pair ${source.path.label}`);
    const used = new Set(warp.pairs.map((pair) => pair.targetPathId));
    collect(warp.targetPartId).filter((item) => !used.has(item.path.id)).forEach((target) => { const option = document.createElement('option'); option.value = target.path.id; option.textContent = `${target.part.label} / ${target.path.label}`; select.appendChild(option); });
    select.onchange = () => { const target = collect(warp.targetPartId).find((item) => item.path.id === select.value); if (!target) return; checkpoint(); const auto = createWarpDefinition(state.doc!, source.part.id, target.part.id, warp.name).definition.pairs.find((pair) => pair.sourcePathId === source.path.id && pair.targetPathId === target.path.id); if (auto) warp.pairs.push(auto); notify(); renderPose(); };
    row.appendChild(select); list.appendChild(row);
  }
  details.appendChild(list); host.appendChild(details);
}

function buildActive(host: HTMLElement, warp: WarpDefinition): void {
  const card = document.createElement('section'); card.className = 'warp-active';
  const name = document.createElement('input'); name.value = warp.name; name.setAttribute('aria-label', 'Warp name');
  name.onchange = () => { const next = name.value.trim(); if (!next || next === warp.name) return; checkpoint(); warp.name = next; notify(); };
  const roles = document.createElement('div'); roles.className = 'warp-roles'; roles.textContent = `${nameOf(warp.sourcePartId)}  ↔  ${nameOf(warp.targetPartId)}`;
  const value = Math.round(amount(warp) * 1000) / 10;
  const control = document.createElement('div'); control.className = 'warp-value';
  const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '.1'; range.value = String(value); range.setAttribute('aria-label', 'Warp percent');
  const number = document.createElement('input'); number.type = 'number'; number.min = '0'; number.max = '100'; number.step = '.1'; number.value = String(value); number.setAttribute('aria-label', 'Warp percent exact value');
  const preview = (raw: string) => { const next = Math.max(0, Math.min(100, Number(raw) || 0)); range.value = number.value = String(next); state.warpPreviewAmount = next / 100; state.warpPreviewActive = true; renderPose(); };
  range.oninput = () => preview(range.value); number.oninput = () => preview(number.value);
  control.append(range, number, document.createTextNode('%'), button('◆ Set key', () => { checkpoint(); setKeyframeAt(warp.id, 'warp', state.currentTime, Number(number.value) / 100); state.warpPreviewActive = false; notify(); renderPose(); }, 'primary'));
  card.append(name, roles, control);
  const actions = document.createElement('div'); actions.className = 'warp-inline-actions';
  actions.append(button('⇄ Swap', () => { checkpoint(); [warp.sourcePartId, warp.targetPartId] = [warp.targetPartId, warp.sourcePartId]; rebuild(warp); notify(); renderPose(); }), button('Delete', async () => { if (!await dialog.confirm(`Delete “${warp.name}”?`)) return; checkpoint(); state.doc!.warps = state.doc!.warps!.filter((item) => item.id !== warp.id); const clip = activeClip(); if (clip) clip.tracks = clip.tracks.filter((track) => track.target !== warp.id); state.warpSetupId = null; notify(); renderPose(); }, 'danger'));
  card.appendChild(actions); buildCorrespondence(card, warp); host.appendChild(card);
}

export function buildWarpWorkspace(host = document.getElementById('inspector')!): void {
  if (!host) return; host.innerHTML = ''; host.className = 'right-dock-content warps-panel';
  const header = document.createElement('header'); header.innerHTML = '<strong>Warps</strong><span>Morph artwork without a blink</span>'; host.appendChild(header);
  const warps = state.doc?.warps ?? [];
  if (!warps.length) { const empty = document.createElement('div'); empty.className = 'warp-empty'; empty.innerHTML = '<strong>No Warp transitions yet</strong><p>In Animate, select the source, Shift-select its target, then choose Create Warp.</p>'; host.appendChild(empty); return; }
  const list = document.createElement('div'); list.className = 'warps-list'; list.setAttribute('aria-label', 'All Warp transitions');
  for (const warp of warps) { const row = button('', () => selectWarp(warp), state.warpSetupId === warp.id ? 'warp-list-row active' : 'warp-list-row'); row.innerHTML = `<strong>${warp.name}</strong><span>${nameOf(warp.sourcePartId)} ↔ ${nameOf(warp.targetPartId)}</span><small>${warp.pairs.length ? 'Ready' : 'Needs correspondence'} · ${Math.round(amount(warp) * 100)}%</small>`; row.setAttribute('aria-pressed', String(state.warpSetupId === warp.id)); list.appendChild(row); }
  host.appendChild(list); const active = warps.find((warp) => warp.id === state.warpSetupId) ?? warps[0]; if (!state.warpSetupId) state.warpSetupId = active.id; buildActive(host, active);
}
