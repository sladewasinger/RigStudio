/**
 * Inverse kinematics for pose dragging.
 *
 * solveChainIK: full-chain FABRIK (Forward And Backward Reaching Inverse Kinematics)
 * over the polyline of a bone chain's joint positions — the n-joint solver the IK tool
 * drags run so EVERY joint participates (incl. the grabbed bone's own rotation), not
 * just two. See its own doc comment.
 *
 * solveTwoBone: the older analytic two-joint IK — given joints A (e.g. shoulder) and B
 * (elbow) and an effector point E rigidly attached past B (e.g. the grabbed spot on a
 * hand), find the rotation deltas for the two chain links so E lands on target T. The
 * elbow keeps its current bend direction, targets outside reach clamp to full extension,
 * and deltas come back in degrees normalized to (-180, 180]. Kept for the unit tests
 * that pin it (and as the reference the 2-joint FABRIK path is validated against).
 *
 * Everything is solved in root/screen space: because pose chains are rigid
 * (translate + rotate only), a root-space angle delta equals the same delta on the
 * link's own rotate channel; a root-space joint polyline maps back to per-bone rotations.
 */

export interface Pt {
  x: number;
  y: number;
}

const RAD2DEG = 180 / Math.PI;

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Full-chain IK via FABRIK. `joints` is the chain's joint polyline in root space, root
 * (pinned base) first and end-effector last; `target` is where the LAST joint should land.
 * Returns a NEW polyline with the SAME segment lengths (preserved to float precision), the
 * root byte-stable, and the end-effector on (or, when unreachable, straightened toward)
 * the target.
 *
 * Design decisions:
 *  - **Starts from the CURRENT pose** (`joints` copied verbatim as the working set), so a
 *    reachable target near the current configuration converges WITHOUT flipping the chain
 *    to the mirror-image solution — the pose bias the caller relies on (pinned by a test).
 *  - **Lengths are preserved exactly.** Every point placement is `p_i + (len/‖·‖)·(·)`, so
 *    each finished segment is exactly its original length; the LAST operation on the whole
 *    chain is always a full backward pass (or none), so the returned lengths hold to ~1e-12.
 *  - **Unreachable targets straighten** the chain toward the target at full extension —
 *    FABRIK's single-pass reach does this naturally (each joint steps `len` toward the
 *    target from the previous one), no special aim math.
 *  - **Deterministic**: pure arithmetic, fixed iteration budget, no randomness.
 */
export function solveChainIK(
  joints: Pt[],
  target: Pt,
  opts: { tol?: number; maxIter?: number } = {},
): Pt[] {
  const n = joints.length;
  if (n === 0) return [];
  const p = joints.map((j) => ({ x: j.x, y: j.y }));
  if (n === 1) return p; // a lone joint has nothing to solve — the base is pinned.

  const tol = opts.tol ?? 0.05;
  const maxIter = opts.maxIter ?? 16;
  const root = { x: p[0].x, y: p[0].y };
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = dist(joints[i], joints[i + 1]);
    lens.push(l);
    total += l;
  }

  // Unreachable: lay every joint out on the root→target ray at full extension.
  if (dist(root, target) >= total) {
    for (let i = 0; i < n - 1; i++) {
      const d = dist(p[i], target) || 1e-9;
      const r = lens[i] / d;
      p[i + 1] = { x: p[i].x * (1 - r) + target.x * r, y: p[i].y * (1 - r) + target.y * r };
    }
    return p;
  }

  for (let iter = 0; iter < maxIter; iter++) {
    if (dist(p[n - 1], target) < tol) break;
    // Forward reach: pin the effector to the target, walk back toward the root.
    p[n - 1] = { x: target.x, y: target.y };
    for (let i = n - 2; i >= 0; i--) {
      const d = dist(p[i + 1], p[i]) || 1e-9;
      const r = lens[i] / d;
      p[i] = { x: p[i + 1].x * (1 - r) + p[i].x * r, y: p[i + 1].y * (1 - r) + p[i].y * r };
    }
    // Backward reach: pin the root back, walk out toward the effector.
    p[0] = { x: root.x, y: root.y };
    for (let i = 0; i < n - 1; i++) {
      const d = dist(p[i], p[i + 1]) || 1e-9;
      const r = lens[i] / d;
      p[i + 1] = { x: p[i].x * (1 - r) + p[i + 1].x * r, y: p[i].y * (1 - r) + p[i + 1].y * r };
    }
  }
  return p;
}

function angleOf(from: Pt, to: Pt): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function normDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Rotation delta (degrees) that swings E around A onto the ray A→T (aim/1-joint IK). */
export function solveAim(a: Pt, e: Pt, t: Pt): number {
  const cur = angleOf(a, e);
  const want = angleOf(a, t);
  return normDeg((want - cur) * RAD2DEG);
}

export function solveTwoBone(
  a: Pt, b: Pt, e: Pt, t: Pt,
): { delta1: number; delta2: number } {
  const len1 = Math.hypot(b.x - a.x, b.y - a.y);
  const len2 = Math.hypot(e.x - b.x, e.y - b.y);
  if (len1 < 1e-6 || len2 < 1e-6) {
    // Degenerate chain: fall back to aiming the whole thing.
    return { delta1: solveAim(a, e, t), delta2: 0 };
  }

  // Clamp the target into the annulus the chain can reach.
  const dRaw = Math.hypot(t.x - a.x, t.y - a.y);
  const d = Math.min(len1 + len2 - 1e-4, Math.max(Math.abs(len1 - len2) + 1e-4, dRaw));

  // Preserve the current bend direction (side of the A→E line the elbow sits on).
  const cross =
    (b.x - a.x) * (e.y - b.y) - (b.y - a.y) * (e.x - b.x);
  const bend = cross >= 0 ? 1 : -1;

  // Law of cosines: angle at A between A→T and the first link.
  const cosAlpha = (len1 * len1 + d * d - len2 * len2) / (2 * len1 * d);
  const alpha = Math.acos(Math.min(1, Math.max(-1, cosAlpha)));

  const theta1Cur = angleOf(a, b);
  const theta1New = angleOf(a, t) - bend * alpha;
  const delta1 = normDeg((theta1New - theta1Cur) * RAD2DEG);

  // Where the elbow lands after link 1 swings; link 2 then aims at the target.
  const bNew: Pt = {
    x: a.x + len1 * Math.cos(theta1New),
    y: a.y + len1 * Math.sin(theta1New),
  };
  const theta2Cur = angleOf(b, e);
  const theta2New = angleOf(bNew, t);
  // Link 2 already rotated by delta1 (it rides link 1), so subtract that.
  const delta2 = normDeg(theta2New * RAD2DEG - (theta2Cur * RAD2DEG + delta1));

  return { delta1, delta2 };
}
