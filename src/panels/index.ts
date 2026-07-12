/**
 * Side panels — public facade.
 *
 * Implemented across `src/panels/*`: `icons.ts` (the inline SVG icon set), `layers.ts`
 * (the folder-style part/path tree with drag-to-parent), `inspector.ts` (rest/pivot/
 * parent fields in Setup, keyed channel fields in Animate, plus skinning/align/node-op/
 * object sections — node ops includes the "bind to bone…" quick action), `ai.ts` (the
 * Claude assistant panel, mounted at the bottom of the inspector), and `canvasTools.ts`
 * (the tool switcher + snap toggle + flip/group/ungroup/bone actions shown above the
 * canvas). `smPanel.ts` (the state-machine editor) lives alongside these but is imported
 * directly by its consumers (main, timeline), not re-exported here.
 *
 * This module re-exports the surface that the rest of the app (main.ts, the interaction
 * test suite) consumes; nothing outside `src/panels/` reaches past it into a submodule.
 */

export { buildCanvasTools, flipAction, groupAction, ungroupAction } from './canvasTools';
export { buildLayersPanel } from './layers';
export { buildInspector } from './inspector';
