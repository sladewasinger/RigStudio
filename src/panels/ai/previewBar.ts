/**
 * The A2 preview-review card: shown in place of an immediate apply once a Create/Modify
 * request succeeds — a one-line summary plus Apply / Retry / Discard. Sits between the
 * busy readout and the action buttons so it reads as the natural next step. Structural
 * edits (bones/binds) never move the canvas pose (`./preview.ts`'s module comment), so a
 * second line calls that out explicitly rather than leaving the user to wonder why
 * nothing moved.
 */
import { AiRequestCtx, runAnimate } from './requests';
import {
  discardPreview, isPreviewActive, previewSummary, renderCandidateFilmstrip,
} from './preview';

export interface PreviewBarHandlers {
  /** Commits the candidate — status text, promptText, thread-turn recording (AI
   *  Animate System v2 A4), and notify() are `./panel.ts`'s job. */
  onApply: () => void;
  onDiscard: () => void;
}

/** Builds the review card for the CURRENTLY active preview, or returns null if none is
 *  active (defensive — `./panel.ts` already checks `isPreviewActive()` first). Registers
 *  itself on `ctx.previewBarRef` so `runAnimate`'s "starting a new request discards the
 *  old preview" branch can remove a stale bar immediately. */
export function buildPreviewBar(ctx: AiRequestCtx, handlers: PreviewBarHandlers): HTMLElement | null {
  const info = previewSummary();
  if (!info) return null;

  const bar = document.createElement('div');
  bar.className = 'ai-preview-bar';

  const summaryParts = [
    `Previewing: ${info.clipLabel}`,
    `${info.keyCount} key${info.keyCount === 1 ? '' : 's'}`,
  ];
  if (info.structuralSummary) summaryParts.push(info.structuralSummary);
  const summary = document.createElement('p');
  summary.className = 'ai-preview-summary';
  summary.textContent = summaryParts.join(' · ');
  bar.appendChild(summary);

  if (info.structuralSummary) {
    const note = document.createElement('p');
    note.className = 'hint ai-preview-note';
    note.textContent =
      'Structural changes (bones/binds) apply on Apply — they cannot be shown in this canvas preview.';
    bar.appendChild(note);
  }

  const actions = document.createElement('div');
  actions.className = 'ai-preview-actions';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'ai-preview-apply';
  applyBtn.dataset.aiAction = 'apply';
  applyBtn.title = 'Commit this candidate to the document (one undo reverts it).';
  applyBtn.onclick = () => handlers.onApply();
  actions.appendChild(applyBtn);

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry';
  retryBtn.dataset.aiAction = 'retry';
  retryBtn.title = 'Discard this candidate and ask Claude again with the same prompt.';
  retryBtn.onclick = async () => {
    if (!isPreviewActive()) return;
    const mode = previewSummary()!.mode;
    // A3 synergy: capture the CANDIDATE's filmstrip BEFORE discarding the preview —
    // once discardPreview() runs, its tracks/timeMs are gone. Lock the row for the
    // (short, local, no-network) capture so a double-click can't race discardPreview
    // against a still-running capture.
    applyBtn.disabled = true;
    retryBtn.disabled = true;
    discardBtn.disabled = true;
    const candidateFrames = ctx.fields.shotToggle.checked ? await renderCandidateFilmstrip() : undefined;
    if (!isPreviewActive()) return; // discarded from elsewhere while we were rendering — bail
    discardPreview();
    bar.remove();
    ctx.previewBarRef.current = null;
    void runAnimate(ctx, mode, candidateFrames); // same ctx/DOM — keeps the busy UI visible mid-request
  };
  actions.appendChild(retryBtn);

  const discardBtn = document.createElement('button');
  discardBtn.textContent = 'Discard';
  discardBtn.dataset.aiAction = 'discard';
  discardBtn.title = 'Throw this candidate away.';
  discardBtn.onclick = () => handlers.onDiscard();
  actions.appendChild(discardBtn);

  bar.appendChild(actions);
  ctx.previewBarRef.current = bar;
  return bar;
}
