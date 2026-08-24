import { state } from '../core/model';
import { renderPose } from '../view';
import { buildInspector } from './inspector';
import { buildAiPanel } from './ai';
import { buildWarpWorkspace } from './warpWorkspace';

export type RightDockTab = 'inspector' | 'warps' | 'claude';

const WIDTH_KEY = 'rig-studio-right-dock-width';
const MIN_WIDTH = 260;
const MAX_WIDTH = 620;
const DEFAULT_WIDTH = 340;
let inspectorElement: HTMLElement | null = null;
let activeTab: RightDockTab = 'inspector';

const clamp = (value: number) => Math.min(Math.min(MAX_WIDTH, window.innerWidth * .55), Math.max(MIN_WIDTH, value));

function applyWidth(layout: HTMLElement, value: number): void {
  layout.style.setProperty('--right-dock-width', `${clamp(value)}px`);
}

function ensureShell(inspector: HTMLElement): HTMLElement {
  const existing = document.getElementById('right-dock');
  if (existing) return existing;
  const layout = inspector.parentElement!;
  const dock = document.createElement('aside');
  dock.id = 'right-dock';
  dock.setAttribute('aria-label', 'Properties dock');
  layout.insertBefore(dock, inspector);
  dock.appendChild(inspector);
  const splitter = document.createElement('div');
  splitter.id = 'right-dock-splitter';
  splitter.tabIndex = 0;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-label', 'Resize properties dock');
  splitter.setAttribute('aria-valuemin', String(MIN_WIDTH));
  splitter.setAttribute('aria-valuemax', String(MAX_WIDTH));
  layout.insertBefore(splitter, dock);
  applyWidth(layout, Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH);
  const persist = () => localStorage.setItem(WIDTH_KEY, String(Math.round(dock.getBoundingClientRect().width)));
  const set = (width: number) => {
    applyWidth(layout, width);
    splitter.setAttribute('aria-valuenow', String(Math.round(clamp(width))));
    renderPose();
  };
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const start = event.clientX, width = dock.getBoundingClientRect().width;
    splitter.classList.add('dragging');
    try { splitter.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
    const move = (next: PointerEvent) => set(width + start - next.clientX);
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.classList.remove('dragging');
      persist();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = dock.getBoundingClientRect().width;
    set(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH : width + (event.key === 'ArrowLeft' ? 16 : -16));
    persist();
  });
  window.addEventListener('resize', () => set(dock.getBoundingClientRect().width));
  document.addEventListener('rig-open-dock-tab', (event) => {
    const tab = (event as CustomEvent<RightDockTab>).detail;
    if (tab) openRightDockTab(tab);
  });
  return dock;
}

export function openRightDockTab(tab: RightDockTab): void {
  if (state.editorMode === 'setup' && tab !== 'inspector') return;
  activeTab = tab;
  if (inspectorElement) buildRightDock(inspectorElement);
}

/** A document replacement is a fresh authoring context, never a continuation of an
 *  assistant or Warp workspace. Width remains a user preference; active content does
 *  not. Direct Warp actions may open Warps again after this reset. */
export function resetRightDockTab(): void {
  // Reconcile/discard any Claude preview tied to the outgoing document before the
  // Claude DOM is removed. Merely mounting Inspector would otherwise strand the old
  // preview sampler and its listeners behind an invisible tab.
  buildAiPanel(document.createElement('div'));
  activeTab = 'inspector';
  if (inspectorElement) buildRightDock(inspectorElement);
}

export function buildRightDock(inspector: HTMLElement): void {
  inspectorElement = inspector;
  const dock = ensureShell(inspector);
  if (state.editorMode === 'setup') {
    // Claude's panel owns preview lifecycle reconciliation. Run its lightweight
    // unmount pass even though the tab is Animate-only.
    buildAiPanel(document.createElement('div'));
  }
  dock.innerHTML = '';
  // The content host itself survives tab switches. Clear it explicitly so a panel
  // can never append beneath the previous tab's DOM (Claude intentionally appends).
  inspector.innerHTML = '';
  inspector.className = 'right-dock-content';
  inspector.setAttribute('role', 'tabpanel');
  if (state.editorMode === 'setup') {
    inspector.removeAttribute('aria-labelledby');
    dock.appendChild(inspector);
    buildInspector(inspector);
    return;
  }
  const tabs = document.createElement('div');
  tabs.className = 'right-dock-tabs';
  tabs.setAttribute('role', 'tablist');
  const definitions: { id: RightDockTab; label: string }[] = [
    { id: 'inspector', label: 'Inspector' }, { id: 'warps', label: 'Warps' },
    { id: 'claude', label: 'Animate with Claude' },
  ];
  definitions.forEach((definition, index) => {
    const button = document.createElement('button');
    button.id = `right-dock-tab-${definition.id}`;
    button.textContent = definition.label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(activeTab === definition.id));
    button.tabIndex = activeTab === definition.id ? 0 : -1;
    if (activeTab === definition.id) button.classList.add('active');
    button.onclick = () => openRightDockTab(definition.id);
    button.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + definitions.length) % definitions.length;
      openRightDockTab(definitions[next].id);
      document.getElementById(`right-dock-tab-${definitions[next].id}`)?.focus();
    };
    tabs.appendChild(button);
  });
  dock.appendChild(tabs);
  inspector.setAttribute('aria-labelledby', `right-dock-tab-${activeTab}`);
  dock.appendChild(inspector);
  if (activeTab === 'inspector') buildInspector(inspector);
  else if (activeTab === 'warps') buildWarpWorkspace(inspector);
  else buildAiPanel(inspector);
}

export function currentRightDockTab(): RightDockTab { return activeTab; }
