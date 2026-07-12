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
}

export const ai: AiPanelState = {
  busy: false, status: '', promptText: '', critiqueText: null, abort: null,
};
