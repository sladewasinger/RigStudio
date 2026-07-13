/**
 * Headless package entry (ROADMAP H1: "rig-studio-core headless package + CLI",
 * wave H1a) — the DOM-free public surface for scripts and agents (e.g. Claude Code in
 * a shell) to create/edit/sample/export RigDocs without the browser editor.
 *
 * Re-exports:
 *   - `core/model`'s ENTIRE surface: doc types (RigDoc/RigPart/RigPath/Clip/Track/
 *     Keyframe/Channel/Easing/...), serialization (serializeDoc/deserializeDoc/
 *     normalizeDoc/newBlankDoc), channel sampling/writing (sampleChannel/channelValue/
 *     the setKeyframe family), structural ops (applyRigChanges/deleteParts/
 *     duplicateParts/drawOrder), bone/part hierarchy (boneChain/setParent/groupParts),
 *     and the app-state singleton (`state`) that some of those functions read or
 *     write — e.g. `applyRigChanges` mutates `state.doc`, so a script sets
 *     `state.doc = doc` before calling it, exactly like the editor's own call sites do.
 *   - `core/stateMachine`'s pure evaluator (`createSMInstance`) for driving state
 *     machines outside the canvas preview.
 *   - Both exporters (`exportRiv`, `exportLottie`), unchanged from their editor use.
 *   - `importSvgHeadless` (below), a jsdom-backed stand-in for the browser's global
 *     `DOMParser` that `io/importSvg.ts` needs — the importer itself is untouched.
 *
 * `core/`, `geometry/`, and `io/` are already DOM-free (the unit suite runs them
 * under plain Node) — this file is a pure re-export facade over that existing surface
 * (see CLAUDE.md's "facade pattern for wide surfaces"), not new logic. Neither this
 * file nor anything it (transitively) imports may reach `src/view`, `src/panels`,
 * `src/timeline`, or `src/ui` — enforced by
 * `src/__tests__/headlessBoundary.test.ts`, which walks the import graph. The web
 * app (`src/main.ts`) never imports `src/headless`, so this facade — and the jsdom
 * dependency `importSvgHeadless` pulls in — never reaches the Vite bundle.
 */
export * from '../core/model';
export * from '../core/stateMachine';
export { exportRiv } from '../io/riv';
export { exportLottie } from '../io/exportLottie';
export { importSvgHeadless } from './importSvgHeadless';
