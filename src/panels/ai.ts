/**
 * The Claude animation assistant panel: choreograph the active clip from a natural-
 * language prompt, or critique it, optionally attaching a rendered snapshot of the
 * current pose for spatial grounding. Animate-mode only (locked v2.12 P5b decision) —
 * posing/choreography against a clip makes no sense while editing the character itself.
 */

import {
  state, notify, activeClip, applyRigChanges, boneChain, Track, Channel, RigPart, Clip,
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
 * Apply a fabricated/real AnimateResult to the doc: structural rig changes (bones,
 * incl. Bones 2.0 auto-bind chains) then the clip's keyframe tracks, all under ONE
 * checkpoint so a single undo reverts everything. Exported for smoke-testing from the
 * browser console (see the P5b live-verification note) — production use is only via
 * the "Animate current clip" button below.
 */
export function applyAnimateResult(clip: Clip | null, result: AnimateResult): string {
  const doc = state.doc;
  if (!doc || !clip) return '';
  checkpoint(); // one undo step reverts the whole AI edit — rig changes included
  let labelToId = new Map(doc.parts.map((p) => [p.label, p.id]));
  let structural = '';
  if (result.rig) {
    labelToId = applyRigChanges(result.rig);
    doc.parts.forEach(registerPart); // canvas groups for any new bones
    const added = result.rig.addBones?.length ?? 0;
    if (added > 0) structural = ` (+${added} bone${added === 1 ? '' : 's'})`;

    // Bones 2.0: bind requested art parts to each new bone's full chain, inside the
    // SAME checkpoint as the placement + clip — one undo reverts all of it. Binding
    // can't live in model.applyRigChanges: it bakes geometry, which needs the live
    // canvas (bindPartsToBones), not just the doc.
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
    if (bound > 0) structural += ` / bound ${bound} part${bound === 1 ? '' : 's'}`;
  }

  // Resolve track targets (labels → ids) against the possibly-extended rig.
  const tracks: Track[] = [];
  for (const t of result.clip.tracks) {
    const target = t.target === 'root' ? 'root' : labelToId.get(t.target);
    if (!target) continue;
    tracks.push({ target, channel: t.channel as Channel, keyframes: t.keyframes });
  }
  clip.duration = result.clip.duration;
  clip.tracks = tracks;
  return structural;
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
 */
interface AiPanelState {
  busy: boolean;
  status: string;
  critiqueText: string | null;
  abort: AbortController | null;
}
const ai: AiPanelState = { busy: false, status: '', critiqueText: null, abort: null };

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

  const go = document.createElement('button');
  go.textContent = 'Animate current clip';
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
    go.disabled = busy;
    critique.disabled = busy;
    cancelBtn.hidden = !busy;
    busyRow.hidden = !busy;
    setEditorInert(busy);
  };
  setBusy(ai.busy); // reflect an in-flight request across a mid-request rebuild

  cancelBtn.onclick = () => ai.abort?.abort();

  go.onclick = async () => {
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
    ai.status = 'Choreographing… (this can take a minute)';
    status.textContent = ai.status;
    setBusy(true);
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const result = await animateWithClaude(
        ctxv.apiKey, ctxv.doc, clip, promptBox.value.trim(), state.selectedPartIds,
        image, rigToggle.checked, controller.signal,
      );
      // The doc is untouched up to this point — an abort before this line leaves no
      // trace (checkpoint() only happens once applyAnimateResult starts applying).
      const structural = applyAnimateResult(clip, result);
      state.editorMode = 'animate';
      state.currentTime = 0;
      state.playing = true;
      ai.status = `Done — playing the result${structural}.`;
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
  box.appendChild(go);

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
      setEditorInert(false); // see the go.onclick finally block for why this is unconditional
      notify();
    }
  };
  box.appendChild(critique);
  box.appendChild(cancelBtn);
  box.appendChild(critiqueOut);

  el.appendChild(box);
}
