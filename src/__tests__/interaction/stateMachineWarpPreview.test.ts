import { beforeAll, describe, expect, it } from 'vitest';
import { notify, sampleKeyList, state, StateMachine } from '../../core/model';
import { renderPose } from '../../view';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { bootRig, setEditorMode } from './harness';

interface RigStudioHook {
  loadProjectText: (text: string) => boolean;
}

interface SmPanelHook {
  startPreviewByMachineId: (id: string) => void;
  firePreviewTrigger: (name: string) => void;
  tick: (dtMs: number) => unknown;
  channelValue: (target: string, channel: 'warp' | 'rotate') => number | null;
}

const api = () => (window as unknown as { __rigStudio: RigStudioHook }).__rigStudio;
const smApi = () => (window as unknown as { __smPanel: SmPanelHook }).__smPanel;
const pathD = (id: string) => document.querySelector<SVGPathElement>(`[data-path-id="${id}"]`)!.getAttribute('d');

beforeAll(bootRig);

describe('state-machine preview uses canonical Warp pose evaluation', () => {
  it('matches direct playback after a trigger, including rigged geometry and endpoint suppression', () => {
    const doc = createWarpTriangleSquareSample();
    const machine: StateMachine = {
      id: 'warp_preview_machine', name: 'Warp preview',
      inputs: [{ id: 'go_input', name: 'go', type: 'trigger' }],
      states: [
        { id: 'entry', name: 'Entry', kind: 'entry', x: 0, y: 0 },
        { id: 'idle', name: 'Idle', kind: 'animation', clipName: doc.clips[0].name, x: 100, y: 0 },
        { id: 'showcase', name: 'Showcase', kind: 'animation', clipName: doc.clips[2].name, x: 200, y: 0 },
      ],
      transitions: [
        { id: 'enter_idle', fromId: 'entry', toId: 'idle', durationMs: 0, conditions: [] },
        { id: 'go_showcase', fromId: 'idle', toId: 'showcase', durationMs: 0, conditions: [{ inputId: 'go_input' }] },
      ],
      listeners: [],
    };
    doc.stateMachines = [machine];
    api().loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc }));
    setEditorMode('animate');

    state.activeClipIndex = 2;
    state.currentTime = 1700;
    notify(); renderPose();
    const directArm = pathD('arm_side_path');
    const directShadow = pathD('arm_shadow_path');
    const directTargetHidden = document.querySelector('[data-part-id="arm_palm_group"]')!.classList.contains('warp-reference-runtime');

    smApi().startPreviewByMachineId(machine.id);
    smApi().firePreviewTrigger('go');
    smApi().tick(0);
    smApi().tick(1700);

    expect(smApi().channelValue('arm_side_to_palm', 'warp')).toBeCloseTo(1, 8);
    expect(pathD('arm_side_path')).toBe(directArm);
    expect(pathD('arm_shadow_path')).toBe(directShadow);
    expect(document.querySelector('[data-part-id="arm_palm_group"]')!.classList.contains('warp-reference-runtime'))
      .toBe(directTargetHidden);
  });

  it('blends a keyed Warp against the outgoing clip default during a state transition', () => {
    const doc = createWarpTriangleSquareSample();
    const machine: StateMachine = {
      id: 'warp_blend_machine', name: 'Warp blend',
      inputs: [{ id: 'go_input', name: 'go', type: 'trigger' }],
      states: [
        { id: 'entry', name: 'Entry', kind: 'entry', x: 0, y: 0 },
        { id: 'idle', name: 'Idle', kind: 'animation', clipName: doc.clips[0].name, x: 100, y: 0 },
        { id: 'target', name: 'Target', kind: 'animation', clipName: doc.clips[2].name, x: 200, y: 0 },
      ],
      transitions: [
        { id: 'enter_idle', fromId: 'entry', toId: 'idle', durationMs: 0, conditions: [] },
        { id: 'go_target', fromId: 'idle', toId: 'target', durationMs: 500, conditions: [{ inputId: 'go_input' }] },
      ], listeners: [],
    };
    doc.stateMachines = [machine];
    api().loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc }));
    setEditorMode('animate');
    smApi().startPreviewByMachineId(machine.id);
    smApi().firePreviewTrigger('go');
    smApi().tick(0);
    smApi().tick(250);

    // Incoming showcase starts at its zero/default Warp, while the outgoing first clip
    // has already advanced to 250 ms. The scalar must be the actual channel crossfade,
    // not the Animate tab's unrelated currentTime/activeClip.
    const outgoing = doc.clips[0].tracks.find((t) => t.target === 'triangle_to_square' && t.channel === 'warp')!;
    const expected = 0.5 * sampleKeyList(outgoing.keyframes, 250, 0);
    expect(smApi().channelValue('triangle_to_square', 'warp')).toBeCloseTo(expected, 8);
  });
});
