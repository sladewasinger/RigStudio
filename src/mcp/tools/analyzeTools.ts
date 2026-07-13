/**
 * analyze_rig: A5's `RigProfile` (bone chains, left/right symmetry pairs, role guesses,
 * figure group) plus the compact text block the in-app assistant prepends to every AI
 * request — both pure over `doc.parts` (`ai/rigProfile.ts`/`ai/profileBlock.ts`), so this
 * tool calls `buildRigProfile` directly rather than the app-state-memoized `getRigProfile`
 * (an MCP session has no "current app render" for that cache to key off of).
 */
import { buildRigProfile } from '../../ai/rigProfile';
import { buildRigProfileBlock } from '../../ai/profileBlock';
import { withSessionDoc } from '../sessions';

const DEFAULT_SESSION = 'default';

export interface AnalyzeRigParams {
  session?: string;
}

export function handleAnalyzeRig(params: AnalyzeRigParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    const profile = buildRigProfile(doc.parts);
    return { session, profile, profileBlock: buildRigProfileBlock(profile) };
  });
}
