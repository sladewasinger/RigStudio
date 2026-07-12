/**
 * Still-image export: PNG (rasterized current frame) and SVG (serialized current
 * pose), both excluding overlay/artboard chrome. Shares the SVG-clone rasterizer
 * with the AI assistant's pose snapshot (ui/snapshot.ts) and the toolbar's existing
 * filename-dialog pattern (ui/dialogs.ts's `dialog.form`).
 */
import { state, artboardFrame } from '../core/model';
import { partRootBoxes } from '../view';
import { dialog, DialogFormField } from './dialogs';
import { cloneArtworkSvg, serializeArtworkSvg, rasterizeSvg } from './snapshot';
import { download } from './download';

type Box = { x: number; y: number; w: number; h: number };

/** Root-space AABB union of the current selection's art parts (partless bones/groups
 *  contribute no box — see view/pose.ts's partRootBoxes), or null if none measurable. */
function selectionBox(): Box | null {
  const boxes = [...partRootBoxes(state.selectedPartIds).values()];
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The frame to export: the selection's bbox when requested and measurable, else the
 *  document's artboard frame (the enabled artboard rect, or the whole viewBox). */
function exportBox(selectionOnly: boolean): Box {
  const doc = state.doc!;
  if (selectionOnly) {
    const box = selectionBox();
    if (box && box.w > 0 && box.h > 0) return box;
  }
  return artboardFrame(doc);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /data:(.*?);base64/.exec(meta)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Toolbar/menu enablement: nothing to export without a loaded document. */
export function canExportImage(): boolean {
  return !!state.doc;
}

export async function exportPngFlow(): Promise<void> {
  const doc = state.doc;
  if (!doc) return;
  const hasSelection = state.selectedPartIds.length > 0;
  const fields: DialogFormField[] = [
    { name: 'filename', label: 'Filename', value: `${doc.name}.png` },
    { name: 'scale', label: 'Scale', type: 'select', value: '1',
      options: [{ value: '1', label: '@1x' }, { value: '2', label: '@2x' }] },
  ];
  if (hasSelection) {
    fields.push({ name: 'selectionOnly', label: 'Export selection only', type: 'checkbox', checked: false });
  }
  const result = await dialog.form('Export PNG', fields, { okText: 'Export' });
  if (!result) return;
  const filename = String(result.filename || `${doc.name}.png`);
  const scale = result.scale === '2' ? 2 : 1;
  const box = exportBox(hasSelection && !!result.selectionOnly);
  const clone = cloneArtworkSvg({ stripArtboard: true, box });
  if (!clone) return;
  const outW = Math.max(1, Math.round(box.w * scale));
  const outH = Math.max(1, Math.round(box.h * scale));
  const dataUrl = await rasterizeSvg(clone, outW, outH); // no background fill -> transparent
  download(filename, dataUrlToBlob(dataUrl), 'image/png');
}

export async function exportSvgFlow(): Promise<void> {
  const doc = state.doc;
  if (!doc) return;
  const hasSelection = state.selectedPartIds.length > 0;
  const fields: DialogFormField[] = [
    { name: 'filename', label: 'Filename', value: `${doc.name}.svg` },
  ];
  if (hasSelection) {
    fields.push({ name: 'selectionOnly', label: 'Export selection only', type: 'checkbox', checked: false });
  }
  const result = await dialog.form('Export SVG', fields, { okText: 'Export' });
  if (!result) return;
  const filename = String(result.filename || `${doc.name}.svg`);
  const box = exportBox(hasSelection && !!result.selectionOnly);
  const clone = cloneArtworkSvg({ stripArtboard: true, box });
  if (!clone) return;
  clone.setAttribute('width', String(Math.max(1, Math.round(box.w))));
  clone.setAttribute('height', String(Math.max(1, Math.round(box.h))));
  const text = serializeArtworkSvg(clone);
  download(filename, `<?xml version="1.0" encoding="UTF-8"?>\n${text}`, 'image/svg+xml');
}
