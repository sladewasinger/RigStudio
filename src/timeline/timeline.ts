/**
 * Keyframe timeline — public facade.
 *
 * Implemented across `src/timeline/*`: `tlState.ts` (shared session state — the tlCtx
 * object, generic DOM helpers, the fixed-height splitter shell, the playhead-scrub
 * util), `transport.ts` (play/pause/step/jump, speed, clip management, the keys/
 * curves/logic mode picker, ping-pong/onion toggles), `lanes.ts` (the scrubber ruler
 * and keyframe lanes — click/shift-click/marquee selection, retime drag), `keyProps.ts`
 * (the keyframe clipboard API plus the key-property row), and `panel.ts`
 * (`buildTimeline`/`render`, composing every cluster). This module re-exports the
 * surface the rest of the app (main.ts, the interaction test suite) consumes; nothing
 * outside `src/timeline/` reaches past it into a submodule. `timeline/graph.ts` (the
 * curve editor) is a separate, grandfathered module — untouched by this split.
 *
 * Keyframe timeline: clip selector, transport controls (speed, ping-pong, onion skin),
 * a scrubber ruler, and one lane per animated track with draggable keyframe diamonds.
 */

export { TIMELINE_HEIGHT_KEY } from './tlState';
export { buildTimeline, render } from './panel';
export { togglePlay } from './transport';
export {
  hasKeySelection, clearKeySelection, copySelectedKeys, pasteKeysAtPlayhead,
  deleteSelectedKeys, nudgeSelectedKeys, selectColumnAtPlayhead,
} from './keyProps';
