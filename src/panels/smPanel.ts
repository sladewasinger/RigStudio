/**
 * State-machine editor + live preview — public facade.
 *
 * Swaps into the timeline's lanes area exactly like the curves editor does (a mutually-
 * exclusive "logic" toggle), and owns everything the feature needs so the view.ts
 * monolith stays untouched save one hook (`setPoseSampler`).
 *
 * Layout: a header row (machine selector / +machine / rename / delete / ▶ preview + live
 * status) over a two-column body — LEFT a draggable graph canvas of states & transitions,
 * RIGHT a stack of Inputs, the selected transition/state Properties, and Listeners.
 *
 * PREVIEW builds a pure SMInstance (stateMachine.ts), ticks it with real rAF frame deltas,
 * and drives the rendered pose through view.setPoseSampler. While it runs the inputs list
 * becomes LIVE controls and canvas pointer events over artwork are consumed (selection/drag
 * suppressed) and routed to the machine's listeners. Preview is APP state — never serialized.
 *
 * Implemented across `src/panels/sm/*`: `state.ts` (shared session `ctx` + generic DOM
 * helpers), `graphCamera.ts` (state-box geometry, SVG element helpers, and per-machine
 * pan/zoom viewport state), `graph.ts` (the draggable state graph canvas built on top of
 * it: boxes, transition arrows, click-click arming), `props.ts` (the right column's
 * selected state/transition Properties), `header.ts` (machine CRUD + the ▶ preview
 * button/status), `globals.ts` (the left column's Inputs/Listeners), `preview.ts` (the
 * ▶ preview engine: SMInstance + rAF loop + canvas listener dispatch + the
 * `window.__smPanel` debug hook), and `panel.ts` (the top-level orchestrator that
 * assembles the above into `buildSMPanel` and owns the Delete/Escape key hooks). This
 * file re-exports exactly the surface `main.ts` and `timeline/timeline.ts` consume;
 * nothing outside `src/panels/sm/` reaches past it into a submodule, and no submodule
 * imports this facade back.
 */

export { buildSMPanel, setLogicVisible, smHandleEscape, smHandleDelete } from './sm/panel';
export { stopPreview } from './sm/preview';
