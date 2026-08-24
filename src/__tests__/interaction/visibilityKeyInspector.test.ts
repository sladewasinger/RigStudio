import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notify, setKeyframeAt } from '../../core/model';
import { redo, undo } from '../../core/history';
import {
  bootRig, clipTrack, dragOnElement, partByLabel, resetRig, setEditorMode, state,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function lane(partLabel: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('#timeline .tl-lane-label'));
  const label = labels.find((candidate) => candidate.textContent === `${partLabel}.visibility`);
  if (!label) throw new Error(`missing ${partLabel}.visibility lane`);
  return label.closest<HTMLElement>('.tl-lane')!;
}

function clickDiamond(element: HTMLElement, shiftKey = false): void {
  const rect = element.getBoundingClientRect();
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  if (!shiftKey) { dragOnElement(element, point, point, 0); return; }
  const event = (type: string, buttons: number) => new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons, clientX: point.x, clientY: point.y, shiftKey: true,
  });
  element.dispatchEvent(event('pointerdown', 1));
  element.dispatchEvent(event('pointerup', 0));
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('#inspector button'))
    .find((candidate) => candidate.textContent === name);
  if (!found) throw new Error(`missing Inspector button ${name}`);
  return found;
}

describe('visibility-key Inspector context', () => {
  it('shows the exact stepped property and edits value/time with undo and no easing UI', () => {
    setEditorMode('animate');
    document.getElementById('right-dock-tab-inspector')!.click();
    const part = partByLabel('left_arm');
    setKeyframeAt(part.id, 'visibility', 100, 0);
    setKeyframeAt(part.id, 'visibility', 500, 1);
    notify();

    clickDiamond(lane(part.label).querySelectorAll<HTMLElement>('.tl-key')[0]);
    expect(document.querySelector('#inspector h3')?.textContent).toContain('left_arm — Visibility');
    expect(document.querySelector('#inspector')?.textContent).toContain('Stepped · holds until next key');
    expect(button('Hidden').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#timeline .tl-keybar select'), 'visibility exposes no meaningless easing').toBeNull();

    button('Visible').click();
    expect(clipTrack(part.id, 'visibility')!.keyframes[0].value).toBe(1);
    undo();
    expect(clipTrack(part.id, 'visibility')!.keyframes[0].value).toBe(0);
    redo();
    expect(clipTrack(part.id, 'visibility')!.keyframes[0].value).toBe(1);

    // Reselect after history replaces key objects, then use the contextual time editor.
    clickDiamond(lane(part.label).querySelectorAll<HTMLElement>('.tl-key')[0]);
    const time = document.querySelector<HTMLInputElement>('#inspector .visibility-key-time input')!;
    time.value = '240';
    time.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clipTrack(part.id, 'visibility')!.keyframes.map((key) => key.time)).toEqual([240, 500]);
    expect(state.currentTime).toBe(240);

    button('Delete keyframes').click();
    expect(clipTrack(part.id, 'visibility')!.keyframes.map((key) => key.time)).toEqual([500]);
    undo();
    expect(clipTrack(part.id, 'visibility')!.keyframes.map((key) => key.time)).toEqual([240, 500]);
  });

  it('reports mixed values for a multi-key visibility selection', () => {
    setEditorMode('animate');
    document.getElementById('right-dock-tab-inspector')!.click();
    const part = partByLabel('left_arm');
    setKeyframeAt(part.id, 'visibility', 100, 0);
    setKeyframeAt(part.id, 'visibility', 500, 1);
    notify();
    const diamonds = lane(part.label).querySelectorAll<HTMLElement>('.tl-key');
    clickDiamond(diamonds[0]);
    clickDiamond(diamonds[1], true);
    expect(document.querySelector('#inspector h3')?.textContent).toBe('2 keyframes selected');
    expect(document.querySelector('#inspector')?.textContent).toContain('Mixed');
    expect(document.querySelector('#inspector')?.textContent).toContain('Stepped · holds until next key');
  });
});
