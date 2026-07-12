/**
 * AI Animate System v2 A5 "Rig Profile": a cheap, heuristic, rig-AGNOSTIC analysis of
 * `doc.parts` — pure data in, pure data out, NO DOM — that motion templates
 * (`panels/ai/templates.ts`) and the request profile block (`./profileBlock.ts`)
 * parameterize themselves with, so nothing downstream ever hardcodes a specific
 * character's part names (the "doesn't this become Pip-specific?" answer).
 *
 * What it derives, and each heuristic's KNOWN FAILURE MODES (all fail soft — a wrong
 * guess degrades prompt quality, never correctness; the model still gets the full
 * scene JSON/tree as ground truth and the profile block says "heuristic" out loud):
 *
 * - chains: every bone chain (root bone = a bone whose parent isn't a bone), bones in
 *   root→leaf order with doc-space lengths, plus the art parts the chain deforms
 *   (skin.bones references). Trusts the model's bone-kind links only; a rig with no
 *   bones simply has no chains.
 * - symmetryPairs: label-based left/right pairing — "left"/"right" as a case-insensitive
 *   prefix or suffix with an optional space/_/- separator (left_arm, LeftArm, arm_left).
 *   FAILURE MODES: single-letter conventions (l_arm) are not recognized; a label like
 *   "leftovers" would pair with a hypothetical "rightovers". Each pair also carries a
 *   `mirrored` flag: the two parts' baked transform matrices (with rest-scale sign
 *   folded in, since editor flips ARE negative rest scale) are tested for an exact
 *   x-mirror relation — see `isXMirror`. Rotate-posed pairs correctly read as NOT
 *   matrix-mirrored (the pair still exists via labels).
 * - roles: per-part guesses in a fixed precedence — (1) label keyword tokens (camelCase
 *   and separator-aware; 'forearm' matches 'arm' via prefix/suffix, mid-word substrings
 *   like the 'ear' inside 'forearm' do NOT match); (2) art deformed by a bone chain →
 *   'limb'; (3) if no torso was labeled, the largest-by-bbox roleless direct child of
 *   the figure group (or of the root level) → 'torso' (size RANK from path control
 *   points — an overestimate for curvy art, fine for ranking); (4) art outside the
 *   figure group → 'prop'; (5) everything else → 'part' (the safe fallback).
 *   FAILURE MODES: keyword lists are English-only; an unlabeled rig degrades to size
 *   ranks + 'part'.
 * - figureGroup: the part whose descendants cover the most art parts, provided it
 *   covers at least two and a majority of them — a flat rig (like the bundled sample)
 *   honestly gets null rather than a fabricated figure.
 *
 * CACHING: `getRigProfile` memoizes on a hierarchy signature (ids, parents, labels,
 * kinds, bone pivots/tips, skin bone refs, rest-scale signs). App-side state only —
 * NEVER serialized into a project. Geometry-only edits (node drags) and rest
 * translate/rotate deliberately do NOT invalidate (size ranks could drift until the
 * next hierarchy change — accepted; the profile is heuristic context, not doc truth).
 */
import { RigPart, boneLength } from '../core/model';
import { applyMat, matrixOfTransform, multiply } from '../geometry/transforms';
import { parsePath } from '../geometry/paths';

export type PartRole = 'torso' | 'head' | 'limb' | 'face' | 'prop' | 'shadow' | 'part';

export interface RoleEntry {
  id: string;
  label: string;
  role: PartRole;
}

export interface ProfileChain {
  /** Root→leaf order (a branch's children follow their parent in doc order). */
  bones: { id: string; label: string; length: number }[];
  totalLength: number;
  /** Art parts whose skin references any bone of this chain. */
  deforms: { id: string; label: string }[];
}

export interface SymmetryPair {
  /** The shared base name, lowercased ('arm' for left_arm/right_arm). */
  base: string;
  left: { id: string; label: string };
  right: { id: string; label: string };
  /** True when the two baked transforms are exact x-mirrors (see module doc). */
  mirrored: boolean;
}

export interface RigProfile {
  chains: ProfileChain[];
  symmetryPairs: SymmetryPair[];
  /** One entry per part, in doc.parts order. */
  roles: RoleEntry[];
  figureGroup: { id: string; label: string } | null;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---- chains ----

function buildChains(parts: RigPart[]): ProfileChain[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const isBone = (p: RigPart | undefined): p is RigPart => !!p && p.kind === 'bone';
  const roots = parts.filter(
    (p) => isBone(p) && !isBone(p.parentId ? byId.get(p.parentId) : undefined),
  );
  return roots.map((root) => {
    const ordered: RigPart[] = [];
    const seen = new Set<string>(); // cycle guard — mirrors boneChain's defensiveness
    const visit = (b: RigPart): void => {
      if (seen.has(b.id)) return;
      seen.add(b.id);
      ordered.push(b);
      for (const c of parts) if (c.kind === 'bone' && c.parentId === b.id) visit(c);
    };
    visit(root);
    const chainIds = new Set(ordered.map((b) => b.id));
    const bones = ordered.map((b) => ({ id: b.id, label: b.label, length: round1(boneLength(b)) }));
    const deforms = parts
      .filter((p) => p.kind === 'art' && p.skin?.bones.some((sb) => chainIds.has(sb.id)))
      .map((p) => ({ id: p.id, label: p.label }));
    return { bones, totalLength: round1(bones.reduce((s, b) => s + b.length, 0)), deforms };
  });
}

// ---- symmetry ----

function sideOf(label: string): { side: 'left' | 'right'; base: string } | null {
  const m = /^(left|right)[\s_-]*(.+)$/i.exec(label.trim())
    ?? /^(.+?)[\s_-]*(left|right)$/i.exec(label.trim());
  if (!m) return null;
  const [side, base] = /^(left|right)$/i.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  return { side: side.toLowerCase() as 'left' | 'right', base: base.toLowerCase() };
}

/** Linear part of the part's baked matrix with rest scale folded in innermost (M·S) —
 *  flips live in negative rest sx/sy, so they participate in mirror detection. */
function linearOf(p: RigPart): { a: number; b: number; c: number; d: number } {
  const m = matrixOfTransform(p.transform);
  return { a: m.a * p.rest.sx, b: m.b * p.rest.sx, c: m.c * p.rest.sy, d: m.d * p.rest.sy };
}

/** A = F·B for a vertical-axis reflection F=diag(-1,1)·translate: a/c negate, b/d match.
 *  Identity-vs-identity fails (|1+1| > tol) — untransformed pairs are NOT "mirrored". */
function isXMirror(pa: RigPart, pb: RigPart): boolean {
  const A = linearOf(pa);
  const B = linearOf(pb);
  const mag = Math.max(
    Math.abs(A.a), Math.abs(A.b), Math.abs(A.c), Math.abs(A.d),
    Math.abs(B.a), Math.abs(B.b), Math.abs(B.c), Math.abs(B.d), 1e-6,
  );
  const tol = mag * 1e-3;
  return (
    Math.abs(A.a + B.a) <= tol && Math.abs(A.b - B.b) <= tol &&
    Math.abs(A.c + B.c) <= tol && Math.abs(A.d - B.d) <= tol
  );
}

function buildSymmetryPairs(parts: RigPart[]): SymmetryPair[] {
  const byBase = new Map<string, { left?: RigPart; right?: RigPart }>();
  for (const p of parts) {
    const s = sideOf(p.label);
    if (!s) continue;
    const slot = byBase.get(s.base) ?? {};
    if (!slot[s.side]) slot[s.side] = p; // first occurrence wins; extras are ambiguous
    byBase.set(s.base, slot);
  }
  const pairs: SymmetryPair[] = [];
  for (const [base, slot] of byBase) {
    if (!slot.left || !slot.right) continue;
    pairs.push({
      base,
      left: { id: slot.left.id, label: slot.left.label },
      right: { id: slot.right.id, label: slot.right.label },
      mirrored: isXMirror(slot.left, slot.right),
    });
  }
  return pairs;
}

// ---- roles ----

/** Checked in order — first matching role wins ('face' before 'head' so 'eyebrow'
 *  never reads as head; 'shadow' first so 'arm_shadow' reads as shadow, not limb). */
const ROLE_KEYWORDS: [PartRole, string[]][] = [
  ['shadow', ['shadow']],
  ['face', ['face', 'eye', 'eyes', 'mouth', 'brow', 'nose', 'ear', 'lip', 'beak', 'cheek', 'jaw']],
  ['head', ['head', 'skull', 'hair']],
  ['limb', [
    'arm', 'leg', 'hand', 'foot', 'feet', 'wing', 'tail', 'finger', 'thumb', 'paw',
    'shoulder', 'elbow', 'wrist', 'knee', 'ankle', 'thigh', 'shin', 'limb',
  ]],
  ['torso', ['body', 'torso', 'chest', 'trunk', 'waist', 'spine', 'pelvis', 'belly', 'stomach', 'hip', 'hips']],
];

function tokensOf(label: string): string[] {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary → separator
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whole-token or edge match only — never a mid-word substring (see module doc). */
function matchToken(token: string, kw: string): boolean {
  return token === kw || (kw.length >= 3 && (token.startsWith(kw) || token.endsWith(kw)));
}

function keywordRole(label: string): PartRole | null {
  const toks = tokensOf(label);
  for (const [role, kws] of ROLE_KEYWORDS) {
    for (const kw of kws) if (toks.some((t) => matchToken(t, kw))) return role;
  }
  return null;
}

/** All descendants of `id` (NOT including `id` itself); cycle-safe. */
function descendantSet(id: string, parts: RigPart[]): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string): void => {
    for (const c of parts) {
      if (c.parentId !== pid || out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** Control-point bbox area of a part's own + descendants' paths through their baked
 *  transforms (already the FULL doc-space chain — the import doc-space invariant). */
function subtreeArea(part: RigPart, parts: RigPart[]): number {
  const ids = descendantSet(part.id, parts);
  ids.add(part.id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    if (!ids.has(p.id)) continue;
    const partMat = matrixOfTransform(p.transform);
    for (const path of p.paths) {
      const m = multiply(partMat, matrixOfTransform(path.transform));
      for (const c of parsePath(path.d)) {
        if (c.cmd === 'Z') continue;
        const pts = c.cmd === 'C'
          ? [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x, y: c.y }]
          : [{ x: c.x, y: c.y }];
        for (const raw of pts) {
          const pt = applyMat(m, raw.x, raw.y);
          minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
          minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
        }
      }
    }
  }
  return maxX > minX && maxY > minY ? (maxX - minX) * (maxY - minY) : 0;
}

function findFigureGroup(parts: RigPart[]): { id: string; label: string } | null {
  const artTotal = parts.filter((p) => p.kind === 'art').length;
  if (artTotal === 0) return null;
  let best: RigPart | null = null;
  let bestCover = 0;
  for (const p of parts) {
    if (p.kind === 'bone') continue;
    const desc = descendantSet(p.id, parts);
    let cover = 0;
    for (const q of parts) if (q.kind === 'art' && desc.has(q.id)) cover++;
    if (cover > bestCover) { best = p; bestCover = cover; } // first max wins = outermost
  }
  if (!best || bestCover < 2 || bestCover * 2 < artTotal) return null;
  return { id: best.id, label: best.label };
}

function buildRoles(
  parts: RigPart[], chains: ProfileChain[], figureGroup: { id: string; label: string } | null,
): RoleEntry[] {
  const roleById = new Map<string, PartRole>();
  for (const p of parts) {
    const role = keywordRole(p.label);
    if (role) roleById.set(p.id, role);
  }
  for (const ch of chains) {
    for (const d of ch.deforms) if (!roleById.has(d.id)) roleById.set(d.id, 'limb');
  }
  if (![...roleById.values()].includes('torso')) {
    const anchor = figureGroup?.id ?? null;
    const candidates = parts.filter(
      (p) => p.kind !== 'bone' && !roleById.has(p.id) && p.parentId === anchor,
    );
    let best: RigPart | null = null;
    let bestArea = 0;
    for (const c of candidates) {
      const area = subtreeArea(c, parts);
      if (area > bestArea) { best = c; bestArea = area; }
    }
    if (best) roleById.set(best.id, 'torso');
  }
  if (figureGroup) {
    const inside = descendantSet(figureGroup.id, parts);
    inside.add(figureGroup.id);
    for (const p of parts) {
      if (p.kind === 'art' && !roleById.has(p.id) && !inside.has(p.id)) roleById.set(p.id, 'prop');
    }
  }
  return parts.map((p) => ({ id: p.id, label: p.label, role: roleById.get(p.id) ?? 'part' }));
}

// ---- assembly + cache ----

export function buildRigProfile(parts: RigPart[]): RigProfile {
  const chains = buildChains(parts);
  const figureGroup = findFigureGroup(parts);
  return {
    chains,
    symmetryPairs: buildSymmetryPairs(parts),
    roles: buildRoles(parts, chains, figureGroup),
    figureGroup,
  };
}

/** Everything the profile heuristics read that a HIERARCHY edit can change (see the
 *  module doc's CACHING paragraph for what deliberately isn't in here). */
export function rigSignature(parts: RigPart[]): string {
  return parts
    .map((p) => {
      const bone = p.kind === 'bone'
        ? `${p.pivot.x},${p.pivot.y};${p.boneTip ? `${p.boneTip.x},${p.boneTip.y}` : ''}`
        : '';
      const skin = p.skin?.bones.map((b) => b.id).join(',') ?? '';
      return `${p.id}|${p.parentId ?? ''}|${p.label}|${p.kind}|${bone}|${skin}` +
        `|${Math.sign(p.rest.sx)},${Math.sign(p.rest.sy)}`;
    })
    .join('\n');
}

let cache: { sig: string; profile: RigProfile } | null = null;

/** The memoized entry point every consumer uses (templates row on each panel render,
 *  the request profile block). Signature mismatch → full rebuild; app-state only. */
export function getRigProfile(parts: RigPart[]): RigProfile {
  const sig = rigSignature(parts);
  if (!cache || cache.sig !== sig) cache = { sig, profile: buildRigProfile(parts) };
  return cache.profile;
}
