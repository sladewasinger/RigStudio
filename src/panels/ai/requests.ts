/**
 * Running an animate/critique request against Claude: assembling context (scene +
 * filmstrip/snapshot + protected keys + AI Animate System v2 A4 thread context),
 * calling the API (or the test seam), and entering a preview / showing a critique on
 * success. The "requests" half of the former `panels/ai.ts` monolith — `./panel.ts`
 * wires the Create/Modify/Critique buttons to `runAnimate`/`runCritique` here;
 * `./previewBar.ts`'s Retry button also calls `runAnimate` directly (with candidate
 * frames it already rendered).
 */
import {
  state, notify, activeClip, snapshotProtectedKeys, ProtectedKey,
} from '../../core/model';
import { animateWithClaude, critiqueWithClaude } from '../../ai/claude';
import { buildThreadContextBlock } from '../../ai/threads';
import {
  cloneArtworkSvg, rasterizeSvg, renderClipFilmstrip, FilmstripFrame,
} from '../../ui/snapshot';
import { AiFields, setEditorInert } from './fields';
import { ai } from './state';
import { enterPreview, isPreviewActive, discardPreview } from './preview';
import { getThread } from './threads';

/**
 * Test-only seam (mirrors core/history.ts's `setRestoreHandler` pattern): production
 * code always calls the real `animateWithClaude`. Interaction tests swap this to
 * fabricate an `AnimateResult` without a real network call.
 */
let animateCallImpl: typeof animateWithClaude = animateWithClaude;
export function __setAnimateCallForTest(fn: typeof animateWithClaude): void {
  animateCallImpl = fn;
}

/** Rasterize the canvas at the CURRENT PLAYHEAD TIME (sans overlay/onion) to a PNG for
 *  the vision-grounded assistant calls — see ui/snapshot.ts's `cloneArtworkSvg` doc
 *  comment for the shared clone/rasterize primitives. Returns base64 (no data: prefix). */
async function snapshotPose(): Promise<string | null> {
  const clone = cloneArtworkSvg();
  if (!clone) return null;
  const { w, h } = state.doc!.viewBox;
  const outW = 512;
  const outH = Math.round((512 * h) / w);
  const dataUrl = await rasterizeSvg(clone, outW, outH, '#ffffff');
  return dataUrl.split(',')[1] ?? null;
}

function requireCtx(f: AiFields): { doc: NonNullable<typeof state.doc>; apiKey: string } | null {
  const doc = state.doc;
  const apiKey = f.keyInput.value.trim();
  if (!doc || !activeClip()) return null;
  if (!apiKey) {
    f.status.textContent = 'Enter an API key first.';
    return null;
  }
  return { doc, apiKey };
}

export interface AiRequestCtx {
  fields: AiFields;
  setBusy: (busy: boolean) => void;
  /** Tracks the currently-mounted preview-bar element across the button-click closure
   *  so a stale bar can be removed immediately (see `runAnimate`'s discard branch)
   *  without waiting for the next notify()-driven rebuild. Owned by `./panel.ts`. */
  previewBarRef: { current: HTMLElement | null };
}

export async function runAnimate(
  ctx: AiRequestCtx,
  mode: 'new' | 'modify',
  /** A2×A3 synergy: on Retry with a preview active, the caller pre-renders the
   *  CANDIDATE's filmstrip before discarding the preview and passes it here, so this
   *  request reacts to what the model actually produced instead of the doc's stale
   *  pose. undefined = render the DOC's active clip fresh here. */
  retryFrames?: FilmstripFrame[],
): Promise<void> {
  const { fields, setBusy, previewBarRef } = ctx;
  const ctxv = requireCtx(fields);
  const clip = activeClip();
  if (!ctxv || !clip) return;
  if (!fields.promptBox.value.trim()) {
    fields.status.textContent = 'Describe the motion you want.';
    return;
  }
  // Starting a new request always discards whatever preview is currently showing (A2
  // rule) — remove its DOM immediately rather than waiting for a rebuild.
  if (isPreviewActive()) {
    discardPreview();
    previewBarRef.current?.remove();
    previewBarRef.current = null;
  }
  const controller = new AbortController();
  ai.abort = controller;
  ai.busy = true;
  ai.status = mode === 'new'
    ? 'Creating a new animation… (this can take a minute)'
    : 'Choreographing… (this can take a minute)';
  fields.status.textContent = ai.status;
  setBusy(true);
  try {
    // A3 filmstrip: prefer N rendered frames over a single pose snapshot — replaces it
    // entirely when available. Failure-soft: rasterization errors degrade to the old
    // single-snapshot fallback, never block the request either way.
    let frames: FilmstripFrame[] = [];
    let image: string | null = null;
    let framesFailed = false;
    if (fields.shotToggle.checked) {
      if (retryFrames !== undefined) {
        frames = retryFrames; // A2×A3: candidate frames, already rendered by Retry
      } else {
        try { frames = await renderClipFilmstrip(clip); } catch { frames = []; }
      }
      if (frames.length === 0) {
        framesFailed = true;
        image = await snapshotPose().catch(() => null);
      }
    }

    // "protect playhead keys" (Modify only): snapshot the current-frame keys BEFORE
    // the request — by part id (idProtected, for post-apply enforcement) and by label
    // (promptProtected, for the prompt text Claude actually reads).
    const idProtected: ProtectedKey[] =
      mode === 'modify' && fields.protectToggle.checked
        ? snapshotProtectedKeys(clip, state.currentTime)
        : [];
    const labelOf = (id: string) => ctxv.doc.parts.find((p) => p.id === id)?.label ?? id;
    const promptProtected = idProtected.map((pk) => ({
      target: pk.target === 'root' ? 'root' : labelOf(pk.target),
      channel: pk.channel,
      time: pk.time,
      value: pk.value,
    }));

    // AI Animate System v2 A4: clip-scoped refinement thread — MODIFY only (a 'new'
    // clip's name isn't known until the response comes back, so there's no target
    // clip to look a thread up under yet; see src/panels/ai/threads.ts's doc comment).
    let instruction = fields.promptBox.value.trim();
    if (mode === 'modify') {
      const thread = getThread(ctxv.doc.name, clip.name);
      if (thread && thread.turns.length > 0) {
        const block = buildThreadContextBlock(thread.turns, { retryNote: retryFrames !== undefined });
        instruction = `${block}\n\nNEW INSTRUCTION: ${instruction}`;
      }
    }

    const result = await animateCallImpl(
      ctxv.apiKey, ctxv.doc, clip, instruction, state.selectedPartIds,
      {
        imageBase64: image,
        frames: frames.length > 0 ? frames : undefined,
        allowRigChanges: fields.rigToggle.checked,
        mode,
        protectedKeys: promptProtected,
        signal: controller.signal,
      },
    );
    // The doc is untouched up to this point. A2: a SUCCESSFUL response enters a
    // canvas-only PREVIEW that the user reviews via Apply / Retry / Discard.
    enterPreview(result, mode, {
      clip: mode === 'modify' ? clip : undefined,
      clipName: result.clip.clipName,
      protectedKeys: idProtected,
    });
    const clampNote = result.clampedCount > 0
      ? ` (clamped ${result.clampedCount} out-of-range key time${result.clampedCount === 1 ? '' : 's'})`
      : '';
    const frameNote = framesFailed
      ? image ? ' (frames unavailable — sent a single snapshot instead)' : ' (frames unavailable)'
      : '';
    ai.status = `Candidate ready — review it below.${clampNote}${frameNote}`;
    // promptText is intentionally left alone here (state.ts's doc comment) — it now
    // clears on a successful APPLY, not on a successful generate.
  } catch (err) {
    ai.status = controller.signal.aborted
      ? 'Cancelled.'
      : `Failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    ai.busy = false;
    ai.abort = null;
    // Clear the inert overlay directly rather than only through setBusy(): the
    // toolbar's mode toggle lives outside #layout and stays clickable even while
    // inert, so the user could switch to Edit mode mid-request — buildAiPanel then
    // returns early (Animate-only) and never re-runs setBusy(false) to undo it.
    setEditorInert(false);
    // notify() rebuilds every panel (picks up ai.status + idle control state, and the
    // preview bar if enterPreview just ran). It doesn't call renderPose() itself: the
    // success path already repainted (enterPreview's setPoseSampler call does), and
    // the failure/cancel paths change no doc state, so no repaint is needed there.
    notify();
  }
}

export async function runCritique(ctx: AiRequestCtx): Promise<void> {
  const { fields, setBusy } = ctx;
  const ctxv = requireCtx(fields);
  const clip = activeClip();
  if (!ctxv || !clip) return;
  const controller = new AbortController();
  ai.abort = controller;
  ai.busy = true;
  ai.status = 'Reviewing the clip…';
  ai.critiqueText = null;
  fields.status.textContent = ai.status;
  fields.critiqueOut.hidden = true;
  setBusy(true);
  try {
    // A3 filmstrip, offered on Critique too (same checkbox, same failure-soft fallback).
    let frames: FilmstripFrame[] = [];
    let image: string | null = null;
    if (fields.shotToggle.checked) {
      try { frames = await renderClipFilmstrip(clip); } catch { frames = []; }
      if (frames.length === 0) image = await snapshotPose().catch(() => null);
    }
    const text = await critiqueWithClaude(
      ctxv.apiKey, ctxv.doc, clip, state.selectedPartIds,
      { imageBase64: image, frames: frames.length > 0 ? frames : undefined, signal: controller.signal },
    );
    ai.critiqueText = text;
    ai.status = '';
  } catch (err) {
    ai.status = controller.signal.aborted
      ? 'Cancelled.'
      : `Failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    ai.busy = false;
    ai.abort = null;
    setEditorInert(false); // see runAnimate's finally block for why this is unconditional
    notify();
  }
}
