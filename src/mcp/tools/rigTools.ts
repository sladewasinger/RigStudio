/**
 * Structural rig tools: add_bones (wraps `applyRigChanges`'s addBones/reparent path plus
 * EXPLICIT-label binding — see `bindHeadless.ts`) and add_state_machine (`newStateMachine`
 * + population, `core/smTypes` shapes).
 */
import {
  applyRigChanges, boneChain, freshId, newStateMachine, RigChanges, RigDoc, RigPart, StateMachine,
} from '../../core/model';
import { bindPartsToBonesHeadless } from '../bindHeadless';
import { McpToolError } from '../errors';
import { withSessionMutation } from '../sessions';

const DEFAULT_SESSION = 'default';

export interface AddBoneInput {
  label?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  parentLabel?: string | null;
  bindParts?: string[];
}

export interface AddBonesParams {
  bones: AddBoneInput[];
  bindTo?: string[];
  session?: string;
}

function uniqueLabel(doc: RigDoc, taken: Set<string>, index: number): string {
  let n = index + 1;
  let label = `bone_${n}`;
  while (taken.has(label) || doc.parts.some((p) => p.label === label)) {
    n += 1;
    label = `bone_${n}`;
  }
  return label;
}

function resolveArtLabels(doc: RigDoc, source: 'bindParts' | 'bindTo', labels: string[]): RigPart[] {
  const missing: string[] = [];
  const arts: RigPart[] = [];
  for (const label of labels) {
    const part = doc.parts.find((p) => p.label === label);
    if (!part || part.kind !== 'art' || part.paths.length === 0) missing.push(label);
    else arts.push(part);
  }
  if (missing.length > 0) {
    throw new McpToolError(
      `${source} references label(s) that don't resolve to an existing art part with geometry ` +
        `(no geometric auto-bind headlessly — labels must be explicit): ${missing.join(', ')}`,
    );
  }
  return arts;
}

export function handleAddBones(params: AddBonesParams) {
  if (!params.bones || params.bones.length === 0) {
    throw new McpToolError('bones must be a non-empty array.');
  }
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionMutation(session, (doc) => {
    const taken = new Set<string>();
    const changes: RigChanges = {
      addBones: params.bones.map((b, i) => {
        const label = b.label && b.label.trim() ? b.label.trim() : uniqueLabel(doc, taken, i);
        taken.add(label);
        return {
          label,
          pivot: { x: b.x1, y: b.y1 },
          parent: b.parentLabel ?? null,
          tip: { x: b.x2, y: b.y2 },
          bindParts: b.bindParts ?? [],
        };
      }),
      reparent: [],
      movePivots: [],
    };

    const labelToId = applyRigChanges(changes);
    const newBoneIds = changes.addBones
      .map((b) => labelToId.get(b.label))
      .filter((id): id is string => !!id);

    let boundCount = 0;
    const boundChainKeys = new Set<string>();

    for (const b of changes.addBones) {
      if (!b.bindParts?.length) continue;
      const boneId = labelToId.get(b.label);
      if (!boneId) continue;
      const chain = boneChain(doc.parts, boneId);
      if (chain.length === 0) continue;
      const chainKey = chain.map((p) => p.id).sort().join(',');
      if (boundChainKeys.has(chainKey)) continue;
      boundChainKeys.add(chainKey);
      const arts = resolveArtLabels(doc, 'bindParts', b.bindParts);
      if (arts.length > 0) {
        bindPartsToBonesHeadless(arts, chain);
        boundCount += arts.length;
      }
    }

    if (params.bindTo?.length) {
      const chainIds = new Set<string>();
      for (const id of newBoneIds) for (const b of boneChain(doc.parts, id)) chainIds.add(b.id);
      const chainKey = [...chainIds].sort().join(',');
      if (chainIds.size > 0 && !boundChainKeys.has(chainKey)) {
        boundChainKeys.add(chainKey);
        const chainBones = doc.parts.filter((p) => chainIds.has(p.id));
        const arts = resolveArtLabels(doc, 'bindTo', params.bindTo);
        bindPartsToBonesHeadless(arts, chainBones);
        boundCount += arts.length;
      }
    }

    return {
      session,
      addedBones: changes.addBones.map((b) => ({ label: b.label, id: labelToId.get(b.label)! })),
      boundPartCount: boundCount,
    };
  });
}

export interface AddStateMachineInputSchema {
  name: string;
  inputs?: { name: string; type: 'bool' | 'number' | 'trigger'; default?: boolean | number }[];
  states?: { name: string; clipName?: string; x?: number; y?: number }[];
  transitions?: {
    from: string;
    to: string;
    durationMs?: number;
    conditions?: { inputName: string; op?: '==' | '!=' | '<' | '<=' | '>' | '>='; value?: boolean | number }[];
    exitFraction?: number | null;
  }[];
}

export interface AddStateMachineParams {
  machine: AddStateMachineInputSchema;
  session?: string;
}

export function handleAddStateMachine(params: AddStateMachineParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionMutation(session, (doc) => {
    const sm: StateMachine = newStateMachine(params.machine.name);
    doc.stateMachines = doc.stateMachines ?? [];
    doc.stateMachines.push(sm);

    for (const inp of params.machine.inputs ?? []) {
      sm.inputs.push({ id: freshId('input'), name: inp.name, type: inp.type, default: inp.default });
    }
    const stateIdByName = new Map(sm.states.map((s) => [s.name, s.id]));
    for (const st of params.machine.states ?? []) {
      const id = freshId('state');
      sm.states.push({ id, name: st.name, kind: 'animation', clipName: st.clipName, x: st.x, y: st.y });
      stateIdByName.set(st.name, id);
    }
    const inputIdByName = new Map(sm.inputs.map((i) => [i.name, i.id]));
    for (const tr of params.machine.transitions ?? []) {
      const fromId = stateIdByName.get(tr.from);
      const toId = stateIdByName.get(tr.to);
      if (!fromId || !toId) {
        throw new McpToolError(`Transition references unknown state(s): ${tr.from} -> ${tr.to}`);
      }
      sm.transitions.push({
        id: freshId('transition'),
        fromId,
        toId,
        durationMs: tr.durationMs ?? 0,
        exitFraction: tr.exitFraction ?? null,
        conditions: (tr.conditions ?? []).map((c) => {
          const inputId = inputIdByName.get(c.inputName);
          if (!inputId) throw new McpToolError(`Condition references unknown input: ${c.inputName}`);
          return { inputId, op: c.op, value: c.value };
        }),
      });
    }

    return { session, machineName: sm.name, machineId: sm.id, stateCount: sm.states.length, transitionCount: sm.transitions.length };
  });
}
