/**
 * Keyframe selection & clipboard API (also driven by main.ts shortcuts), plus the
 * key-property row above the lanes: copy pose / select column / paste @ playhead,
 * and — for the current selection — time/value/easing editors and delete.
 */

import {
  state, notify, activeClip, deleteKeyframe, Track, Keyframe, EASINGS, Easing,
  copyKeys, pasteKeysAt, copyPoseAt, clipboardSize,
} from '../core/model';
import { renderPose } from '../view';
import { checkpoint } from '../core/history';
import { tlCtx, div, button } from './tlState';

// ---- Keyframe selection & clipboard (also driven by main.ts shortcuts) ----

export function hasKeySelection(): boolean {
  return tlCtx.selectedKeys.size > 0;
}

export function clearKeySelection(): void {
  tlCtx.selectedKeys.clear();
}

export function copySelectedKeys(): number {
  const entries = [...tlCtx.selectedKeys]
    .map((key) => ({ key, track: tlCtx.trackOfKey.get(key) }))
    .filter((e): e is { key: Keyframe; track: Track } => !!e.track);
  return copyKeys(entries.map(({ track, key }) => ({ track, key })));
}

export function pasteKeysAtPlayhead(): number {
  if (clipboardSize() === 0 || state.editorMode !== 'animate') return 0;
  checkpoint();
  const pasted = pasteKeysAt(Math.round(state.currentTime / 10) * 10);
  tlCtx.selectedKeys = new Set(pasted);
  notify();
  renderPose();
  return pasted.length;
}

export function deleteSelectedKeys(): void {
  if (tlCtx.selectedKeys.size === 0) return;
  checkpoint();
  for (const key of tlCtx.selectedKeys) {
    const track = tlCtx.trackOfKey.get(key);
    if (track) deleteKeyframe(track, key);
  }
  tlCtx.selectedKeys.clear();
  notify();
  renderPose();
}

/** Move the selected keys by dt ms. Returns false when nothing is selected. */
export function nudgeSelectedKeys(dt: number): boolean {
  if (tlCtx.selectedKeys.size === 0) return false;
  checkpoint();
  const clip = activeClip();
  for (const key of tlCtx.selectedKeys) {
    key.time = Math.max(0, Math.min(clip?.duration ?? Infinity, key.time + dt));
  }
  for (const key of tlCtx.selectedKeys) {
    tlCtx.trackOfKey.get(key)?.keyframes.sort((a, b) => a.time - b.time);
  }
  notify();
  renderPose();
  return true;
}

/** Select every keyframe at (±5 ms) the playhead — a column across all lanes. */
export function selectColumnAtPlayhead(): void {
  const clip = activeClip();
  if (!clip) return;
  tlCtx.selectedKeys.clear();
  for (const track of clip.tracks) {
    for (const key of track.keyframes) {
      if (Math.abs(key.time - state.currentTime) <= 5) tlCtx.selectedKeys.add(key);
    }
  }
  tlCtx.rerender();
}

/** Transient inline feedback in a bar (e.g. "copied pose (6 channels)"). */
function flash(host: HTMLElement, text: string): void {
  let el = host.querySelector<HTMLElement>('.tl-flash');
  if (!el) {
    el = document.createElement('span');
    el.className = 'tl-flash';
    host.appendChild(el);
  }
  el.textContent = text;
  setTimeout(() => el?.remove(), 1600);
}

/** The key-property row: copy pose / select column / paste @ playhead, and — for the
 *  current selection — time/value/easing editors plus delete. */
export function buildKeyBar(): HTMLElement {
  const keyBar = div('tl-keybar');
  keyBar.appendChild(button('copy pose', () => {
    const n = copyPoseAt(state.currentTime);
    flash(keyBar, n ? `copied pose (${n} channels)` : 'no animated channels');
  }));
  keyBar.appendChild(button('select column', selectColumnAtPlayhead));
  const pasteBtn = button('paste @ playhead', () => {
    const n = pasteKeysAtPlayhead();
    flash(keyBar, n ? `pasted ${n} key${n === 1 ? '' : 's'}` : 'clipboard empty');
  });
  pasteBtn.disabled = clipboardSize() === 0;
  keyBar.appendChild(pasteBtn);

  if (tlCtx.selectedKeys.size > 0) {
    const info = document.createElement('span');
    info.className = 'tl-keyinfo';
    info.textContent = `${tlCtx.selectedKeys.size} key${tlCtx.selectedKeys.size === 1 ? '' : 's'}`;
    keyBar.appendChild(info);

    if (tlCtx.selectedKeys.size === 1) {
      const key = [...tlCtx.selectedKeys][0];
      const timeIn = document.createElement('input');
      timeIn.type = 'number';
      timeIn.step = '10';
      timeIn.value = String(key.time);
      timeIn.title = 'Keyframe time (ms)';
      timeIn.onchange = () => {
        checkpoint();
        key.time = Math.max(0, Number(timeIn.value));
        tlCtx.trackOfKey.get(key)?.keyframes.sort((a, b) => a.time - b.time);
        notify();
        renderPose();
      };
      keyBar.appendChild(timeIn);

      const valIn = document.createElement('input');
      valIn.type = 'number';
      valIn.step = 'any';
      valIn.value = String(key.value);
      valIn.title = 'Keyframe value';
      valIn.onchange = () => {
        checkpoint();
        key.value = Number(valIn.value);
        notify();
        renderPose();
      };
      keyBar.appendChild(valIn);
    }

    const easingSel = document.createElement('select');
    easingSel.title = 'Easing of the segment arriving at the key';
    // The draw-order `z` channel samples STEPPED — easing/bezier are ignored for it — so
    // the dropdown is inert for an all-z selection. Disable it (with a why) rather than
    // let the user set an easing that silently does nothing.
    const allZ = [...tlCtx.selectedKeys].every((k) => tlCtx.trackOfKey.get(k)?.channel === 'z');
    if (allZ) {
      easingSel.disabled = true;
      easingSel.title = 'z is a stepped draw-order channel — easing does not apply to it.';
    }
    const values = new Set([...tlCtx.selectedKeys].map((k) => k.easing));
    if (values.size > 1) {
      const mixed = document.createElement('option');
      mixed.value = '';
      mixed.textContent = '(mixed)';
      mixed.selected = true;
      easingSel.appendChild(mixed);
    }
    for (const e of EASINGS) {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      if (values.size === 1 && values.has(e)) opt.selected = true;
      easingSel.appendChild(opt);
    }
    easingSel.onchange = () => {
      if (!easingSel.value) return;
      checkpoint();
      for (const key of tlCtx.selectedKeys) key.easing = easingSel.value as Easing;
      notify();
      renderPose();
    };
    keyBar.appendChild(easingSel);

    keyBar.appendChild(button('delete keys', deleteSelectedKeys));
  } else {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent =
      'Click a diamond to select · drag empty lane space to box-select · Ctrl+C/V copy/paste';
    keyBar.appendChild(hint);
  }
  return keyBar;
}
