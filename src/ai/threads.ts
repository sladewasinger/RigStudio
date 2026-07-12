/**
 * AI Animate System v2 A4 "clip-scoped refinement threads": the pure request-block
 * builder. Kept OUT of `ai/claude.ts` (grandfathered at its size-ratchet ceiling —
 * CLAUDE.md "Small, focused files" — it may not grow by even one line) as a leaf
 * sibling module; `panels/ai/requests.ts` prepends this block's text to the user's
 * instruction before calling `animateWithClaude`, so the request contract in
 * `ai/claude.ts` itself needed zero changes.
 *
 * The STORE (turn recording, localStorage persistence, doc+clip keying) lives in
 * `panels/ai/threads.ts` instead — a panels/-layer concern (DOM-adjacent, UI-facing)
 * that imports this file's `ThreadContextTurn` shape but not vice versa.
 */

export interface ThreadContextTurn {
  instruction: string;
  mode: 'new' | 'modify';
  /** Compact "what changed" summary, e.g. "left_arm.rotate ×3, right_leg.ty ×2". */
  summary: string;
}

/**
 * Assemble the THREAD CONTEXT block prepended to a refinement request's instruction
 * text (`panels/ai/requests.ts`'s `runAnimate`, MODIFY mode only — see that file's
 * comment for why 'new' mode never has a target clip to key a thread under). Empty
 * input returns '' (no thread yet — the caller skips prepending anything). `retryNote`
 * (A2×A4 synergy): true when this request is itself a Retry — the model is told the
 * previous candidate was discarded/regenerated, not that it's an accepted prior turn,
 * so it doesn't double-count that attempt as "prior work" to preserve.
 */
export function buildThreadContextBlock(
  turns: ThreadContextTurn[],
  opts: { retryNote?: boolean } = {},
): string {
  if (turns.length === 0) return '';
  const lines = turns.map((t, i) => `${i + 1}. [${t.mode}] "${t.instruction}" -> ${t.summary}`);
  const parts = [
    'THREAD CONTEXT: this is an ongoing refinement conversation about this clip. Prior turns:',
    lines.join('\n'),
    'Apply the new instruction as an INCREMENT, preserving prior work unless the new ' +
      'instruction contradicts it.',
  ];
  if (opts.retryNote) {
    parts.push(
      'Note: the previous candidate shown to the user was just REGENERATED (discarded, not ' +
        'applied) — this is a fresh attempt at the SAME instruction below, not a new increment ' +
        'on top of it.',
    );
  }
  return parts.join('\n\n');
}
