/**
 * The Claude animation assistant panel: choreograph the active clip from a natural-
 * language prompt, or critique it, optionally attaching a rendered snapshot of the
 * current pose for spatial grounding.
 */

import { state, notify, activeClip, applyRigChanges, Track, Channel } from '../core/model';
import { renderPose, registerPart } from '../view';
import { animateWithClaude, critiqueWithClaude } from '../ai/claude';
import { checkpoint } from '../core/history';

/**
 * Rasterize the current canvas (sans overlay/onion) to a PNG for the vision-grounded
 * assistant calls. Returns base64 image data (no data: prefix).
 */
async function snapshotPose(): Promise<string | null> {
  const live = document.getElementById('rig-svg') as SVGSVGElement | null;
  const doc = state.doc;
  if (!live || !doc) return null;
  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#overlay')?.remove();
  clone.querySelector('#onion')?.remove();
  // Full-document framing regardless of the user's current zoom.
  const { x, y, w, h } = doc.viewBox;
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  const outW = 512;
  const outH = Math.round((512 * h) / w);
  clone.setAttribute('width', String(outW));
  clone.setAttribute('height', String(outH));

  const svgText = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('snapshot render failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL('image/png').split(',')[1] ?? null;
}

export function buildAiPanel(el: HTMLElement): void {
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
  shotSpan.textContent = 'attach pose snapshot (vision)';
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
  rigSpan.textContent = 'allow rig changes (bones / parenting / pivots)';
  rigLabel.appendChild(rigSpan);
  rigLabel.appendChild(rigToggle);
  box.appendChild(rigLabel);

  const status = document.createElement('p');
  status.className = 'hint';
  box.appendChild(status);

  const critiqueOut = document.createElement('div');
  critiqueOut.className = 'critique-out';
  critiqueOut.hidden = true;

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
  go.onclick = async () => {
    const ctx = requireCtx();
    const clip = activeClip();
    if (!ctx || !clip) return;
    if (!promptBox.value.trim()) {
      status.textContent = 'Describe the motion you want.';
      return;
    }
    go.disabled = true;
    status.textContent = 'Choreographing… (this can take a minute)';
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const result = await animateWithClaude(
        ctx.apiKey, ctx.doc, clip, promptBox.value.trim(), image, rigToggle.checked,
      );
      checkpoint(); // one undo step reverts the whole AI edit — rig changes included
      let labelToId = new Map(ctx.doc.parts.map((p) => [p.label, p.id]));
      let structural = '';
      if (result.rig) {
        labelToId = applyRigChanges(result.rig);
        ctx.doc.parts.forEach(registerPart); // canvas groups for any new bones
        const added = result.rig.addBones?.length ?? 0;
        if (added > 0) structural = ` (+${added} bone${added === 1 ? '' : 's'})`;
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
      state.editorMode = 'animate';
      state.currentTime = 0;
      state.playing = true;
      status.textContent = `Done — playing the result${structural}.`;
      notify();
      renderPose();
      document.dispatchEvent(new CustomEvent('rig-play'));
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      go.disabled = false;
    }
  };
  box.appendChild(go);

  const critique = document.createElement('button');
  critique.textContent = 'Critique this animation';
  critique.onclick = async () => {
    const ctx = requireCtx();
    const clip = activeClip();
    if (!ctx || !clip) return;
    critique.disabled = true;
    status.textContent = 'Reviewing the clip…';
    critiqueOut.hidden = true;
    try {
      const image = shotToggle.checked ? await snapshotPose() : null;
      const text = await critiqueWithClaude(ctx.apiKey, ctx.doc, clip, image);
      critiqueOut.textContent = text;
      critiqueOut.hidden = false;
      status.textContent = '';
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      critique.disabled = false;
    }
  };
  box.appendChild(critique);
  box.appendChild(critiqueOut);

  el.appendChild(box);
}
