import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pipFixture from '../fixtures/pip-failing-warp-test.json';
import { activeClip, ancestorChain, channelValue, notify, state } from '../../core/model';
import { partGroupEl, bootRig, repaint, resetRig, setEditorMode } from './harness';

beforeAll(bootRig);
beforeEach(() => {
  resetRig();
  (window as any).__rigStudio.loadProjectText(JSON.stringify(pipFixture));
});

function revealPart(partId: string): HTMLElement {
  const part = state.doc!.parts.find((candidate) => candidate.id === partId)!;
  for (const ancestor of ancestorChain(part)) {
    const row = document.querySelector<HTMLElement>(`.layer-row.part[data-part-id="${ancestor.id}"]`);
    const chevron = row?.querySelector<HTMLElement>('.chevron');
    if (chevron?.textContent === '▸') chevron.click();
  }
  const row = document.querySelector<HTMLElement>(`.layer-row.part[data-part-id="${partId}"]`);
  if (!row) throw new Error(`part row ${partId} was not revealed`);
  return row;
}

function eye(partId: string): HTMLButtonElement {
  return revealPart(partId).querySelector<HTMLButtonElement>('.layer-eye')!;
}

function keyVisibility(partId: string, time: number, visible: boolean): void {
  state.currentTime = time;
  notify(); repaint();
  const part = state.doc!.parts.find((candidate) => candidate.id === partId)!;
  if ((channelValue(part, 'visibility', time) >= 0.5) !== visible) eye(partId).click();
}

describe('Pip arm variants — animation-local Layers visibility', () => {
  it('switches arm variants by stepped eye keys, preserves Edit visibility, and keeps clips independent', () => {
    const straight = state.doc!.parts.find((part) => part.label === 'left_arm')!;
    const sideways = state.doc!.parts.find((part) => part.label === 'left_arm_sideways')!;
    const rest = [straight.hidden, sideways.hidden];

    setEditorMode('animate');
    keyVisibility(straight.id, 0, true);
    keyVisibility(sideways.id, 0, false);
    keyVisibility(straight.id, 500, false);
    keyVisibility(sideways.id, 500, true);

    state.currentTime = 250; notify(); repaint();
    expect(partGroupEl('left_arm').classList.contains('part-hidden')).toBe(false);
    expect(partGroupEl('left_arm_sideways').classList.contains('part-hidden')).toBe(true);
    expect(eye(sideways.id).title).toContain('visibility animated in this clip');
    expect(document.querySelector('.tl-lane-label')?.parentElement?.parentElement?.textContent)
      .not.toBeNull();
    expect([...document.querySelectorAll('.tl-lane-label')].map((label) => label.textContent))
      .toEqual(expect.arrayContaining(['left_arm.visibility', 'left_arm_sideways.visibility']));

    state.currentTime = 750; notify(); repaint();
    expect(partGroupEl('left_arm').classList.contains('part-hidden')).toBe(true);
    expect(partGroupEl('left_arm_sideways').classList.contains('part-hidden')).toBe(false);

    const parent = state.doc!.parts.find((part) => part.id === sideways.parentId)!;
    keyVisibility(parent.id, 900, false);
    state.currentTime = 950; notify(); repaint();
    expect(channelValue(sideways, 'visibility', 950), 'child remains locally visible').toBe(1);
    expect(partGroupEl('left_arm_sideways').classList.contains('part-hidden'), 'parent suppresses child').toBe(true);

    state.currentTime = 1100;
    state.selectedPartId = parent.id;
    state.selectedPartIds = [parent.id, sideways.id];
    notify(); repaint();
    eye(parent.id).click();
    expect(activeClip()!.tracks.find((track) => track.target === parent.id && track.channel === 'visibility')!
      .keyframes.some((key) => key.time === 1100)).toBe(true);
    expect(activeClip()!.tracks.find((track) => track.target === sideways.id && track.channel === 'visibility')!
      .keyframes.some((key) => key.time === 1100), 'selected descendant is not redundantly keyed').toBe(false);

    state.currentTime = 1200;
    state.selectedPartId = straight.id;
    state.selectedPartIds = [straight.id, sideways.id];
    notify(); repaint();
    eye(straight.id).click();
    for (const sibling of [straight, sideways]) {
      expect(activeClip()!.tracks.find((track) => track.target === sibling.id && track.channel === 'visibility')!
        .keyframes.filter((key) => key.time === 1200)).toHaveLength(1);
    }
    state.currentTime = 1300;
    state.selectedPartId = straight.id;
    state.selectedPartIds = [straight.id, sideways.id];
    notify(); repaint();
    eye(parent.id).click();
    expect(activeClip()!.tracks.find((track) => track.target === parent.id && track.channel === 'visibility')!
      .keyframes.some((key) => key.time === 1300)).toBe(true);
    for (const sibling of [straight, sideways]) {
      expect(activeClip()!.tracks.find((track) => track.target === sibling.id && track.channel === 'visibility')!
        .keyframes.some((key) => key.time === 1300), 'unselected clicked row does not fan out').toBe(false);
    }

    const serialized = (window as any).__rigStudio.serializeDoc(state.doc!);
    expect((window as any).__rigStudio.loadProjectText(serialized)).toBe(true);
    state.currentTime = 750; notify(); repaint();
    expect(partGroupEl('left_arm').classList.contains('part-hidden')).toBe(true);
    expect(partGroupEl('left_arm_sideways').classList.contains('part-hidden')).toBe(false);

    const straightReloaded = state.doc!.parts.find((part) => part.label === 'left_arm')!;
    const sidewaysReloaded = state.doc!.parts.find((part) => part.label === 'left_arm_sideways')!;

    state.doc!.clips.push({ name: 'independent', duration: 1000, tracks: [] });
    state.activeClipIndex = state.doc!.clips.length - 1;
    state.currentTime = 750; notify(); repaint();
    expect(channelValue(straightReloaded, 'visibility', 750)).toBe(straightReloaded.hidden ? 0 : 1);
    expect(channelValue(sidewaysReloaded, 'visibility', 750)).toBe(sidewaysReloaded.hidden ? 0 : 1);

    setEditorMode('setup');
    expect([straightReloaded.hidden, sidewaysReloaded.hidden]).toEqual(rest);
    expect(activeClip()!.name).toBe('independent');
  });
});
