/**
 * Analytic inverse kinematics for pose dragging.
 *
 * solveTwoBone: classic two-joint IK — given joints A (e.g. shoulder) and B (elbow)
 * and an effector point E rigidly attached past B (e.g. the grabbed spot on a hand),
 * find the rotation deltas for the two chain links so E lands on target T. The elbow
 * keeps its current bend direction, targets outside reach clamp to full extension,
 * and deltas come back in degrees normalized to (-180, 180].
 *
 * Everything is solved in root/screen space: because pose chains are rigid
 * (translate + rotate only), a root-space angle delta equals the same delta on the
 * link's own rotate channel.
 */

export interface Pt {
  x: number;
  y: number;
}

const RAD2DEG = 180 / Math.PI;

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
