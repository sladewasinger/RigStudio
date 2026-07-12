/**
 * The AI panel's module-scope state singleton — kept OUTSIDE any render closure so an
 * inspector rebuild (notify(), e.g. from a keyboard-driven selection change) mid-request
 * doesn't lose the busy UI / Cancel button, and so the prompt textarea's content
 * survives inspector rebuilds, editor-mode round trips (the panel simply isn't built in
 * Edit mode), and timeline view switches (curves/logic) — all of which fire notify()
 * and rebuild the panel from a blank slate.
 *
 * `promptText` DECISION: cleared ONLY on a successful apply (Create or Modify) — the
 * user's wording is the thing most worth keeping around after a failed or cancelled
 * request, so both those paths leave it untouched; only a completed edit "consumes" it.
 * Critique doesn't touch it at all (it isn't a directive).
 */
export interface AiPanelState {
  busy: boolean;
  status: string;
  promptText: string;
  critiqueText: string | null;
  abort: AbortController | null;
  /**
   * AI Animate System v2 A6 "Polish": the instruction of an in-flight/just-entered
   * preview that came from the Polish button rather than the prompt box. Non-null from
   * the moment `requests.ts`'s `runAnimate` enters a preview for a Polish turn until
   * `panel.ts`'s `handleApply`/`handleDiscard` consumes it (both reset it to null) — it
   * exists so Apply records the RIGHT text as the thread turn and never clears
   * `promptText`, which a Polish turn never wrote to in the first place (the user's own
   * draft, if any, must survive untouched).
   */
  polishInstruction: string | null;
}

export const ai: AiPanelState = {
  busy: false, status: '', promptText: '', critiqueText: null, abort: null, polishInstruction: null,
};
