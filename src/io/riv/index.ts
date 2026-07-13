/**
 * Pure re-export facade over `src/io/riv/`'s modules — consumers import ONLY `./io/riv`
 * (or `../io/riv`, `../../io/riv`), never a deep path. The .riv exporter is split into
 * `writer.ts` (binary primitives: ByteWriter/Scene/assemble), `keys.ts` (the Rive
 * typeKey/propertyKey table + shared enums/constants), `scene.ts` (the `exportRiv()`
 * entry point: Backboard/Artboard/Node-per-part + Shape/PointsPath geometry mapping,
 * incl. the draw-order reversal rule), `animation.ts` (keyframe channel planning +
 * LinearAnimation/KeyedObject/KeyedProperty/KeyFrame emission), and `stateMachine.ts`
 * (the state-machine object tree). Implementation modules never import this facade back.
 */

import { argb, exportRiv } from './scene';
import { cubicFor, toFrame } from './animation';
import { ByteWriter } from './writer';
import { COND_OP, EASING_CUBIC, FIELD_TYPE, LISTENER_TYPE } from './keys';

export { exportRiv };

/** @internal Exposed for unit tests only — not part of the public export surface. */
export const __riv = { ByteWriter, argb, toFrame, cubicFor, FIELD_TYPE, EASING_CUBIC, COND_OP, LISTENER_TYPE };
