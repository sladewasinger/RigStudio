/**
 * Pure re-export facade over `src/panels/inspectorSections/` — consumers (the
 * `panels/` facade) import ONLY `./inspector`, never a deep path. The inspector's
 * responsibilities are split across: `inspectorSections/shared.ts` (field/row
 * builders — number/keyable/color fields, the parent selector, the repaint helper),
 * `inspectorSections/transformSection.ts` (per-part rest/keyed transform fields +
 * the Setup-only root pivot section), `inspectorSections/boneSection.ts` (the bone
 * position model — rotation/length/position with freeze-mode bind refresh),
 * `inspectorSections/stackingSection.ts` (the Edit-mode draw-order stacking row),
 * `inspectorSections/skinSection.ts` (the skinning summary + per-node binding
 * editor), `inspectorSections/alignSection.ts` (align & distribute),
 * `inspectorSections/nodeOpsSection.ts` (node-editing ops incl. the "bind to
 * bone…" dialog), `inspectorSections/objectSection.ts` (path fill/stroke style +
 * the artboard section), and `inspectorSections/panel.ts` (`buildInspector` itself,
 * which orchestrates all of the above).
 */
export { buildInspector } from './inspectorSections/panel';
