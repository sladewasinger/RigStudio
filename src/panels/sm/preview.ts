/**
 * The ▶ preview engine: owns the live SMInstance + rAF loop, drives the canvas pose via
 * view's `setPoseSampler` hook, dispatches canvas pointer events to listeners during
 * preview, and exposes the `window.__smPanel` debug hook used for deterministic headless
 * verification.
 */

import {
  state, ancestorChain, partById, StateMachine, SMInput, SMListener,
} from '../../core/model';
import { renderPose, setPoseSampler } from '../../view';
import { createSMInstance, SMInstance } from '../../core/stateMachine';
import { ctx, rerender, stateName } from './state';

// ---- Preview (app state; never serialized) ----

interface Preview {
  machineId: string;
  instance: SMInstance;
  rafId: number;
  last: number;
  /** Live input values shown by the LIVE controls, so a rebuild mid-preview keeps them. */
  liveInputs: Map<string, boolean | number>;
}
let preview: Preview | null = null;
let previewCanvas: HTMLElement | null = null;

export function isPreviewing(sm: StateMachine): boolean {
  return !!preview && preview.machineId === sm.id;
}

/** Whether ANY machine is previewing, regardless of which — used by panel.ts's Escape
 * handler, which doesn't have a specific machine in hand. */
export function isAnyPreviewActive(): boolean {
  return !!preview;
}

export function startPreview(sm: StateMachine): void {
  stopPreview();
  const doc = state.doc;
  if (!doc) return;
  const instance = createSMInstance(doc, sm);
  preview = { machineId: sm.id, instance, rafId: 0, last: performance.now(), liveInputs: new Map() };
  setPoseSampler((target, channel) => instance.channelValue(target, channel));
  installCanvasHooks();

  const tick = (now: number) => {
    if (!preview || preview.instance !== instance) return;
    const dt = now - preview.last;
    preview.last = now;
    instance.advance(dt);
    renderPose();
    updateStatusReadout();
    preview.rafId = requestAnimationFrame(tick);
  };
  // Draw immediately (headless environments may never produce frames), then loop.
  instance.advance(0);
  renderPose();
  updateStatusReadout();
  preview.rafId = requestAnimationFrame(tick);
}

export function stopPreview(): void {
  if (!preview) return;
  cancelAnimationFrame(preview.rafId);
  preview = null;
  removeCanvasHooks();
  setPoseSampler(null); // restores normal sampling and repaints
}

export function boolLive(inp: SMInput): boolean {
  const v = preview?.liveInputs.get(inp.id);
  return v === undefined ? inp.default === true : v === true;
}

export function numLive(inp: SMInput): number {
  const v = preview?.liveInputs.get(inp.id);
  if (typeof v === 'number') return v;
  return typeof inp.default === 'number' ? inp.default : 0;
}

export function setLive(inp: SMInput, value: boolean | number): void {
  if (!preview) return;
  preview.liveInputs.set(inp.id, value);
  preview.instance.setInput(inp.name, value);
}

/** Fires a trigger's LIVE value during preview (the Inputs panel's "fire" button). */
export function fireLiveTrigger(name: string): void {
  preview?.instance.fireTrigger(name);
}

export function liveStateId(): string {
  return preview ? preview.instance.status().stateId : '';
}

export function previewStatusText(sm: StateMachine): string {
  if (!preview) return '';
  const s = preview.instance.status();
  let txt = `▶ ${stateName(sm, s.stateId)}`;
  if (s.blend) txt += ` ⇢ ${Math.round(s.blend.progress * 100)}%`;
  if (s.done) txt += ' · done';
  return txt;
}

export function updateStatusReadout(): void {
  if (!preview || !ctx.host) return;
  const sm = state.doc?.stateMachines?.find((m) => m.id === preview!.machineId);
  const el = ctx.host.querySelector<HTMLElement>('.sm-status');
  if (el && sm) el.textContent = previewStatusText(sm);
  // Keep the live state-box highlight in sync each frame without a full rebuild.
  const svg = ctx.host.querySelector<SVGSVGElement>('.sm-svg');
  if (!svg) return;
  const liveId = liveStateId();
  for (const rect of Array.from(svg.querySelectorAll<SVGRectElement>('.sm-state'))) {
    rect.classList.toggle('sm-live', rect.getAttribute('data-state-id') === liveId);
  }
}

// ---- Canvas pointer capture during preview ----

const EVENT_MAP: Record<string, SMListener['event']> = {
  pointerdown: 'down',
  pointerup: 'up',
  pointerover: 'enter',
  pointerout: 'exit',
};

function installCanvasHooks(): void {
  previewCanvas = document.getElementById('canvas');
  if (!previewCanvas) return;
  for (const type of Object.keys(EVENT_MAP)) {
    previewCanvas.addEventListener(type, onPreviewPointer, true);
  }
}

function removeCanvasHooks(): void {
  if (!previewCanvas) return;
  for (const type of Object.keys(EVENT_MAP)) {
    previewCanvas.removeEventListener(type, onPreviewPointer, true);
  }
  previewCanvas = null;
}

function onPreviewPointer(ev: Event): void {
  if (!preview) return;
  const pe = ev as PointerEvent;
  // Capture-phase on #canvas (an ancestor of the svg): stop here so view.ts's selection/
  // drag handlers on the svg never see it — the canvas is inert while previewing.
  ev.stopPropagation();
  const mapped = EVENT_MAP[ev.type];
  if (!mapped) return;
  dispatchToListeners(pe.clientX, pe.clientY, mapped);
}

function dispatchToListeners(clientX: number, clientY: number, event: SMListener['event']): void {
  if (!preview) return;
  const doc = state.doc;
  const sm = doc?.stateMachines?.find((m) => m.id === preview!.machineId);
  if (!doc || !sm) return;
  const partId = hitPartId(clientX, clientY);
  if (!partId) return;
  const part = partById(partId);
  if (!part) return;
  // A listener on a group/ancestor also fires for events on its children.
  const chain = new Set<string>([partId, ...ancestorChain(part).map((a) => a.id)]);
  for (const ls of sm.listeners) {
    if (ls.event !== event) continue;
    if (!chain.has(ls.targetPartId)) continue;
    for (const a of ls.actions) {
      const inp = sm.inputs.find((x) => x.id === a.inputId);
      if (!inp) continue;
      if (a.type === 'fireTrigger') preview.instance.fireTrigger(inp.name);
      else if (a.type === 'setBool') preview.instance.setInput(inp.name, a.value === true);
      else preview.instance.setInput(inp.name, typeof a.value === 'number' ? a.value : 0);
    }
  }
}

function hitPartId(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const partEl = (el as Element).closest?.('[data-part-id]') as HTMLElement | null;
    if (partEl?.dataset.partId) return partEl.dataset.partId;
  }
  return null;
}

// ---- Debug hook for verification (not serialized) ----
if (typeof window !== 'undefined') {
  (window as unknown as { __smPanel: unknown }).__smPanel = {
    previewStatus: () => (preview ? preview.instance.status() : null),
    isPreviewActive: () => !!preview,
    // Test-only entry point for starting a preview WITHOUT driving the panel UI —
    // exists so the doc-replace teardown fix (main.ts's afterDocReplaced calling
    // stopPreview) can be exercised headlessly: a preview left running owns capture-
    // phase listeners on #canvas that survive a buildCanvas rebuild (the container
    // itself isn't recreated), so a doc swap without teardown leaves the canvas
    // permanently inert to clicks. No-ops if the machine id doesn't resolve.
    startPreviewByMachineId: (id: string) => {
      const sm = state.doc?.stateMachines?.find((m) => m.id === id);
      if (sm) startPreview(sm);
    },
    // Deterministic tick for headless verification (mirrors the rAF loop's per-frame work,
    // since requestAnimationFrame is throttled/paused in an unfocused automation tab).
    tick: (dtMs: number) => {
      if (!preview) return null;
      preview.instance.advance(dtMs);
      renderPose();
      updateStatusReadout();
      return preview.instance.status();
    },
    setPreviewInput: (name: string, v: boolean | number) => preview?.instance.setInput(name, v),
    firePreviewTrigger: (name: string) => preview?.instance.fireTrigger(name),
    selectState: (id: string | null) => { ctx.selStateId = id; ctx.selTransitionId = null; rerender(); },
    selectTransition: (id: string | null) => { ctx.selTransitionId = id; ctx.selStateId = null; rerender(); },
    selectMachine: (id: string | null) => { ctx.selMachineId = id; ctx.selStateId = null; ctx.selTransitionId = null; rerender(); },
    channelValue: (target: string, channel: 'rotate' | 'tx' | 'ty' | 'sx' | 'sy') =>
      preview ? preview.instance.channelValue(target, channel) : null,
  };
}
