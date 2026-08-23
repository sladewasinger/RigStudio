import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo } from '../../core/history';
import { parsePath } from '../../geometry/paths';
import { canDeleteSelectedNodes } from '../../view';
import { ctx, nodeKey } from '../../view/context';
import {
  bootRig, resetRig, partByLabel, enterNodeMode,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function selectNodes(pathId: string, ...indexes: number[]): void {
  ctx.selectedNodes.clear();
  for (const index of indexes) ctx.selectedNodes.add(nodeKey(pathId, index));
  ctx.selectedNode = indexes.length ? { pathId, cmdIndex: indexes[indexes.length - 1] } : null;
}

function press(key: string, target: HTMLElement | Document = document): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

describe('node deletion', () => {
  it('Delete promotes a new start node on an open path and undo/redo restores both states', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    path.d = 'M 0,0 C 1,0 2,1 3,1 L 5,2 L 6,3';
    path.nodeTypes = 'cszc';
    enterNodeMode('left_leg', path.id);
    selectNodes(path.id, 0);

    expect(canDeleteSelectedNodes()).toBe(true);
    const ev = press('Delete');
    expect(ev.defaultPrevented).toBe(true);
    expect(parsePath(path.d)).toEqual([
      { cmd: 'M', x: 3, y: 1 },
      { cmd: 'L', x: 5, y: 2 },
      { cmd: 'L', x: 6, y: 3 },
    ]);
    expect(path.nodeTypes).toBe('szc');
    expect(ctx.selectedNodes.size).toBe(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    const undone = partByLabel('left_leg').paths[0];
    expect(parsePath(undone.d)).toHaveLength(4);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    expect(parsePath(partByLabel('left_leg').paths[0].d)).toHaveLength(3);
  });

  it('Backspace deletes multiple closed-path nodes, keeps valid geometry, and drops stale weights', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    path.d = 'M 0,0 C 1,0 2,0 3,0 C 4,0 4,1 4,2 L 2,4 L 0,2 Z';
    path.nodeTypes = 'czscc';
    part.skin = {
      bones: [],
      overrides: { [path.id]: { '1': { a: 'bone', b: 'bone', t: 0.5 } } },
    };
    enterNodeMode('left_leg', path.id);
    selectNodes(path.id, 1, 2);

    press('Backspace');
    const result = partByLabel('left_leg');
    const cmds = parsePath(result.paths[0].d);
    expect(cmds.map((c) => c.cmd)).toEqual(['M', 'L', 'L', 'Z']);
    expect(result.paths[0].nodeTypes).toBe('ccc');
    expect(result.skin?.overrides?.[path.id]).toBeUndefined();
  });

  it('does not corrupt or checkpoint a path when the selection would cross its minimum', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    path.d = 'M 0,0 L 4,0 L 2,4 Z';
    path.nodeTypes = 'ccc';
    enterNodeMode('left_leg', path.id);
    selectNodes(path.id, 1);
    const before = path.d;

    expect(canDeleteSelectedNodes()).toBe(false);
    press('Delete');
    expect(path.d).toBe(before);
    expect(canUndo()).toBe(false);
    const button = [...document.querySelectorAll<HTMLButtonElement>('#inspector button')]
      .find((b) => b.textContent === 'delete nodes');
    expect(button?.disabled).toBe(true);
  });

  it('does not route Delete or Backspace out of text inputs or contenteditable descendants', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    enterNodeMode('left_leg', path.id);
    selectNodes(path.id, 1);
    const before = path.d;
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('Delete', input);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    const child = document.createElement('span');
    editable.appendChild(child);
    document.body.appendChild(editable);
    press('Backspace', child);
    expect(path.d).toBe(before);
  });
});

describe('Inspector tool switch', () => {
  it('keeps Pose tool / Node editing in a sticky header inside the Inspector scroller', () => {
    const inspector = document.getElementById('inspector')!;
    const sticky = inspector.querySelector<HTMLElement>('.inspector-sticky-tools')!;
    expect(getComputedStyle(sticky).position).toBe('sticky');
    expect(sticky.querySelector('.inspector-mode-row')?.textContent).toContain('Pose tool');
    expect(sticky.querySelector('.inspector-mode-row')?.textContent).toContain('Node editing');

    inspector.style.height = '150px';
    inspector.scrollTop = inspector.scrollHeight;
    expect(sticky.getBoundingClientRect().top).toBeLessThanOrEqual(inspector.getBoundingClientRect().top + 2);
    expect(sticky.getBoundingClientRect().bottom).toBeGreaterThan(inspector.getBoundingClientRect().top);
  });
});
