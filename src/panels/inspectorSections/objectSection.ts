import { state, notify, selectedPath, ensureArtboard } from '../../core/model';
import { renderPose, updatePathAttrs, partRootBoxes } from '../../view';
import { checkpoint } from '../../core/history';
import { numberField, colorField } from './shared';

/** Style editor for the "entered" path (fill/stroke), Setup mode only. */
export function buildPathSection(el: HTMLElement): void {
  const sel = selectedPath();
  if (!sel) return;
  const { path } = sel;

  const title = document.createElement('h3');
  title.textContent = `object: ${path.label}`;
  el.appendChild(title);

  const apply = () => {
    updatePathAttrs(path);
    renderPose();
  };

  el.appendChild(colorField('fill', path.fill, (v) => {
    checkpoint();
    path.fill = v;
    apply();
  }));
  el.appendChild(numberField('fill opacity', path.fillOpacity, (v) => {
    checkpoint();
    path.fillOpacity = Math.min(1, Math.max(0, v));
    apply();
  }, 0.05));
  el.appendChild(colorField('stroke', path.stroke, (v) => {
    checkpoint();
    path.stroke = v;
    apply();
  }));
  el.appendChild(numberField('stroke width', path.strokeWidth, (v) => {
    checkpoint();
    path.strokeWidth = Math.max(0, v);
    apply();
  }, 0.1));
  el.appendChild(numberField('stroke opacity', path.strokeOpacity, (v) => {
    checkpoint();
    path.strokeOpacity = Math.min(1, Math.max(0, v));
    apply();
  }, 0.05));

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Escape or a blank canvas click exits the object. Node editing scopes to it.';
  el.appendChild(hint);
}

// ---- Artboard (page frame) ----

/** Document-properties spot: shown in Edit mode with nothing selected. */
export function buildArtboardSection(el: HTMLElement): void {
  const doc = state.doc!;
  // ensureArtboard seeds a disabled default from viewBox for docs that never went
  // through normalizeDoc (a fresh SVG import); it's a structural default, not a user
  // edit, so no checkpoint here.
  const ab = ensureArtboard(doc);

  const docTitle = document.createElement('h3');
  docTitle.textContent = 'Document';
  el.appendChild(docTitle);
  el.appendChild(numberField('fps', doc.fps ?? 60, (v) => {
    checkpoint();
    doc.fps = Math.max(1, Math.round(v));
    notify(); // the timeline's frames readout reads doc.fps live
  }, 1));

  const title = document.createElement('h3');
  title.textContent = 'Artboard';
  el.appendChild(title);

  const enabledRow = document.createElement('label');
  enabledRow.className = 'field';
  const enabledSpan = document.createElement('span');
  enabledSpan.textContent = 'enabled';
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  // The global `input, select, textarea { width: 100% }` rule (style.css) otherwise
  // stretches a bare checkbox into a full-width box; other checkboxes in this panel
  // sidestep it via a wrapping class (.color-wrap, .ai-panel) — inline style here
  // since this one isn't in either wrapper.
  enabledInput.style.width = 'auto';
  enabledInput.checked = ab.enabled;
  enabledInput.onchange = () => {
    checkpoint();
    ab.enabled = enabledInput.checked;
    renderPose();
  };
  enabledRow.appendChild(enabledSpan);
  enabledRow.appendChild(enabledInput);
  el.appendChild(enabledRow);

  el.appendChild(numberField('x', ab.x, (v) => {
    checkpoint();
    ab.x = v;
    renderPose();
  }));
  el.appendChild(numberField('y', ab.y, (v) => {
    checkpoint();
    ab.y = v;
    renderPose();
  }));
  el.appendChild(numberField('width', ab.w, (v) => {
    checkpoint();
    ab.w = Math.max(1, v);
    renderPose();
  }));
  el.appendChild(numberField('height', ab.h, (v) => {
    checkpoint();
    ab.h = Math.max(1, v);
    renderPose();
  }));

  const grid = document.createElement('div');
  grid.className = 'align-grid';

  const fromArtwork = document.createElement('button');
  fromArtwork.textContent = 'from artwork';
  fromArtwork.title = 'Fit the artboard to the union bounding box of all artwork';
  fromArtwork.onclick = () => {
    const ids = doc.parts.map((p) => p.id);
    const boxes = partRootBoxes(ids);
    if (boxes.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes.values()) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    checkpoint();
    ab.x = minX;
    ab.y = minY;
    ab.w = Math.max(1, maxX - minX);
    ab.h = Math.max(1, maxY - minY);
    renderPose();
    notify();
  };
  grid.appendChild(fromArtwork);

  const fromViewBox = document.createElement('button');
  fromViewBox.textContent = 'from viewBox';
  fromViewBox.title = 'Reset the artboard to the imported SVG viewBox';
  fromViewBox.onclick = () => {
    checkpoint();
    ab.x = doc.viewBox.x;
    ab.y = doc.viewBox.y;
    ab.w = doc.viewBox.w;
    ab.h = doc.viewBox.h;
    renderPose();
    notify();
  };
  grid.appendChild(fromViewBox);
  el.appendChild(grid);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Optional page frame, drawn behind the artwork. When enabled, ' +
    'exports (Rive/Lottie) use it as their reference frame instead of the viewBox.';
  el.appendChild(hint);
}
