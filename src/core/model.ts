/**
 * Document model and application state for Rig Studio — PURE RE-EXPORT FACADE.
 *
 * This file is imported everywhere as `../core/model` / `../../core/model`; that path
 * must keep working unchanged, so the implementation lives in sibling modules and this
 * file only re-exports their public surface (the `view/index.ts` facade pattern — see
 * CLAUDE.md "The facade pattern for wide surfaces"). Consumers should keep importing
 * `./model`; implementation modules never import this file back.
 *
 *   docTypes.ts       — RigDoc/RigPart/RigPath/Clip/Track/Keyframe/Channel/Easing/
 *                        Artboard types, CHANNEL_DEFAULTS.
 *   smTypes.ts        — state-machine types (SMInput/SMState/SMTransition/SMListener/...).
 *   appState.ts       — the app-state singleton, pub/sub, selection helpers.
 *   channels.ts       — keyframe sampling/writing, easing math, AI protected-key guard,
 *                        the keyframe clipboard.
 *   boneOps.ts        — bone chain resolution and the root-position/child-length model.
 *   partHierarchy.ts  — ancestor/parent queries, group/ungroup.
 *   structuralOps.ts  — AI rig-change application, delete/duplicate, draw order.
 *   serialization.ts  — serializeDoc/deserializeDoc/normalizeDoc, doc/state-machine
 *                        factories, the artboard frame helpers.
 *   childOrder.ts     — the U1 unified-child-ordering CHOKEPOINT: slotAddPath/
 *                        slotRemovePath/slotAddChild/slotRemoveChild/slotMoveWithin/
 *                        reconcileChildOrder (+ U4's beginExplicitChildOrder for the
 *                        importer), plus the effectiveChildOrder / reassignKindOrder
 *                        reads and the isChildOrderCoherent /
 *                        childOrderAgreesWithCanonicalPartOrder integrity predicates.
 *   slotReorder.ts    — U4: moveChildSlot, the slot-space reorder op behind the Layers
 *                        drag, PageUp/PageDown and the stacking arrows (slot moves
 *                        first, then re-derives the paths[]/doc.parts authorities).
 *   paintOrder.ts     — U2: flattenPaintOrder, the pure childOrder → paint-sequence
 *                        algorithm shared by the live canvas and headless composePose.
 *   idGen.ts          — freshId/bumpIdCounter, shared by every module above.
 */

export * from './docTypes';
export * from './smTypes';
export * from './appState';
export * from './channels';
export * from './boneOps';
export * from './partHierarchy';
export * from './structuralOps';
export * from './serialization';
export * from './childOrder';
export * from './slotReorder';
export * from './paintOrder';
export * from './idGen';
