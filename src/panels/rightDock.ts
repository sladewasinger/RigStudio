import { state } from '../core/model';
import { renderPose } from '../view';
import { buildInspector } from './inspector';
import { buildAiPanel } from './ai';
import { buildWarpWorkspace } from './warpWorkspace';

export type RightDockTab = 'inspector' | 'warps' | 'claude';

const WIDTH_KEY = 'rig-studio-right-dock-width';
const TAB_KEY = 'rig-studio-right-dock-tab';
const PIN_KEY = 'rig-studio-right-dock-pinned';
const MIN_WIDTH = 260;
const MAX_WIDTH = 620;
const DEFAULT_WIDTH = 340;
let inspectorElement: HTMLElement | null = null;
let activeTab: RightDockTab = (localStorage.getItem(TAB_KEY) as RightDockTab) || 'inspector';
let pinned = localStorage.getItem(PIN_KEY) === 'true';

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
  activeTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  if (inspectorElement) buildRightDock(inspectorElement);
}

export function buildRightDock(inspector: HTMLElement): void {
  inspectorElement = inspector;
  const dock = ensureShell(inspector);
  if (state.editorMode === 'setup') {
    // Claude's panel owns preview lifecycle reconciliation. Run its lightweight
    // unmount pass even though the tab is Animate-only.
    buildAiPanel(document.createElement('div'));
    if (activeTab === 'claude') activeTab = 'inspector';
  }
  dock.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'right-dock-tabs';
  tabs.setAttribute('role', 'tablist');
  const definitions: { id: RightDockTab; label: string }[] = [
    { id: 'inspector', label: 'Inspector' }, { id: 'warps', label: 'Warps' },
    ...(state.editorMode === 'animate' ? [{ id: 'claude' as const, label: 'Animate with Claude' }] : []),
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
  const pin = document.createElement('button');
  pin.className = 'right-dock-pin';
  pin.textContent = pinned ? '◆' : '◇';
  pin.title = pinned ? 'Dock pinned' : 'Pin dock tab';
  pin.setAttribute('aria-pressed', String(pinned));
  pin.onclick = () => { pinned = !pinned; localStorage.setItem(PIN_KEY, String(pinned)); buildRightDock(inspector); };
  tabs.appendChild(pin);
  dock.appendChild(tabs);
  inspector.className = 'right-dock-content';
  inspector.setAttribute('role', 'tabpanel');
  inspector.setAttribute('aria-labelledby', `right-dock-tab-${activeTab}`);
  dock.appendChild(inspector);
  if (activeTab === 'inspector') buildInspector(inspector);
  else if (activeTab === 'warps') buildWarpWorkspace(inspector);
  else buildAiPanel(inspector);
}

export function currentRightDockTab(): RightDockTab { return activeTab; }
