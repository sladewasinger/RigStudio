/**
 * Trigger a browser download of in-memory content — the one primitive every save/export
 * flow (project save, Lottie/.riv export, PNG/SVG image export) shares.
 */
export function download(filename: string, content: string | Uint8Array | Blob, type: string): void {
  const blob = content instanceof Blob ? content : new Blob([content as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
