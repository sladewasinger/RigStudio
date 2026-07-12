/**
 * The Claude animation assistant panel: choreograph the active clip from a natural-
 * language prompt, or critique it, optionally attaching a rendered snapshot of the
 * current pose for spatial grounding. Animate-mode only (locked v2.12 P5b decision) —
 * posing/choreography against a clip makes no sense while editing the character itself.
 *
 * AI Animate System v2 A1 ("session & intent UX") lives here: a persistent prompt box,
 * two explicit actions (Create new animation / Modify current animation), and a
 * "protect playhead keys" option for Modify. See `AiPanelState`'s doc comment for the
 * prompt-persistence decision and `applyAiResult`'s doc comment for how the two modes
 * apply — that function is written so A2 (preview-before-apply) can call it from an
 * Apply button once results render as a preview instead of applying immediately.
 */

import {
  state, notify, activeClip, applyRigChanges, boneChain, sanitizeClipName,
  snapshotProtectedKeys, enforceProtectedKeys, Track, Channel, RigPart, RigDoc, Clip,
  ProtectedKey,
} from '../core/model';
import { renderPose, registerPart, bindPartsToBones } from '../view';
import { animateWithClaude, critiqueWithClaude, AnimateResult } from '../ai/claude';
import { checkpoint } from '../core/history';
import { cloneArtworkSvg, rasterizeSvg } from '../ui/snapshot';

/**
 * Rasterize the canvas at the CURRENT PLAYHEAD TIME (sans overlay/onion) to a PNG for
 * the vision-grounded assistant calls. The live `#rig-svg` already reflects whatever
 * pose is on screen, which in Animate mode is always the playhead's pose (renderPose
 * samples `state.currentTime`) — so cloning it verbatim is exactly "current playhead
 * pose", not e.g. a rest pose or an arbitrary frame. Returns base64 image data (no
 * data: prefix). Shares the clone/rasterize primitives with the toolbar's still-image
 * export (ui/snapshot.ts) — this call keeps the exact prior behavior (full-document
 * viewBox, artboard rect NOT stripped, 512px-wide white-background PNG).
 */
async function snapshotPose(): Promise<string | null> {
  const clone = cloneArtworkSvg();
  if (!clone) return null;
  const { w, h } = state.doc!.viewBox;
  const outW = 512;
  const outH = Math.round((512 * h) / w);
  const dataUrl = await rasterizeSvg(clone, outW, outH, '#ffffff');
  return dataUrl.split(',')[1] ?? null;
}

/**
 * Structural rig edits (bones, incl. Bones 2.0 auto-bind chains) shared by both apply
 * modes — factored out of `applyAiResult` since it's identical work regardless of
 * whether the clip itself is being created or modified. Returns the label→id map needed
 * to resolve track targets (new bones don't have ids until this runs) plus a list of
 * human-readable notes ("+2 bones", "bound 1 part") for the status line; NO checkpoint
 * here — the caller wraps the whole apply (rig + clip) in exactly one.
 */
function applyStructuralRigChanges(
  doc: RigDoc, result: AnimateResult,
): { labelToId: Map<string, string>; notes: string[] } {
  let labelToId = new Map(doc.parts.map((p) => [p.label, p.id]));
  const notes: string[] = [];
  if (!result.rig) return { labelToId, notes };

  labelToId = applyRigChanges(result.rig);
  doc.parts.forEach(registerPart); // canvas groups for any new bones
  const added = result.rig.addBones?.length ?? 0;
  if (added > 0) notes.push(`+${added} bone${added === 1 ? '' : 's'}`);

  // Bones 2.0: bind requested art parts to each new bone's full chain, inside the SAME
  // checkpoint as the placement + clip — one undo reverts all of it. Binding can't live
  // in model.applyRigChanges: it bakes geometry, which needs the live canvas
  // (bindPartsToBones), not just the doc.
  const boundChains = new Set<string>();
  let bound = 0;
  for (const b of result.rig.addBones ?? []) {
    if (!b.bindParts?.length) continue;
    const boneId = labelToId.get(b.label);
    if (!boneId) continue;
    const chain = boneChain(doc.parts, boneId);
    if (chain.length === 0) continue;
    const chainKey = chain.map((p) => p.id).sort().join(',');
    if (boundChains.has(chainKey)) continue;
    boundChains.add(chainKey);
    // Union bindParts across every new bone that belongs to this chain — matches
    // the real auto-bind behavior of binding to the WHOLE chain, not one joint.
    const wantLabels = new Set<string>();
    for (const bb of result.rig.addBones ?? []) {
      const bid = labelToId.get(bb.label);
      if (bid && chain.some((c) => c.id === bid)) {
        for (const l of bb.bindParts ?? []) wantLabels.add(l);
      }
    }
    const arts = [...wantLabels]
      .map((label) => doc.parts.find((p) => p.label === label))
      .filter((p): p is RigPart => !!p && p.kind === 'art' && p.paths.length > 0);
    if (arts.length > 0) {
      bindPartsToBones(arts, chain);
      bound += arts.length;
    }
  }
  if (bound > 0) notes.push(`bound ${bound} part${bound === 1 ? '' : 's'}`);

  return { labelToId, notes };
}

export interface ApplyAiOptions {
  /** mode 'modify' target clip; defaults to `activeClip()` when omitted. Ignored for
   *  'new' (a fresh clip is appended instead). */
  clip?: Clip | null;
  /** Model-proposed name for a NEW clip — sanitized/deduped against the doc's existing
   *  clip names inside this function. Ignored for 'modify'. */
  clipName?: string | null;
  /** Pre-request snapshot of playhead-protected keys (`snapshotProtectedKeys`) —
   *  restored onto the clip after its tracks are applied. Modify only. */
  protectedKeys?: ProtectedKey[];
}

export interface ApplyAiOutcome {
  clip: Clip;
  /** Human-readable summary of structural side effects (new bones/binds/restored
   *  protected keys) formatted for direct inclusion in a status string, e.g.
   *  " (+2 bones / bound 1 part)"; '' when nothing notable happened. */
  structural: string;
  /** How many protected keys actually needed correcting post-apply (0 = the model
   *  behaved and this was a no-op). Always 0 for mode 'new'. */
  restoredCount: number;
}

/**
 * Apply an AnimateResult to the doc: structural rig changes first (bones, auto-bind —
 * shared by both modes, see `applyStructuralRigChanges`), then either:
 *   - mode 'new': APPENDS a fresh clip (sanitized/deduped name via `sanitizeClipName`,
 *     e.g. "wave" → "wave 2") and switches the active clip to it — the same
 *     `doc.clips.push` + `state.activeClipIndex = doc.clips.length - 1` path the
 *     timeline's own "+ animation" button uses, so the clip dropdown picks it up for
 *     free. The clip passed as request CONTEXT is never touched.
 *   - mode 'modify': edits `opts.clip` (or the active clip) IN PLACE — duration pinned
 *     to the response's already-clamped value (never stretched), then any protected
 *     keys are restored (`enforceProtectedKeys`) as the belt-and-suspenders half of the
 *     "protect playhead keys" checkbox.
 * ONE checkpoint covers rig + clip, so a single undo reverts the whole AI edit. Returns
 * null only when there's no document (or, for 'modify' with no explicit `opts.clip`, no
 * active clip) to apply to — callers here always guard those cases before calling.
 *
 * Structured for AI Animate System v2's next phase (A2 preview-before-apply): once
 * results render as a preview instead of applying immediately, A2's Apply button calls
 * this SAME function — nothing about the apply path itself needs to change.
 */
export function applyAiResult(
  result: AnimateResult,
  mode: 'new' | 'modify',
  opts: ApplyAiOptions = {},
): ApplyAiOutcome | null {
  const doc = state.doc;
  if (!doc) return null;
  if (mode === 'modify' && !opts.clip && !activeClip()) return null;

  checkpoint(); // one undo step reverts the whole AI edit — rig changes included
  const { labelToId, notes } = applyStructuralRigChanges(doc, result);

  const tracks: Track[] = [];
  for (const t of result.clip.tracks) {
    const target = t.target === 'root' ? 'root' : labelToId.get(t.target);
    if (!target) continue;
    tracks.push({ target, channel: t.channel as Channel, keyframes: t.keyframes });
  }

  let clip: Clip;
  let restoredCount = 0;

  if (mode === 'new') {
    const name = sanitizeClipName(
      opts.clipName ?? result.clip.clipName ?? null,
      doc.clips.map((c) => c.name),
    );
    clip = { name, duration: result.clip.duration, tracks };
    doc.clips.push(clip);
    state.activeClipIndex = doc.clips.length - 1;
    state.currentTime = 0;
  } else {
    clip = opts.clip ?? activeClip()!;
    clip.duration = result.clip.duration; // pinned — clampRawClip already forced this
    clip.tracks = tracks;
    if (opts.protectedKeys?.length) {
      restoredCount = enforceProtectedKeys(clip, opts.protectedKeys);
      if (restoredCount > 0) {
        notes.push(`restored ${restoredCount} protected key${restoredCount === 1 ? '' : 's'}`);
      }
    }
  }

  return { clip, structural: notes.length ? ` (${notes.join(' / ')})` : '', restoredCount };
}

/**
 * Back-compat wrapper for the pre-A1 single "Animate current clip" behavior: modifies
 * the given clip in place, no clip-name/protection options. Kept because it's the
 * smallest, most obvious entry point for console/smoke-testing a fabricated response
 * (see the P5b live-verification note this replaced) — production UI now calls
 * `applyAiResult` directly from the two action buttons below.
 */
export function applyAnimateResult(clip: Clip | null, result: AnimateResult): string {
  if (!clip) return '';
  return applyAiResult(result, 'modify', { clip })?.structural ?? '';
}

/** Toggle the whole-editor inert overlay (pointer-events + dim) while a request runs.
 * `.ai-panel` opts back into pointer events (see ui.css) so Cancel stays clickable. */
function setEditorInert(active: boolean): void {
  document.getElementById('layout')?.classList.toggle('ai-busy', active);
}

/**
 * Panel state kept at module scope, not per-render closure: an inspector rebuild
 * (notify(), e.g. from a keyboard-driven selection change) can happen while a request
 * is in flight, and the busy UI / Cancel button must survive that rebuild intact.
 *
 * `promptText` joins that pattern (AI Animate System v2 A1): the textarea's content
 * must survive inspector rebuilds, editor-mode round trips (buildAiPanel simply isn't
 * called in Edit mode — the module state persists regardless of whether the DOM element
 * exists), and timeline view switches (curves/logic), all of which can fire notify() and
 * rebuild this panel from a blank slate. DECISION: cleared ONLY on a successful apply
 * (Create or Modify) — the user's wording is the thing most worth keeping around after a
 * failed or cancelled request, so both those paths leave it untouched; only a completed
 * edit "consumes" it. Critique doesn't touch it at all (it isn't a directive).
 */
interface AiPanelState {
  busy: boolean;
  status: string;
  promptText: string;
  critiqueText: string | null;
  abort: AbortController | null;
}
const ai: AiPanelState = {
  busy: false, status: '', promptText: '', critiqueText: null, abort: null,
};

export function buildAiPanel(el: HTMLElement): void {
  // Locked decision (v2.12 P5b): the assistant panel is Animate-only — choreographing
  // or critiquing a clip makes no sense while editing the character itself.
  if (state.editorMode !== 'animate') return;

  const box = document.createElement('div');
  box.className = 'ai-panel';
  box.innerHTML = '<h3>Animate with Claude</h3>';

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Anthropic API key (stored locally)';
  keyInput.value = localStorage.getItem('rig-studio-api-key') ?? '';
  keyInput.onchange = () => localStorage.setItem('rig-studio-api-key', keyInput.value.trim());
  box.appendChild(keyInput);

  const promptBox = document.createElement('textarea');
  promptBox.placeholder = 'e.g. "wave with the right arm", "bend at the knees then jump"';
  promptBox.rows = 3;
  promptBox.value = ai.promptText;
  promptBox.oninput = () => { ai.promptText = promptBox.value; };
  box.appendChild(promptBox);

  const shotLabel = document.createElement('label');
  shotLabel.className = 'field';
  const shotToggle = document.createElement('input');
  shotToggle.type = 'checkbox';
  shotToggle.checked = localStorage.getItem('rig-studio-attach-shot') !== '0';
  shotToggle.onchange = () =>
    localStorage.setItem('rig-studio-attach-shot', shotToggle.checked ? '1' : '0');
  const shotSpan = document.createElement('span');
  shotSpan.textContent = 'attach pose snapshot (current playhead)';
  const shotInfo = document.createElement('span');
  shotInfo.className = 'ai-info';
  shotInfo.textContent = 'ⓘ'; // circled "i"
  shotInfo.title =
    'Renders the canvas at the CURRENT PLAYHEAD TIME — exactly the pose showing on ' +
    'screen right now — and sends that image to Claude for visual grounding.';
  shotSpan.appendChild(document.createTextNode(' '));
  shotSpan.appendChild(shotInfo);
  shotLabel.appendChild(shotSpan);
  shotLabel.appendChild(shotToggle);
  box.appendChild(shotLabel);

  const rigLabel = document.createElement('label');
  rigLabel.className = 'field';
  const rigToggle = document.createElement('input');
  rigToggle.type = 'checkbox';
  rigToggle.checked = localStorage.getItem('rig-studio-allow-rig-edits') === '1';
  rigToggle.onchange = () =>
    localStorage.setItem('rig-studio-allow-rig-edits', rigToggle.checked ? '1' : '0');
  const rigSpan = document.createElement('span');
  rigSpan.textContent = 'allow rig changes (bones / parenting / pivots / auto-bind)';
  rigLabel.appendChild(rigSpan);
  rigLabel.appendChild(rigToggle);
  box.appendChild(rigLabel);

  const protectLabel = document.createElement('label');
  protectLabel.className = 'field';
  const protectToggle = document.createElement('input');
  protectToggle.type = 'checkbox';
  protectToggle.checked = localStorage.getItem('rig-studio-protect-playhead') === '1';
  protectToggle.onchange = () =>
    localStorage.setItem('rig-studio-protect-playhead', protectToggle.checked ? '1' : '0');
  const protectSpan = document.createElement('span');
  protectSpan.textContent = 'protect playhead keyframes (Modify) ';
  const protectInfo = document.createElement('span');
  protectInfo.className = 'ai-info';
  protectInfo.textContent = 'ⓘ';
  protectInfo.title =
    'Modify only. Locks every keyframe already at the current playhead time (across all ' +
    'tracks of this clip) so Claude cannot move, re-value, or remove them — enforced both ' +
    'in the prompt and by restoring them after the response is applied.';
  protectSpan.appendChild(protectInfo);
  protectLabel.appendChild(protectSpan);
  protectLabel.appendChild(protectToggle);
  box.appendChild(protectLabel);

  const status = document.createElement('p');
  status.className = 'hint';
  status.textContent = ai.status;
  box.appendChild(status);

  const busyRow = document.createElement('p');
  busyRow.className = 'hint ai-busy-indicator';
  busyRow.hidden = !ai.busy;
  const busyDot = document.createElement('span');
  busyDot.className = 'ai-busy-dot';
  const busyText = document.createElement('span');
  busyText.textContent = 'Waiting on Claude…';
  busyRow.appendChild(busyDot);
  busyRow.appendChild(busyText);
  box.appendChild(busyRow);

  const critiqueOut = document.createElement('div');
  critiqueOut.className = 'critique-out';
  critiqueOut.hidden = ai.critiqueText === null;
  if (ai.critiqueText) critiqueOut.textContent = ai.critiqueText;

  const requireCtx = (): { doc: NonNullable<typeof state.doc>; apiKey: string } | null => {
    const doc = state.doc;
    const apiKey = keyInput.value.trim();
    if (!doc || !activeClip()) return null;
    if (!apiKey) {
      status.textContent = 'Enter an API key first.';
      return null;
    }
    return { doc, apiKey };
  };

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create new animation';
  createBtn.title =
    'Ask Claude for a brand-new clip realizing this direction. The current clip is sent ' +
    'as reference context only — it is never modified.';
  const modifyBtn = document.createElement('button');
  modifyBtn.textContent = 'Modify current animation';
  modifyBtn.title = 'Ask Claude to edit the active clip in place.';
  const critique = document.createElement('button');
  critique.textContent = 'Critique this animation';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = !ai.busy;

  const setBusy = (busy: boolean): void => {
    keyInput.disabled = busy;
    promptBox.disabled = busy;
    shotToggle.disabled = busy;
    rigToggle.disabled = busy;
    protectToggle.disabled = busy;
    createBtn.disabled = busy;
    modifyBtn.disabled = busy;
    critique.disabled = busy;
    cancelBtn.hidden = !busy;
    busyRow.hidden = !busy;
    setEditorInert(busy);
  };
  setBusy(ai.busy); // reflect an in-flight request across a mid-request rebuild

  cancelBtn.onclick = () => ai.abort?.abort();

  const runAnimate = async (mode: 'new' | 'modify'): Promise<void> => {
    const ctxv = requireCtx();
    const clip = activeClip();
    if (!ctxv || !clip) return;
    if (!promptBox.value.trim()) {
      status.textContent = 'Describe the motion you want.';
      return;
    }
    const controller = new AbortController();
    ai.abort = controller;
    ai.busy = true;
    ai.status = mode === 'new'
      ? 'Creating a new animation… (this can take a minute)'
      : 'Choreographing… (this can take a minute)';
    status.textContent = ai.status;
    setBusy(true);
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;

      // "protect playhead keys" (Modify only): snapshot the current-frame keys BEFORE
      // the request — by part id (idProtected, for post-apply enforcement) and by
      // label (promptProtected, for the prompt text Claude actually reads).
      const idProtected: ProtectedKey[] =
        mode === 'modify' && protectToggle.checked
          ? snapshotProtectedKeys(clip, state.currentTime)
          : [];
      const labelOf = (id: string) => ctxv.doc.parts.find((p) => p.id === id)?.label ?? id;
      const promptProtected = idProtected.map((pk) => ({
        target: pk.target === 'root' ? 'root' : labelOf(pk.target),
        channel: pk.channel,
        time: pk.time,
        value: pk.value,
      }));

      const result = await animateWithClaude(
        ctxv.apiKey, ctxv.doc, clip, promptBox.value.trim(), state.selectedPartIds,
        {
          imageBase64: image,
          allowRigChanges: rigToggle.checked,
          mode,
          protectedKeys: promptProtected,
          signal: controller.signal,
        },
      );
      // The doc is untouched up to this point — an abort before this line leaves no
      // trace (checkpoint() only happens once applyAiResult starts applying).
      const outcome = applyAiResult(result, mode, {
        clip: mode === 'modify' ? clip : undefined,
        clipName: result.clip.clipName,
        protectedKeys: idProtected,
      });
      if (!outcome) throw new Error('No document loaded.');
      state.editorMode = 'animate';
      state.currentTime = 0;
      state.playing = true;
      const clampNote = result.clampedCount > 0
        ? ` (clamped ${result.clampedCount} out-of-range key time${result.clampedCount === 1 ? '' : 's'})`
        : '';
      ai.status = mode === 'new'
        ? `Done — created "${outcome.clip.name}" and switched to it${outcome.structural}${clampNote}.`
        : `Done — playing the result${outcome.structural}${clampNote}.`;
      // Clear the prompt only on a SUCCESSFUL apply — see AiPanelState's doc comment
      // for why errors/cancels leave it alone.
      ai.promptText = '';
      renderPose();
      document.dispatchEvent(new CustomEvent('rig-play'));
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
      // notify() rebuilds every panel (picks up ai.status + the idle control state);
      // it does not itself call renderPose(), matching the rest of this codebase's
      // "mutate + notify(), repaint separately when needed" convention. The success
      // path already repainted above; the failure/cancel paths change no doc state,
      // so no repaint is needed there.
      notify();
    }
  };

  createBtn.onclick = () => runAnimate('new');
  modifyBtn.onclick = () => runAnimate('modify');
  box.appendChild(createBtn);
  box.appendChild(modifyBtn);

  critique.onclick = async () => {
    const ctxv = requireCtx();
    const clip = activeClip();
    if (!ctxv || !clip) return;
    const controller = new AbortController();
    ai.abort = controller;
    ai.busy = true;
    ai.status = 'Reviewing the clip…';
    ai.critiqueText = null;
    status.textContent = ai.status;
    critiqueOut.hidden = true;
    setBusy(true);
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const text = await critiqueWithClaude(
        ctxv.apiKey, ctxv.doc, clip, state.selectedPartIds, image, controller.signal,
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
  };
  box.appendChild(critique);
  box.appendChild(cancelBtn);
  box.appendChild(critiqueOut);

  el.appendChild(box);
}
