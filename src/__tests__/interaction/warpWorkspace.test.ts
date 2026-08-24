import { beforeAll, describe, expect, it } from 'vitest';
import { notify, selectPart, state, RigDoc, warpPathFingerprint } from '../../core/model';
import { redo, undo } from '../../core/history';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { bootRig, clientCenterOf, gestureDrag, overlayEl, waitFor } from './harness';
import { renderPose } from '../../view';
import pipFixture from '../fixtures/pip-failing-warp-test.json';
import { evaluateRiggedWarpCommands } from '../../geometry/skinPose';
import { serializePath } from '../../geometry/paths';

beforeAll(bootRig);
const load = () => {
  const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
  api.loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: createWarpTriangleSquareSample() }));
};

const riggedWarpDoc = (): RigDoc => {
  const rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 };
  const path = (id: string, d: string, fill: string) => ({ id, label: id, d, fill, fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '' });
  const source = path('arm_source_path', 'M10 45 L90 45 L90 55 L10 55 Z', '#6688ff');
  const target = path('arm_target_path', 'M10 40 L90 35 L95 65 L10 60 Z', '#ff9966');
  const shadow = path('shadow_source_path', 'M12 55 L90 55 L90 60 L12 60 Z', '#334488');
  const shadowTarget = path('shadow_target_path', 'M12 60 L95 65 L96 70 L12 65 Z', '#884433');
  const bones = [
    { id: 'shoulder', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 10, y: 50 }, q: { x: 50, y: 50 } } },
    { id: 'wrist', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 50, y: 50 }, q: { x: 90, y: 50 } } },
  ];
  const part = (id: string, label: string, paths: ReturnType<typeof path>[], skin: boolean) => ({ id, label, kind: 'art' as const, transform: '', pivot: { x: 50, y: 50 }, pivotHint: null, rest: { ...rest }, parentId: null, boneTip: null, paths, skin: skin ? { bones: structuredClone(bones) } : null });
  return { name: 'rigged warp', viewBox: { x: 0, y: 0, w: 110, h: 100 }, rootPivot: { x: 50, y: 50 }, fps: 60,
    parts: [
      { ...part('shoulder', 'shoulder', [], false), kind: 'bone', pivot: { x: 10, y: 50 }, boneTip: { x: 50, y: 50 } },
      { ...part('wrist', 'wrist', [], false), kind: 'bone', parentId: 'shoulder', pivot: { x: 50, y: 50 }, boneTip: { x: 90, y: 50 } },
      { ...part('arm_source_group', 'side hand group', [], false), kind: 'group' },
      { ...part('arm_target_group', 'open palm group', [], false), kind: 'group' },
      { ...part('arm_source', 'arm silhouette', [source], true), parentId: 'arm_source_group' },
      { ...part('shadow_source', 'arm shadow', [shadow], true), parentId: 'arm_source_group' },
      { ...part('arm_target', 'open palm', [target], true), parentId: 'arm_target_group' },
      { ...part('shadow_target', 'open palm shadow', [shadowTarget], true), parentId: 'arm_target_group' },
    ], clips: [{ name: 'Bend then Warp', duration: 3000, tracks: [
      { target: 'wrist', channel: 'rotate', keyframes: [{ time: 0, value: 65, easing: 'linear' }, { time: 3000, value: 65, easing: 'linear' }] },
      { target: 'arm_warp', channel: 'warp', keyframes: [{ time: 1000, value: 0, easing: 'linear' }, { time: 2000, value: 1, easing: 'linear' }, { time: 3000, value: 0, easing: 'linear' }] },
    ] }], warps: [{ version: 1, id: 'arm_warp', name: 'Side hand ↔ Open palm', sourcePartId: 'arm_source_group', targetPartId: 'arm_target_group', pairs: [
      { id: 'arm_pair', sourcePartId: 'arm_source', sourcePathId: source.id, targetPartId: 'arm_target', targetPathId: target.id, sourceFingerprint: warpPathFingerprint(source), targetFingerprint: warpPathFingerprint(target) },
      { id: 'shadow_pair', sourcePartId: 'shadow_source', sourcePathId: shadow.id, targetPartId: 'shadow_target', targetPathId: shadowTarget.id, sourceFingerprint: warpPathFingerprint(shadow), targetFingerprint: warpPathFingerprint(shadowTarget) },
    ] }], stateMachines: [] } as RigDoc;
};

describe('Warp dock workflow', () => {
  it('is Animate-only and stays discoverable without selection', async () => {
    load(); state.doc!.warps = []; state.doc!.clips[0].tracks = [];
    state.editorMode = 'setup'; notify(); renderPose();
    expect(Array.from(document.querySelectorAll('#canvas-tools button')).some((item) => item.textContent === 'Create Warp')).toBe(false);
    expect(document.querySelector('.right-dock-tabs')).toBeNull();
    expect(document.querySelectorAll('#right-dock .ai-panel, #right-dock .warps-panel')).toHaveLength(0);
    expect(document.querySelector('.right-dock-pin')).toBeNull();
    state.editorMode = 'animate'; selectPart('triangle_group'); selectPart('square_group', true); notify();
    const create = Array.from(document.querySelectorAll<HTMLButtonElement>('#canvas-tools button')).find((item) => item.textContent === 'Create Warp')!;
    expect(create.disabled).toBe(false); create.click();
    const prompt = await waitFor(() => document.querySelector<HTMLElement>('.ui-dialog'));
    (prompt.querySelector('input') as HTMLInputElement).value = 'Hand turn';
    (prompt.querySelector('.ui-dialog-primary') as HTMLButtonElement).click();
    const panel = await waitFor(() => document.querySelector<HTMLElement>('.warps-panel'));
    expect(Array.from(document.querySelectorAll('[role="tab"]')).map((item) => item.textContent)).toEqual(['Inspector', 'Warps', 'Animate with Claude']);
    expect(document.querySelectorAll('#right-dock > .right-dock-content')).toHaveLength(1);
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe('Warps');
    expect(panel.textContent).toContain('Hand turn'); expect(panel.querySelectorAll('.warp-pair')).toHaveLength(2);
    expect(state.selectedPartIds).toEqual(['triangle_group']);
    state.selectedPartIds = []; state.selectedPartId = null; notify();
    expect(document.querySelector('.warps-panel')?.textContent).toContain('Hand turn');
  });

  it('keys exact percent and synchronizes the lane', () => {
    const exact = document.querySelector<HTMLInputElement>('[aria-label="Warp percent exact value"]')!;
    exact.value = '37.5'; exact.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('.warps-panel button')).find((item) => item.textContent === '◆ Set key')!.click();
    const warp = state.doc!.warps![0];
    expect(state.doc!.clips[0].tracks.find((track) => track.target === warp.id)?.keyframes[0].value).toBe(.375);
    const lane = document.querySelector<HTMLElement>(`[data-warp-lane="${warp.id}"]`)!;
    expect(lane.textContent).toContain('Warp · Hand turn');
    lane.querySelector<HTMLElement>('.tl-lane-label')!.click();
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe('Warps');
  });

  it('isolates Claude and gives the opaque dock an accessible splitter', () => {
    document.getElementById('right-dock-tab-claude')!.click();
    expect(document.querySelector('.ai-panel')).not.toBeNull(); expect(document.querySelector('.warps-panel')).toBeNull();
    document.getElementById('right-dock-tab-warps')!.click();
    const panel = document.querySelector<HTMLElement>('.warps-panel')!;
    expect(getComputedStyle(panel).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    document.getElementById('right-dock-splitter')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.getElementById('layout')!.style.getPropertyValue('--right-dock-width')).toBe('260px');
  });

  it('keeps both endpoints normal in Edit and suppresses target only in Animate', () => {
    state.editorMode = 'setup'; notify(); renderPose();
    const target = document.querySelector<SVGPathElement>('[data-path-id="square_shape_path"]')!;
    expect(target.getAttribute('visibility')).not.toBe('hidden');
    selectPart('square_group'); notify(); expect(state.selectedPartId).toBe('square_group');
    state.editorMode = 'animate'; notify(); renderPose(); expect(target.getAttribute('visibility')).toBe('hidden');
    state.editorMode = 'setup'; notify(); renderPose(); expect(target.getAttribute('visibility')).not.toBe('hidden');
  });

  it('cancels held carrier rotation at 100% so live world geometry equals the target', () => {
    load(); state.activeClipIndex = 1; state.editorMode = 'animate'; state.currentTime = 1500;
    state.warpPreviewActive = false; renderPose();
    const carrier = document.querySelector<SVGPathElement>('[data-path-id="triangle_shape_path"]')!;
    const target = document.querySelector<SVGPathElement>('[data-path-id="square_shape_path"]')!;
    const worldStart = (path: SVGPathElement) => {
      const point = path.getPointAtLength(0); return point.matrixTransform(path.getCTM()!);
    };
    const actual = worldStart(carrier), authored = worldStart(target);
    expect(actual.x).toBeCloseTo(authored.x, 4);
    expect(actual.y).toBeCloseTo(authored.y, 4);
    expect(state.doc!.clips[1].tracks.some((track) => track.target === 'square_group')).toBe(false);

    state.currentTime = 2500; renderPose();
    const reverse = worldStart(carrier);
    expect(Math.hypot(reverse.x - authored.x, reverse.y - authored.y)).toBeGreaterThan(20);
  });

  it('morphs bind-space points before a held two-bone pose without collapse or double skin', () => {
    const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    api.loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: riggedWarpDoc() }));
    state.editorMode = 'animate'; state.currentTime = 1000; renderPose();
    const element = document.querySelector<SVGPathElement>('[data-path-id="arm_source_path"]')!;
    const shadowElement = document.querySelector<SVGPathElement>('[data-path-id="shadow_source_path"]')!;
    const posedSource = element.getAttribute('d')!;
    const posedShadow = shadowElement.getAttribute('d')!;
    state.currentTime = 2000; renderPose();
    const posedTarget = element.getAttribute('d')!;
    expect(posedTarget).not.toBe(posedSource);
    expect(posedTarget).not.toMatch(/NaN|Infinity/);
    expect(element.getBBox().width).toBeGreaterThan(20);
    expect(shadowElement.getAttribute('d')).not.toBe(posedShadow);
    expect(shadowElement.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    state.currentTime = 3000; renderPose();
    expect(element.getAttribute('d')).toBe(posedSource);
    expect(shadowElement.getAttribute('d')).toBe(posedShadow);
  });

  it('renders the supplied Pip project at the independently evaluated horizontal target endpoint', () => {
    const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    api.loadProjectText(JSON.stringify(pipFixture));
    state.editorMode = 'animate'; state.activeClipIndex = 0; state.currentTime = 662; renderPose();
    const warp = state.doc!.warps![0];
    for (const pair of warp.pairs) {
      const expected = serializePath(evaluateRiggedWarpCommands(state.doc!, pair, 1, 662).target);
      const actual = document.querySelector<SVGPathElement>(`[data-path-id="${pair.sourcePathId}"]`)!.getAttribute('d');
      expect(actual).toBe(expected);
    }
    const arm = document.querySelector<SVGPathElement>('[data-path-id="path_877"]')!.getBBox();
    expect(arm.width).toBeGreaterThan(arm.height * 2.5);
    expect(state.doc!.clips[0].tracks.filter((track) => track.target === 'part_879')).toHaveLength(0);

    state.currentTime = 1155; renderPose();
    const returned = document.querySelector<SVGPathElement>('[data-path-id="path_877"]')!.getBBox();
    expect(returned.width).toBeGreaterThan(returned.height * 2);
  });

  it('keeps real Pip Warp endpoints on their ordinary live skins while posing in Edit', () => {
    const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    api.loadProjectText(JSON.stringify(pipFixture));
    state.editorMode = 'setup'; state.freezeMode = false; state.tool = 'ik';
    selectPart('part_876'); notify(); renderPose();

    const arm = () => document.querySelector<SVGPathElement>('[data-path-id="path_877"]')!.getAttribute('d')!;
    const shadow = () => document.querySelector<SVGPathElement>('[data-path-id="path_878"]')!.getAttribute('d')!;
    const armBefore = arm(), shadowBefore = shadow();
    const tip = overlayEl().querySelector<SVGElement>('[data-part-id="part_909"]')!;
    expect(tip, 'real leaf-bone IK handle').toBeTruthy();
    const from = clientCenterOf(tip);
    gestureDrag(from, { x: from.x + 42, y: from.y - 30 }, { steps: 10 });

    expect(arm(), 'main arm visibly deforms from the real Edit-mode pointer drag').not.toBe(armBefore);
    expect(shadow(), 'the separately weighted shadow deforms in the same gesture').not.toBe(shadowBefore);
    const firstPose = arm();
    const movedTip = overlayEl().querySelector<SVGElement>('[data-part-id="part_909"]')!;
    const nextFrom = clientCenterOf(movedTip);
    gestureDrag(nextFrom, { x: nextFrom.x - 28, y: nextFrom.y + 24 }, { steps: 8 });
    const secondPose = arm();
    expect(secondPose, 'a sequential drag keeps deforming continuously').not.toBe(firstPose);
    undo(); renderPose(); expect(arm(), 'one undo restores the first bone pose').toBe(firstPose);
    redo(); renderPose(); expect(arm(), 'redo restores the second bone pose').toBe(secondPose);

    state.editorMode = 'animate'; state.currentTime = 662; renderPose();
    state.editorMode = 'setup'; renderPose();
    expect(arm(), 'returning to Edit restores the authored live rest pose').toBe(secondPose);
  });

  it('a Warp relationship is render-neutral in Edit, including path-scoped pins', () => {
    const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    api.loadProjectText(JSON.stringify(pipFixture));
    state.editorMode = 'setup'; renderPose();
    const ids = ['path_877', 'path_878'];
    const withWarp = ids.map((id) => document.querySelector<SVGPathElement>(`[data-path-id="${id}"]`)!.getAttribute('d'));
    state.doc!.warps = []; renderPose();
    const withoutWarp = ids.map((id) => document.querySelector<SVGPathElement>(`[data-path-id="${id}"]`)!.getAttribute('d'));
    expect(withWarp).toEqual(withoutWarp);

    const source = state.doc!.parts.find((part) => part.id === 'part_876')!;
    expect(source.skin!.overrides?.path_877).toBeTruthy();
    expect(source.skin!.overrides?.path_878, 'shadow pins remain a distinct path record').toBeTruthy();
    source.skin!.overrides = { path_877: source.skin!.overrides!.path_877 };
    renderPose();
    expect(source.skin!.overrides?.path_878, 'editing main-arm pins does not recreate shadow pins').toBeUndefined();
  });
});
