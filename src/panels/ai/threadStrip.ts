/**
 * AI Animate System v2 A4: the compact per-clip refinement-thread strip shown under the
 * prompt box — turn count, last instruction preview, a clear-thread ✕. Reads the ACTIVE
 * clip fresh on every build (`./panel.ts` already rebuilds on notify(), which fires
 * whenever the timeline's clip dropdown changes `state.activeClipIndex` — no separate
 * subscription needed to "switch threads" when the user switches clips).
 */
import { activeClip, RigDoc, state } from '../../core/model';
import { dialog } from '../../ui/dialogs';
import { clearThread, getThread, sweepStaleThreads } from './threads';

/** Dedupes the stale-thread sweep to once per doc reference (see `./threads.ts`'s
 *  "Deletion sweep" doc comment) — a plain reference check mirrors `./preview.ts`'s
 *  `previewDocRef` pattern for detecting a doc swap without a main.ts hook. */
let sweptForDoc: RigDoc | null = null;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Builds the strip, or returns null when there's no doc/clip or no thread yet (no
 *  empty-strip clutter on a fresh clip). `onCleared` is called after a confirmed clear
 *  so `./panel.ts` can notify() and drop the strip from the next render. */
export function buildThreadStrip(onCleared: () => void): HTMLElement | null {
  const doc = state.doc;
  const clip = activeClip();
  if (!doc || !clip) return null;

  if (sweptForDoc !== doc) {
    sweepStaleThreads(doc.name, doc.clips.map((c) => c.name));
    sweptForDoc = doc;
  }

  const thread = getThread(doc.name, clip.name);
  if (!thread || thread.turns.length === 0) return null;

  const row = document.createElement('div');
  row.className = 'ai-thread-strip';

  const info = document.createElement('span');
  info.className = 'ai-thread-info';
  const last = thread.turns[thread.turns.length - 1];
  const count = thread.turns.length;
  info.textContent =
    `${count} refinement turn${count === 1 ? '' : 's'} — last: "${truncate(last.instruction, 60)}"`;
  row.appendChild(info);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'ai-thread-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = "Clear this clip's refinement thread (does not undo any applied edits).";
  clearBtn.onclick = async () => {
    const ok = await dialog.confirm(
      `Clear the refinement thread for "${clip.name}"? Future requests start fresh — already-applied edits are untouched.`,
      { title: 'Clear refinement thread', okText: 'Clear', danger: true },
    );
    if (!ok) return;
    clearThread(doc.name, clip.name);
    onCleared();
  };
  row.appendChild(clearBtn);

  return row;
}
