/**
 * The Claude animation assistant panel orchestrator: mounts in Animate mode only
 * (locked v2.12 P5b decision — choreography against a clip makes no sense while
 * editing the character itself), assembling `./fields.ts` (static form), `./threadStrip
 * .ts` (AI Animate System v2 A4 refinement history), `./previewBar.ts` (the A2 review
 * card, when a preview is active), and wiring the action buttons to `./requests.ts`.
 * `./index.ts` is the public facade over this whole directory.
 */
import { state, notify } from '../../core/model';
import { renderPose } from '../../view';
import { AnimateResult } from '../../ai/claude';
import { FilmstripFrame } from '../../ui/snapshot';
import { ai } from './state';
import {
  AiFields, applyBusyState, buildAiFields, mountAiActions, mountAiIntroFields, mountAiToggleFields,
} from './fields';
import { buildTemplateRow } from './templates';
import { buildPolishButton } from './polish';
import { buildThreadStrip } from './threadStrip';
import { recordTurn, summarizeTracks } from './threads';
import { buildPreviewBar } from './previewBar';
import { AiRequestCtx, runAnimate, runCritique, __setAnimateCallForTest } from './requests';
import {
  commitPreview, debugStatus, debugTick, discardPreview, isPreviewActive,
  reconcilePreviewLifecycle, renderCandidateFilmstrip,
} from './preview';

/** Apply button (real or via the debug hook): commits the candidate exactly like pre-
 *  A2 did, then AI Animate System v2 A4 records a refinement-thread turn — APPLY ONLY
 *  (see `./threads.ts`'s doc comment: the thread reflects what actually landed, never a
 *  discarded candidate or an in-flight Retry). */
function handleApply(): void {
  // A6: a Polish turn's instruction lives in ai.polishInstruction, never in
  // ai.promptText (the prompt box is untouched by Polish) — see state.ts's doc comment.
  const isPolishTurn = ai.polishInstruction !== null;
  const instruction = ai.polishInstruction ?? ai.promptText; // capture BEFORE clearing below
  const committed = commitPreview();
  if (!committed || !committed.outcome) {
    ai.status = 'Failed to apply — no document loaded.';
    ai.polishInstruction = null;
    notify();
    return;
  }
  const { outcome, mode, clampedCount } = committed;
  state.editorMode = 'animate';
  state.currentTime = 0;
  state.playing = true;
  const clampNote = clampedCount > 0
    ? ` (clamped ${clampedCount} out-of-range key time${clampedCount === 1 ? '' : 's'})`
    : '';
  ai.status = mode === 'new'
    ? `Done — created "${outcome.clip.name}" and switched to it${outcome.structural}${clampNote}.`
    : `Done — playing the result${outcome.structural}${clampNote}.`;

  if (state.doc) {
    const doc = state.doc;
    const labelOf = (id: string) => doc.parts.find((p) => p.id === id)?.label ?? id;
    recordTurn(doc.name, outcome.clip.name, {
      instruction,
      mode,
      summary: summarizeTracks(outcome.clip.tracks, labelOf),
      clip: { duration: outcome.clip.duration, tracks: outcome.clip.tracks },
    });
  }

  // Clear the prompt only on a SUCCESSFUL apply of a NORMAL turn (state.ts's
  // AiPanelState doc comment) — a Polish turn never wrote to it, so clearing here
  // would erase the user's own untouched draft.
  if (!isPolishTurn) ai.promptText = '';
  ai.polishInstruction = null;
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-play'));
  notify();
}

function handleDiscard(): void {
  if (!discardPreview()) return;
  ai.status = '';
  ai.polishInstruction = null; // A6: never leak into a later normal turn's Apply
  notify();
}

// ---- Debug hook for headless verification (mirrors __smPanel's tick pattern) ----
if (typeof window !== 'undefined') {
  (window as unknown as { __aiPreview: unknown }).__aiPreview = {
    isActive: (): boolean => isPreviewActive(),
    status: () => debugStatus(),
    tick: (dtMs: number) => debugTick(dtMs),
    apply: (): void => handleApply(),
    discard: (): void => handleDiscard(),
    busy: (): boolean => ai.busy,
    /** A3: renders a filmstrip from the CANDIDATE preview — headless/live verification
     *  of frame sampling/restoration without a real Retry click. [] if none active. */
    renderFilmstrip: (): Promise<FilmstripFrame[]> => renderCandidateFilmstrip(),
    /** Console/live-verification convenience: the NEXT Create/Modify click resolves
     *  with `result` instead of calling the network. */
    fabricateNext: (result: AnimateResult): void => {
      __setAnimateCallForTest(async () => result);
    },
  };
}

export function buildAiPanel(el: HTMLElement): void {
  // A2: reconcile the two preview-lifecycle triggers with no dedicated main.ts hook
  // (see ./preview.ts's LIFECYCLE section). SILENT: notify() already fired to reach
  // this render pass, so calling it again here would recurse.
  if (reconcilePreviewLifecycle()) ai.status = '';

  if (state.editorMode !== 'animate') return;

  const box = document.createElement('div');
  box.className = 'ai-panel';
  box.innerHTML = '<h3>Animate with Claude</h3>';

  const fields: AiFields = buildAiFields();
  applyBusyState(fields, ai.busy); // reflect an in-flight request across a mid-request rebuild
  fields.status.textContent = ai.status;
  mountAiIntroFields(box, fields);

  // AI Animate System v2 A5: motion-template quick actions — FILL the prompt from the
  // rig profile + set duration, never auto-send (see templates.ts's decision comment).
  const templates = buildTemplateRow(fields);
  if (templates) box.appendChild(templates);

  // AI Animate System v2 A4: the refinement-thread strip for the ACTIVE clip, "under
  // the prompt box" per the wave brief — reads fresh every render (see threadStrip.ts).
  const strip = buildThreadStrip(() => notify());
  if (strip) box.appendChild(strip);

  mountAiToggleFields(box, fields);

  // A6: the Polish button lives outside `fields` (built after `ctx`, below), but
  // `setBusy` must still disable it the same instant it disables Create/Modify/Critique
  // (requests.ts's `setBusy(true)` is a direct DOM mutation for immediate feedback —
  // the re-enable-on-finish path is only ever the next full notify() rebuild, never a
  // symmetric `setBusy(false)`, so there's no stale-enabled risk to guard the other way).
  let polishBtn: HTMLButtonElement | null = null;
  const ctx: AiRequestCtx = {
    fields,
    setBusy: (busy) => {
      applyBusyState(fields, busy);
      if (busy && polishBtn) polishBtn.disabled = true;
    },
    previewBarRef: { current: null },
  };

  // A2: the preview bar — shown in place of an immediate apply once a Create/Modify
  // request succeeds, between the busy readout and the action buttons.
  if (isPreviewActive()) {
    const bar = buildPreviewBar(ctx, { onApply: handleApply, onDiscard: handleDiscard });
    if (bar) box.appendChild(bar);
  }

  mountAiActions(box, fields);
  // A6: "near the Modify action" per the wave brief.
  polishBtn = buildPolishButton(ctx);
  fields.modifyBtn.insertAdjacentElement('afterend', polishBtn);

  fields.createBtn.onclick = () => { void runAnimate(ctx, 'new'); };
  fields.modifyBtn.onclick = () => { void runAnimate(ctx, 'modify'); };
  fields.critiqueBtn.onclick = () => { void runCritique(ctx); };

  el.appendChild(box);
}
