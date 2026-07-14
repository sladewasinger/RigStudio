// ---- Project save/load, doc-factory functions, and back-compat normalization ----

import { Mat } from '../geometry/transforms';
import { Artboard, EASINGS, RigDoc, SkinBone, Vec2 } from './docTypes';
import { SMState, StateMachine } from './smTypes';
import { healDegenerateBoneTip } from './boneOps';
import { canonicalizePartOrder } from './structuralOps';
import { reconcileChildOrder } from './childOrder';
import { bumpIdCounter, freshId } from './idGen';

/**
 * A fresh state machine with exactly the mandatory 'entry', 'any', and 'exit' nodes
 * (Rive rejects a layer missing any of the three as corrupt) and no clips wired yet.
 * The one place machines are minted, so the invariant holds from birth (normalizeDoc
 * re-establishes it on load). Exit gets a seeded position to the right of the default
 * entry/any/animation layout (smPanel's `ensureLayout` mirrors this for machines that
 * gain an exit later without a stored position, e.g. old projects via normalizeDoc).
 */
export function newStateMachine(name: string): StateMachine {
  return {
    id: freshId('sm'),
    name,
    inputs: [],
    states: [
      { id: freshId('state'), name: 'Entry', kind: 'entry' },
      { id: freshId('state'), name: 'Any', kind: 'any' },
      { id: freshId('state'), name: 'Exit', kind: 'exit', x: 520, y: 44 },
    ],
    transitions: [],
    listeners: [],
  };
}

/**
 * Turn a model-proposed clip name into a safe, unique one for the "Create new animation"
 * button: trims/collapses whitespace, falls back to a generic name when blank, then
 * de-dupes against `existing` clip names the way a file manager does — "wave", "wave 2",
 * "wave 3" — matching case-insensitively so "Wave" doesn't silently collide with "wave".
 */
export function sanitizeClipName(raw: string | null | undefined, existing: string[]): string {
  let base = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!base) base = 'New animation';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

// ---- Artboard ----

/**
 * Guarantee doc.artboard exists, seeding it (disabled) from the current viewBox on
 * first access. Idempotent; used by editing code (inspector) that needs a mutable
 * rect to read/write regardless of whether normalizeDoc has run yet (fresh SVG
 * imports never go through it — same defensive-seed pattern as doc.stateMachines).
 */
export function ensureArtboard(doc: RigDoc): Artboard {
  if (!doc.artboard) {
    doc.artboard = { enabled: false, x: doc.viewBox.x, y: doc.viewBox.y, w: doc.viewBox.w, h: doc.viewBox.h };
  }
  return doc.artboard;
}

/**
 * The effective page frame for rendering/export: the artboard rect when enabled,
 * else the viewBox (today's behavior). Pure — never mutates doc, so exporters and
 * render code can call it without an ensureArtboard() side effect.
 */
export function artboardFrame(doc: RigDoc): { x: number; y: number; w: number; h: number } {
  const ab = doc.artboard;
  if (ab && ab.enabled) return { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
  return { x: doc.viewBox.x, y: doc.viewBox.y, w: doc.viewBox.w, h: doc.viewBox.h };
}

// ---- New document ----

/**
 * A fresh, empty document for File → New: no parts, one 2 s 'idle' clip, a 512×512
 * viewBox with a matching ENABLED artboard, and no state machines. Run through
 * normalizeDoc so every back-compat default is filled exactly as a loaded file would be,
 * then loaded through the same afterDocReplaced path Open uses.
 */
export function newBlankDoc(): RigDoc {
  return normalizeDoc({
    name: 'untitled',
    viewBox: { x: 0, y: 0, w: 512, h: 512 },
    parts: [],
    rootPivot: { x: 256, y: 256 },
    clips: [{ name: 'idle', duration: 2000, tracks: [] }],
    stateMachines: [],
    artboard: { enabled: true, x: 0, y: 0, w: 512, h: 512 },
  });
}

// ---- Serialization (project save/load) ----

const DOC_FORMAT = 'rig-studio';
const DOC_VERSION = 2;

export function serializeDoc(doc: RigDoc): string {
  return JSON.stringify({ format: DOC_FORMAT, version: DOC_VERSION, doc }, null, 1);
}

/**
 * Parse a saved project (current or older format) into a usable RigDoc, filling in
 * fields that did not exist when the file was written.
 */
export function deserializeDoc(json: string): RigDoc {
  const raw = JSON.parse(json) as { format?: string; version?: number; doc?: unknown };
  const doc = (raw && typeof raw === 'object' && 'doc' in raw ? raw.doc : raw) as RigDoc;
  if (!doc || !Array.isArray(doc.parts) || !doc.viewBox) {
    throw new Error('Not a Rig Studio project file');
  }
  return normalizeDoc(doc);
}

function isFiniteMat(m: unknown): m is Mat {
  if (!m || typeof m !== 'object') return false;
  const mm = m as Record<string, unknown>;
  return (['a', 'b', 'c', 'd', 'e', 'f'] as const).every(
    (k) => typeof mm[k] === 'number' && Number.isFinite(mm[k] as number),
  );
}

function isFiniteVec2(v: unknown): v is Vec2 {
  if (!v || typeof v !== 'object') return false;
  const vv = v as Record<string, unknown>;
  return (
    typeof vv.x === 'number' && Number.isFinite(vv.x)
    && typeof vv.y === 'number' && Number.isFinite(vv.y)
  );
}

/** Shape/finiteness check for one SkinBone bind record (normalizeDoc healing). */
function isValidSkinBone(b: unknown): b is SkinBone {
  if (!b || typeof b !== 'object') return false;
  const bb = b as Record<string, unknown>;
  if (typeof bb.id !== 'string' || !isFiniteMat(bb.restWorldInv)) return false;
  const seg = bb.bindSeg as Record<string, unknown> | undefined;
  return !!seg && isFiniteVec2(seg.p) && isFiniteVec2(seg.q);
}

/** Fill defaults for fields added after a document was serialized. */
export function normalizeDoc(doc: RigDoc): RigDoc {
  let maxId = 0;
  const trackId = (id: string) => {
    const m = /_(\d+)$/.exec(id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  };
  for (const part of doc.parts) {
    trackId(part.id);
    part.kind = part.kind ?? 'art';
    part.rest = part.rest ?? { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 };
    part.rest.sx = part.rest.sx ?? 1;
    part.rest.sy = part.rest.sy ?? 1;
    part.rest.kx = part.rest.kx ?? 0;
    part.rest.ky = part.rest.ky ?? 0;
    part.rest.opacity = Number.isFinite(part.rest.opacity)
      ? Math.min(1, Math.max(0, part.rest.opacity))
      : 1;
    // Layers eye: keep it a clean true/undefined (never keyable — see the field's doc
    // comment) so a hand-edited or legacy file can't smuggle a truthy-but-wrong-typed
    // value through to render.ts's display:none-equivalent toggle.
    part.hidden = part.hidden === true ? true : undefined;
    // Unified Skeleton attach flag: same clean true/undefined treatment as `hidden`
    // above; the STRUCTURAL half of the repair (parent must actually resolve to a bone)
    // runs below once `boneKindIds` exists.
    part.attachedRoot = part.attachedRoot === true ? true : undefined;
    part.parentId = part.parentId ?? null;
    part.boneTip = part.boneTip ?? null;
    healDegenerateBoneTip(part); // heals a present-but-degenerate tip in place; a no-op
    // for boneTip:null (nothing to heal) or an already-usable tip.
    part.skin = part.skin ?? null;
    if (part.skin && !Array.isArray(part.skin.bones)) part.skin = null;
    part.pivotHint = part.pivotHint ?? null;
    part.paths.forEach((p, i) => {
      trackId(p.id);
      p.label = p.label ?? `path_${i + 1}`;
      if (p.nodeTypes != null && typeof p.nodeTypes !== 'string') p.nodeTypes = null;
    });
  }
  // Drop dangling parent references (e.g. hand-edited files).
  const ids = new Set(doc.parts.map((p) => p.id));
  const boneKindIds = new Set(doc.parts.filter((p) => p.kind === 'bone').map((p) => p.id));
  for (const part of doc.parts) {
    if (part.parentId && !ids.has(part.parentId)) part.parentId = null;
    // Unified Skeleton: `attachedRoot` is only meaningful on a bone whose parent
    // resolves to ANOTHER bone (a cross-chain attach) — a hand-edited file, or one from
    // before the parent link above was repaired, could carry it on a part whose parent
    // is missing/non-bone/absent; `boneChain` would otherwise treat it as an orphaned
    // "root of nothing" rather than falling back to the plain hierarchy it actually is.
    if (part.attachedRoot && (part.kind !== 'bone' || !part.parentId || !boneKindIds.has(part.parentId))) {
      part.attachedRoot = undefined;
    }
    if (part.skin) {
      // Drop a skin.bones entry when its id doesn't resolve to a BONE part (missing
      // entirely, or retyped/ungrouped away from kind:'bone' since bind time) or its
      // bind record is malformed/non-finite (hand-edited file, or a corrupted
      // in-session mutation that reached save) — any of those would poison the
      // per-frame LBS math. render.ts's render-time resilience net catches the LIVE
      // (un-saved) version of this; this is the load-time equivalent.
      part.skin.bones = part.skin.bones.filter((b) => boneKindIds.has(b.id) && isValidSkinBone(b));
      if (part.skin.bones.length === 0) part.skin = null;
    }
    // Prune per-node weight overrides: drop entries whose bone refs no longer resolve
    // to a bound bone, or whose blend factor is non-finite; clamp t/pin into [0,1].
    // `a === null` is a valid PIN-ONLY entry (no bone-choice override, just a pin) —
    // see SkinOverride's doc comment — so it is NOT itself grounds for dropping.
    if (part.skin && part.skin.overrides) {
      const boneIds = new Set(part.skin.bones.map((b) => b.id));
      for (const pathId of Object.keys(part.skin.overrides)) {
        const rec = part.skin.overrides[pathId];
        for (const key of Object.keys(rec)) {
          const ov = rec[key];
          const aOk = !!ov && (ov.a == null || (typeof ov.a === 'string' && boneIds.has(ov.a)));
          const bOk = !!ov && (ov.b == null || boneIds.has(ov.b));
          const tOk = !!ov && Number.isFinite(ov.t);
          const pinPresent = !!ov && ov.pin !== undefined && ov.pin !== null;
          const pinOk = !pinPresent || Number.isFinite(ov.pin);
          if (!ov || !aOk || !bOk || !tOk || !pinOk) { delete rec[key]; continue; }
          ov.t = Math.min(1, Math.max(0, ov.t));
          if (pinPresent) ov.pin = Math.min(1, Math.max(0, ov.pin!));
          if (ov.a == null) {
            // No bone-choice override — b/t carry no meaning without a; keep the shape
            // canonical rather than letting a hand-edited file smuggle a stray b/t
            // through unused.
            ov.b = null;
            ov.t = 0;
            // A pin-only entry with no pin left (0/absent) carries no information at
            // all — drop it so a doc round-trip doesn't accumulate empty overrides.
            if (!(ov.pin! > 0)) { delete rec[key]; continue; }
          }
        }
        if (Object.keys(rec).length === 0) delete part.skin.overrides[pathId];
      }
      if (Object.keys(part.skin.overrides).length === 0) delete part.skin.overrides;
    }
  }
  // Canonical paint order (CLAUDE.md "Layer order IS z-order"): every part's own index
  // must precede its whole, contiguous descendant block. Legacy files predate this
  // invariant, and a hand-edited one can violate it outright — repair it here, AFTER the
  // dangling-parentId repair just above so a stray reference doesn't fool the canonicalizer
  // into treating a should-be-root part as an orphaned cycle member. A no-op (returns the
  // same order) on any doc that's already canonical, which includes every doc produced by
  // the editor itself and by importSvg's depth-first registration.
  doc.parts = canonicalizePartOrder(doc.parts);
  // Unified child ordering (U1): synthesize an absent childOrder (own paths[] order then
  // direct doc.parts-sibling children — exactly today's two-bucket paint order, so an
  // old file renders identically) and repair a present one (drop dangling/duplicate
  // slots, re-derive each kind's relative order from its authority, append anything
  // missing) — see core/childOrder.ts's reconcileChildOrder. Runs AFTER the dangling-
  // parentId repair and canonicalizePartOrder above, so both authorities it reads
  // (paths[], the parentId graph) are already trustworthy.
  for (const part of doc.parts) reconcileChildOrder(part, doc.parts);
  doc.clips = doc.clips?.length ? doc.clips : [{ name: 'idle', duration: 2000, tracks: [] }];
  for (const clip of doc.clips) {
    // Loop lives on the CLIP (v2.12; moved off SMState — see the legacy-migration block
    // below and the Clip.loop doc comment). Default true, written explicitly so every
    // normalized doc carries a real boolean, matching the rest.sx/kind-style back-compat
    // fields above rather than leaving it silently absent.
    clip.loop = clip.loop ?? true;
    for (const track of clip.tracks) {
      for (const k of track.keyframes) {
        if (!EASINGS.includes(k.easing)) k.easing = 'easeInOut';
        if (k.bezier != null) {
          const b = k.bezier;
          const ok =
            Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n));
          if (!ok) k.bezier = null;
          else {
            b[0] = Math.min(1, Math.max(0, b[0]));
            b[2] = Math.min(1, Math.max(0, b[2]));
          }
        }
      }
    }
  }
  // Artboard: absent on older docs (and on fresh SVG imports, which never ran through
  // normalizeDoc) — seed disabled from the current viewBox so it's a pure no-op until
  // opted into. A present-but-corrupt rect (hand-edited file, non-positive w/h) falls
  // back to the viewBox per axis rather than getting dropped wholesale.
  // Project frame rate: seed 60 (the exporters' old hardcoded constant) so an absent
  // value round-trips byte-identically, and repair a hand-edited/corrupt one the same way.
  if (!Number.isFinite(doc.fps) || doc.fps! <= 0) doc.fps = 60;

  ensureArtboard(doc);
  doc.artboard!.enabled = !!doc.artboard!.enabled;
  if (!Number.isFinite(doc.artboard!.x)) doc.artboard!.x = doc.viewBox.x;
  if (!Number.isFinite(doc.artboard!.y)) doc.artboard!.y = doc.viewBox.y;
  if (!(Number.isFinite(doc.artboard!.w) && doc.artboard!.w > 0)) doc.artboard!.w = doc.viewBox.w;
  if (!(Number.isFinite(doc.artboard!.h) && doc.artboard!.h > 0)) doc.artboard!.h = doc.viewBox.h;

  // State machines: default to none on old files; per machine re-establish the
  // entry/any/exit invariant and prune dangling references, but KEEP a state whose
  // clipName no longer resolves — the evaluator treats it as rest pose, so deleting a
  // clip must not silently destroy a graph.
  doc.stateMachines = Array.isArray(doc.stateMachines) ? doc.stateMachines : [];
  for (const sm of doc.stateMachines) {
    trackId(sm.id);
    for (const inp of sm.inputs ?? []) trackId(inp.id);
    for (const st of sm.states ?? []) trackId(st.id);
    for (const tr of sm.transitions ?? []) trackId(tr.id);
    for (const ls of sm.listeners ?? []) trackId(ls.id);
  }
  // Get idCounter past every loaded id before minting any fresh entry/any/exit nodes.
  bumpIdCounter(maxId);
  const partIds = new Set(doc.parts.map((p) => p.id));
  for (const sm of doc.stateMachines) {
    sm.inputs = Array.isArray(sm.inputs) ? sm.inputs : [];
    sm.states = Array.isArray(sm.states) ? sm.states : [];
    sm.transitions = Array.isArray(sm.transitions) ? sm.transitions : [];
    sm.listeners = Array.isArray(sm.listeners) ? sm.listeners : [];
    // Legacy SMState.loop -> Clip.loop migration (v2.12): a pre-migration state with an
    // explicit `loop === false` marks its referenced clip non-looping (best-effort — if
    // two legacy states pointed at the same clip with conflicting loop flags, whichever
    // is processed last wins). The field itself never re-serializes: it is stripped off
    // every state regardless of whether it triggered a migration, since SMState no
    // longer declares it.
    for (const st of sm.states) {
      const legacy = st as SMState & { loop?: boolean };
      if (legacy.loop === false && legacy.kind === 'animation' && legacy.clipName) {
        const target = doc.clips.find((c) => c.name === legacy.clipName);
        if (target) target.loop = false;
      }
      delete legacy.loop;
    }
    if (!sm.states.some((s) => s.kind === 'entry')) {
      sm.states.unshift({ id: freshId('state'), name: 'Entry', kind: 'entry' });
    }
    if (!sm.states.some((s) => s.kind === 'any')) {
      sm.states.push({ id: freshId('state'), name: 'Any', kind: 'any' });
    }
    if (!sm.states.some((s) => s.kind === 'exit')) {
      sm.states.push({ id: freshId('state'), name: 'Exit', kind: 'exit' });
    }
    const stateIds = new Set(sm.states.map((s) => s.id));
    const stateKind = new Map(sm.states.map((s) => [s.id, s.kind]));
    const inputIds = new Set(sm.inputs.map((i) => i.id));
    // Drop the WHOLE transition when its endpoints don't resolve, OR when ANY of its
    // conditions references an input that no longer exists. The evaluator's
    // conditionPasses() returns false for an unresolved input (see stateMachine.ts), so a
    // transition carrying a dangling condition can NEVER fire — it is permanently blocked,
    // not "the other conditions still apply". The old behavior silently stripped just the
    // bad condition, which meant a transition with e.g. one dangling + one valid condition
    // would survive save/reload holding ONLY the valid one — turning a never-fires
    // transition into a fires-whenever-that-one-condition-is-true transition, and a
    // transition whose ONLY condition dangled would come back fully UNCONDITIONAL. Both are
    // silent behavior changes on a file that never touched the editor. Dropping the whole
    // transition instead matches the evaluator's never-fire semantics exactly. Listener
    // actions keep the old strip-in-place pruning (below): an action-less listener is inert
    // but harmless (and now visibly warned in the editor), so there is no equivalent
    // meaning-flip risk.
    sm.transitions = sm.transitions.filter((t) => {
      if (!stateIds.has(t.fromId) || !stateIds.has(t.toId)) return false;
      const conds = Array.isArray(t.conditions) ? t.conditions : [];
      return conds.every((c) => inputIds.has(c.inputId));
    });
    for (const t of sm.transitions) {
      t.durationMs = Math.max(0, Number.isFinite(t.durationMs) ? t.durationMs : 0);
      t.conditions = Array.isArray(t.conditions) ? t.conditions : [];
      // Exit time is only meaningful leaving an ANIMATION state. Clamp a present value
      // into [0,1]; strip it (→ null) from non-animation fromIds or a non-finite value.
      // Absent stays absent (no serialization change for docs that never set it).
      if (t.exitFraction !== null && t.exitFraction !== undefined) {
        if (stateKind.get(t.fromId) !== 'animation' || !Number.isFinite(t.exitFraction)) {
          t.exitFraction = null;
        } else {
          t.exitFraction = Math.min(1, Math.max(0, t.exitFraction));
        }
      }
    }
    sm.listeners = sm.listeners.filter((l) => partIds.has(l.targetPartId));
    for (const l of sm.listeners) {
      l.actions = Array.isArray(l.actions)
        ? l.actions.filter((a) => inputIds.has(a.inputId))
        : [];
    }
  }
  bumpIdCounter(maxId);
  return doc;
}
