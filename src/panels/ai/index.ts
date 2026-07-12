/**
 * The Claude animation assistant panel — public facade.
 *
 * Split across (AI Animate System v2 A4 "size-ratchet" wave): `state.ts` (the module-
 * scope panel state), `fields.ts` (static form DOM), `threadStrip.ts` + `threads.ts`
 * (per-clip refinement-thread UI + store), `requests.ts` (running a request against
 * Claude, incl. thread-context assembly), `preview.ts` (the A2 preview-before-apply
 * engine + A3 candidate filmstrip), `previewBar.ts` (the review card), `apply.ts`
 * (structural rig edits + committing a result to the doc), `panel.ts` (orchestrates all
 * of the above into `buildAiPanel`).
 *
 * Consumers (`panels/inspector.ts` via `./ai`, `main.ts` via `./panels/ai`) import ONLY
 * this facade — directory-index resolution keeps both import spellings working. No
 * submodule here imports this file back.
 */

export { buildAiPanel } from './panel';
export { applyAiResult, applyAnimateResult } from './apply';
export type { ApplyAiOptions, ApplyAiOutcome } from './apply';
export { aiHandleEscape } from './preview';
export { __setAnimateCallForTest } from './requests';
