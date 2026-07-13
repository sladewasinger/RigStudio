/**
 * In-memory doc sessions (ROADMAP H2): each MCP tool call operates on a named session
 * (`session` param, default "default") holding one `RigDoc`. Sessions live only for the
 * lifetime of this server process — nothing is persisted beyond what a tool explicitly
 * writes to disk (`save_project`/`export_riv`/...).
 *
 * SINGLETON CAVEAT (see `headless/index.ts`'s header and CLAUDE.md): much of core/
 * (`applyRigChanges`, `activeClip`, ...) reads/writes the shared `state` singleton
 * instead of taking a doc parameter. `headless/composePose.ts` already established the
 * pattern for a single call (save `state.doc`, point it at the doc in question, restore
 * in a `finally`); `withSession` below widens that to the FULL `state` object (every
 * field, not just `doc`) because tool bodies reach further into core/ than composePose's
 * narrow render path does — e.g. `applyRigChanges` resolves against `state.doc`,
 * `activeClip()` reads `state.activeClipIndex`. Safe with no locking because the MCP SDK's
 * stdio transport processes one JSON-RPC request at a time on a single Node event loop —
 * no second tool call's `fn` can start while this one is still running — so a plain
 * save/restore around each call is equivalent to a real per-session state, without
 * needing to thread `state` through every core/ function signature.
 */
import { AppState, normalizeDoc, RigDoc, state } from '../core/model';
import { McpToolError } from './errors';

const sessions = new Map<string, RigDoc>();

export function getSessionDoc(session: string): RigDoc | null {
  return sessions.get(session) ?? null;
}

export function setSessionDoc(session: string, doc: RigDoc): void {
  sessions.set(session, doc);
}

export function hasSession(session: string): boolean {
  return sessions.has(session);
}

export function listSessionNames(): string[] {
  return [...sessions.keys()];
}

/** Drop a session's doc. Returns whether one existed. */
export function clearSession(session: string): boolean {
  return sessions.delete(session);
}

export function requireSessionDoc(session: string): RigDoc {
  const doc = sessions.get(session);
  if (!doc) {
    throw new McpToolError(
      `Unknown session "${session}" — call import_svg or load_project with session: "${session}" first.`,
    );
  }
  return doc;
}

/**
 * Read-only access to a session's doc (list_parts, analyze_rig, save_project, the
 * exporters, ...): no `state` swap needed since these callers only read `doc` directly.
 * Throws McpToolError for an unknown session — every read tool wants that same message.
 */
export function withSessionDoc<T>(session: string, fn: (doc: RigDoc) => T): T {
  return fn(requireSessionDoc(session));
}

/**
 * Mutating access (add_bones, apply_clip, add_state_machine, ...): points the `state`
 * singleton at the session's doc for the duration of `fn`, with sensible per-call
 * defaults for the fields core/ functions read besides `doc` (selection cleared,
 * `activeClipIndex` reset to 0 so `activeClip()` resolves the doc's first clip unless the
 * caller's own logic switches it), then restores every field of the PRIOR `state` object
 * — whether `fn` throws or returns — so a tool call can never bleed into the next one or
 * (if this module were ever imported alongside the live editor) into the app itself.
 * `fn` receives the doc directly so handlers don't have to re-fetch it through `state`.
 *
 * On a successful `fn`, the doc is run back through `normalizeDoc` before returning — the
 * SAME repair pass `deserializeDoc`/`rig import` already apply, run here too because
 * structural helpers like `addNullPart` mint a part without ever setting every
 * back-compat-defaulted field (e.g. `skin` stays `undefined`, not `null`) the way a
 * loaded/imported doc always has. Skipping this would make the session doc's OWN later
 * `serializeDoc` → `deserializeDoc` round-trip (what `validate` checks, and what actually
 * happens on `save_project` + a later `load_project`) non-byte-stable — not a real
 * correctness bug, just undefaulted fields, but exactly the drift `validate` exists to
 * catch, so tools stay honest about it by construction instead of by convention.
 */
export function withSessionMutation<T>(session: string, fn: (doc: RigDoc) => T): T {
  const doc = requireSessionDoc(session);
  const snapshot: AppState = { ...state };
  Object.assign(state, {
    doc,
    selectedPartId: null,
    selectedPartIds: [],
    selectedPathId: null,
    activeClipIndex: 0,
    currentTime: 0,
  });
  try {
    const result = fn(doc);
    normalizeDoc(doc);
    return result;
  } finally {
    Object.assign(state, snapshot);
  }
}
