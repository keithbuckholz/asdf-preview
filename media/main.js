/* ASDF Preview webview logic -- plain JS, no dependencies, fully offline.
 *
 * Talks to the extension host via acquireVsCodeApi().postMessage:
 *   -> {type:'ready'}            script booted; start loading
 *   -> {type:'reload'}           re-open (retry button)
 *   -> {type:'image', array}     render a specific array from the catalog
 *   <- {kind:'status', phase}    'loading' | ...
 *   <- {kind:'tree', record}     full serialized metadata + array catalog
 *   <- {kind:'image', payload}   base64 PNG + stretch/stats meta (null = none)
 *   <- {kind:'error', ...}       {scope:'tree'|'image', code, message, hint?}
 */
'use strict';

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const els = {
  fileTitle: $('file-title'),
  chips: $('chips'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerActions: $('banner-actions'),
  tree: $('tree'),
  arraySelect: $('array-select'),
  btnFit: $('btn-fit'),
  btn100: $('btn-100'),
  canvasWrap: $('canvas-wrap'),
  canvas: $('canvas'),
  placeholder: $('image-placeholder'),
  imageStatus: $('image-status'),
  zoomPct: $('zoom-pct'),
  btnExpandAll: $('btn-expand-all'),
  btnCollapseAll: $('btn-collapse-all'),
  selStretch: $('sel-stretch'),
  selCmap: $('sel-cmap'),
  inGamma: $('in-gamma'),
  inVmin: $('in-vmin'),
  inVmax: $('in-vmax'),
};

const ctx = els.canvas.getContext('2d');

const state = {
  record: null,       // last OpenRecord
  image: null,        // {img: HTMLImageElement, meta: ImageResult}
  view: { scale: 1, x: 0, y: 0 }, // CSS-px space; 1.0 == one image px per screen px
  userTransformed: false,
};

/* ================================================================== messages */

window.addEventListener('message', (e) => {
  const m = e.data || {};
  switch (m.kind) {
    case 'status':
      if (m.phase === 'loading') enterLoading();
      break;
    case 'env':
      fillCapabilities(m.env && m.env.capabilities);
      break;
    case 'tree':
      onTree(m.record);
      break;
    case 'image':
      onImage(m.payload);
      break;
    case 'error':
      showError(m.scope, m.code, m.message, m.hint);
      break;
  }
});

function enterLoading() {
  hideBanner();
  els.tree.innerHTML = '<div class="loading-row"><span class="spinner"></span> opening file…</div>';
  showPlaceholder('<span class="spinner" style="width:18px;height:18px;border-width:3px"></span>', 'rendering quick-look…');
  setChips([]);
}

/* ====================================================================== tree */

function onTree(rec) {
  state.record = rec;
  hideBanner();

  // Titlebar: human name + provenance chips.
  const baseName = rec.path ? rec.path.split(/[\\/]/).pop() : '(unknown)';
  els.fileTitle.textContent = `${rec.title} — ${baseName}`;
  const mb = (rec.size_bytes / 1e6).toFixed(1);
  setChips([
    chip(`${fmtBytes(rec.size_bytes)}`, 'file size'),
    chip(rec.opened_with === 'roman_datamodels' ? 'parsed via roman_datamodels' : 'parsed via asdf', 'backend used'),
    rec.schema_uri ? chip(shortSchema(rec.schema_uri), rec.schema_uri, true) : null,
  ]);

  // Array selector: only previewable (2-D numeric) arrays.
  const previewables = (rec.arrays || []).filter((a) => a.previewable);
  state.arrayPreviewables = previewables;
  els.arraySelect.innerHTML = '';
  if (previewables.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'no 2-D arrays';
    els.arraySelect.appendChild(opt);
    els.arraySelect.disabled = true;
  } else {
    for (const a of previewables) {
      const opt = document.createElement('option');
      opt.value = a.path;
      opt.textContent = `${a.path} (${a.shape.join('×')})`;
      if (rec.preview_array === a.path) opt.selected = true;
      els.arraySelect.appendChild(opt);
    }
    els.arraySelect.disabled = false;
  }

  renderTree(rec.tree);
  if (rec.truncated) {
    const note = document.createElement('div');
    note.className = 'muted-note';
    note.style.padding = '4px 10px';
    note.textContent = '… tree truncated by backend node cap …';
    els.tree.appendChild(note);
  }
}

function setChips(items) {
  els.chips.innerHTML = '';
  for (const c of items) if (c) els.chips.appendChild(c);
}

function chip(text, title, muted) {
  const s = document.createElement('span');
  s.className = 'chip' + (muted ? ' scheme' : '');
  s.textContent = text;
  s.title = title || '';
  return s;
}

function shortSchema(uri) {
  const seg = uri.split('/').pop() || uri;
  return seg.length > 40 ? '…' + seg.slice(-39) : seg;
}

/** Recursively build the DOM for one serialized node under label *name*. */
function renderTree(root) {
  els.tree.innerHTML = '';
  if (!root || root.type === 'omitted') {
    const d = document.createElement('div');
    d.className = 'muted-note';
    d.textContent = '(empty tree)';
    els.tree.appendChild(d);
    return;
  }
  if (root.type === 'object' && root.children) {
    const frag = document.createDocumentFragment();
    for (const [key, child] of Object.entries(root.children)) {
      frag.appendChild(buildEntry(key, child, /*depth*/ 0));
    }
    els.tree.appendChild(frag);
  } else {
    // Root is a scalar/array directly: show it with a neutral label.
    els.tree.appendChild(buildEntry('<root>', root, 0));
  }
}

function buildEntry(name, node, depth) {
  if (!node) return leafEl(name, { type: 'null', value: null });

  if (node.type === 'object' || node.type === 'list') {
    const wrap = document.createElement('div');
    // Single state class: .collapsed hides kids; its absence means open. (Two
    // complementary classes + toggle('open') left collapsed nodes stuck --
    // the click added 'open' but never removed 'collapsed'.)
    wrap.className = depth < 2 ? 'node' : 'node collapsed';
    // Auto-expand the first two levels so Roman files show meta.* at a glance.

    const head = document.createElement('div');
    head.className = 'head';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▶';
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = name;
    nm.title = name;
    head.append(chev, nm);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = node.type === 'object'
      ? `${node.keys ?? '?'} keys`
      : `${fmtNum(node.length ?? '?')} items`;
    if (node.truncated) {
      badge.textContent += '…';
      badge.title = `list longer than ${MAX_LIST_RENDERED}; backend truncated`;
    }
    head.appendChild(badge);

    const kids = document.createElement('div');
    kids.className = 'kids';

    head.addEventListener('click', () => wrap.classList.toggle('collapsed'));

    if (node.type === 'object' && node.children) {
      const frag = document.createDocumentFragment();
      for (const [k, c] of Object.entries(node.children)) {
        frag.appendChild(buildEntry(k, c, depth + 1));
      }
      kids.appendChild(frag);
    } else if (node.type === 'list' && node.items) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < node.items.length; i++) {
        // list indices render as faded labels: [0], [1], ...
        frag.appendChild(buildEntry(`[${i}]`, node.items[i], depth + 1, true));
      }
      kids.appendChild(frag);
    }

    wrap.append(head, kids);
    return wrap;
  }

  return leafEl(name, node, depth);
}

/** Render a scalar / ndarray / omitted node as one row. */
function leafEl(name, node, _depth, isListIdx = false) {
  const el = document.createElement('div');
  el.className = 'leaf';

  if (node.type === 'ndarray') {
    el.classList.add('arr');
    const nm = document.createElement('span');
    nm.className = 'name' + (isListIdx ? ' idx' : '');
    nm.textContent = name;
    el.appendChild(nm);
    if (node.shape) {
      const c1 = document.createElement('span');
      c1.className = 'chip';
      c1.textContent = node.shape.join(' × ');
      el.appendChild(c1);
    }
    if (node.dtype) {
      const c2 = document.createElement('span');
      c2.className = 'chip dtype';
      c2.textContent = node.dtype + (node.masked ? ' [masked]' : '');
      el.appendChild(c2);
    }
    if (node.unit) {
      const c3 = document.createElement('span');
      c3.className = 'chip dtype';
      c3.textContent = node.unit;
      el.appendChild(c3);
    }
    if (node.previewable && state.record && state.arrayPreviewables?.some((a) => a.path === node.path)) {
      const btn = document.createElement('button');
      btn.className = 'preview-btn';
      btn.textContent = 'show image';
      btn.title = `render ${node.path}`;
      btn.addEventListener('click', () => selectAndRequest(node.path));
      el.appendChild(btn);
    }
    return el;
  }

  if (node.type === 'omitted') {
    const nm = document.createElement('span');
    nm.className = 'name muted-note';
    nm.textContent = name + ': …';
    el.appendChild(nm);
    const note = document.createElement('span');
    note.className = 'val muted-note';
    note.textContent = `(truncated: ${node.reason || 'limit'})`;
    el.appendChild(note);
    return el;
  }

  // Scalar leaf.
  const nm = document.createElement('span');
  nm.className = 'name' + (isListIdx ? ' idx' : '');
  nm.textContent = name;
  nm.title = String(name);
  el.appendChild(nm);

  const v = document.createElement('span');
  let text = '';
  switch (node.type) {
    case 'str':
      v.className = 'val v-str';
      text = JSON.stringify(node.value ?? '');
      if (node.truncated) v.title = `value truncated (${node.length} chars total)`;
      break;
    case 'integer':
      v.className = 'val v-int';
      text = String(node.value);
      break;
    case 'number':
      v.className = 'val v-num';
      text = node.value === null && node.representation ? node.representation : String(node.value);
      break;
    case 'bool':
      v.className = 'val v-bool';
      text = String(node.value);
      break;
    case 'null':
      v.className = 'val v-null';
      text = 'null';
      break;
    case 'datetime':
    case 'date':
    case 'time':
      v.className = 'val v-dt';
      text = String(node.value ?? '');
      break;
    case 'quantity':
      v.className = 'val v-qty';
      text = `${node.value === null && node.representation ? node.representation : node.value} ${node.unit || ''}`.trim();
      break;
    case 'bytes':
      v.className = 'val v-other';
      text = node.value ? `b${node.value}…` : `<${node.length} bytes>`;
      v.title = node.value || '';
      break;
    default: // 'other'
      v.className = 'val v-other';
      text = node.value ?? '';
      if (node.class) {
        v.title = node.class;
        text = `<${shortClass(node.class)}> ${truncate(text, 120)}`;
      }
  }
  v.textContent = text;
  el.appendChild(v);
  return el;
}

function selectAndRequest(arrayPath) {
  els.arraySelect.value = arrayPath;
  showPlaceholder('<span class="spinner"></span>', `rendering ${arrayPath}…`);
  setImageStatus('');
  vscode.postMessage({ type: 'image', array: arrayPath, opts: readOpts() });
}

/* ------------------------------------------------- image settings (row 2) */

// Read the current settings row into a backend-contract object. Empty
// vmin/vmax fields are omitted (backend treats "both present" as manual).
function readOpts() {
  const opts = {
    stretch: els.selStretch.value,
    cmap: els.selCmap.value,
  };
  const g = parseFloat(els.inGamma.value);
  if (Number.isFinite(g)) opts.gamma = g;
  for (const [field, key] of [[els.inVmin, 'vmin'], [els.inVmax, 'vmax']]) {
    if (field.value.trim() !== '') {
      const v = parseFloat(field.value);
      if (Number.isFinite(v)) opts[key] = v;
    }
  }
  return opts;
}

function requestWithOpts() {
  const array = els.arraySelect.value;
  if (!array || els.arraySelect.disabled) return; // nothing to re-render
  showPlaceholder('<span class="spinner"></span>', 're-rendering…');
  vscode.postMessage({ type: 'image', array, opts: readOpts() });
}

// Backend told us which stretches/colormaps this interpreter supports.
function fillCapabilities(caps) {
  if (!caps) return; // keep built-in defaults (zscale/gray)
  const apply = (sel, values, fallback) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else sel.value = fallback;
  };
  apply(els.selStretch, caps.stretches, 'zscale');
  apply(els.selCmap, caps.cmaps, 'gray');
}

els.selStretch.addEventListener('change', requestWithOpts);
els.selCmap.addEventListener('change', requestWithOpts);
els.inGamma.addEventListener('change', requestWithOpts);
// Typing a bound implies manual stretch; the backend enforces the pair.
for (const el of [els.inVmin, els.inVmax]) {
  el.addEventListener('focus', () => {
    if (els.selStretch.value !== 'manual' &&
        [...els.selStretch.options].some((o) => o.value === 'manual')) {
      els.selStretch.value = 'manual';
    }
  });
  el.addEventListener('change', requestWithOpts);
}

// constant mirrors python/inspection.py MAX_LIST_ITEMS (for badge tooltips)
const MAX_LIST_RENDERED = 256;

/* ===================================================================== image */

function onImage(payload) {
  if (!payload) {
    // Deliberate "no image": the file has no 2-D array.
    showPlaceholder(null, 'No 2-D image-like arrays found in this file.\nThe metadata tree on the left is still fully available.');
    setImageStatus('');
    els.zoomPct.textContent = '';
    state.image = null;
    clearCanvas();
    return;
  }

  const img = new Image();
  showPlaceholder('<span class="spinner"></span>', 'decoding preview…');
  const prevMeta = state.image ? state.image.meta : null;
  img.onload = () => {
    state.image = { img, meta: payload };
    hidePlaceholder();
    // Same raster dimensions (a settings tweak of the current array) -> keep
    // the user's zoom/pan; a different array/resolution -> fit again.
    const sameDims = prevMeta &&
      prevMeta.width === payload.width && prevMeta.height === payload.height;
    if (!sameDims) { state.userTransformed = false; fitToPane(); }
    else draw();
    setImageStatus(payload);
    updateZoomPct();
  };
  img.onerror = () => {
    showError('image', 'E_INTERNAL', 'Failed to decode the preview PNG returned by the backend.');
  };
  img.src = `data:image/png;base64,${payload.png}`;
}

function fitToPane() {
  const { img } = state.image;
  const r = els.canvasWrap.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  const f = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) * 0.98;
  state.view = {
    scale: f,
    x: (r.width - img.naturalWidth * f) / 2,
    y: (r.height - img.naturalHeight * f) / 2,
  };
  state.userTransformed = false;
  draw();
  updateZoomPct();
}

function set100Percent() {
  if (!state.image) return;
  const r = els.canvasWrap.getBoundingClientRect();
  // Keep the current image center put while snapping scale to 1:1.
  const cx = r.width / 2, cy = r.height / 2;
  const v = state.view;
  const wx = (cx - v.x) / v.scale, wy = (cy - v.y) / v.scale;
  state.view = { scale: 1, x: cx - wx, y: cy - wy };
  state.userTransformed = true;
  draw();
  updateZoomPct();
}

function zoomAt(cx, cy, factor) {
  const v = state.view;
  const ns = clamp(v.scale * factor, 0.01, 64);
  const k = ns / v.scale;
  // Keep the world point under the cursor fixed while scaling.
  state.view = { scale: ns, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  state.userTransformed = true;
  draw();
  updateZoomPct();
}

function clearCanvas() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function draw() {
  syncCanvasSize();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  if (!state.image) return;
  const { img } = state.image;
  const s = state.view.scale * dpr;
  // Crisp pixels when an image pixel maps to >= ~3 screen px; smooth upscale
  // otherwise (fit-view of a downsampled array looks better anti-aliased).
  ctx.imageSmoothingEnabled = state.view.scale < 3;
  ctx.setTransform(s, 0, 0, s, state.view.x * dpr, state.view.y * dpr);
  ctx.drawImage(img, 0, 0);
}

function syncCanvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.canvasWrap.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
}

function updateZoomPct() {
  els.zoomPct.textContent = state.image ? `zoom ${Math.round(state.view.scale * 100)}%` : '';
}

function setImageStatus(meta) {
  if (!meta) {
    els.imageStatus.innerHTML = '&nbsp;';
    return;
  }
  const st = meta.stats || {};
  const parts = [
    `${meta.array_path}`,
    `full ${meta.full_shape.join('×')}`,
    meta.downsample_factor.some((f) => f > 1) ? `stride ${meta.downsample_factor.join('×')}` : null,
    `stretch: ${meta.stretch.algorithm} [${fmt(meta.stretch.vmin)}, ${fmt(meta.stretch.vmax)}]`,
    (meta.stretch.gamma ?? 1) !== 1 ? `γ=${meta.stretch.gamma}` : null,
    meta.stretch.cmap && meta.stretch.cmap !== 'gray' ? `cmap: ${meta.stretch.cmap}` : null,
    st.min !== null && st.max !== null ? `min ${fmt(st.min)}  max ${fmt(st.max)}` : null,
    st.mean !== null ? `mean ${fmt(st.mean)}  σ ${fmt(st.std)}` : null,
    meta.note || null,
  ].filter(Boolean);
  els.imageStatus.textContent = parts.join('   ·   ');
}

/* -------------------------------------------------------------- image input */

els.canvas.addEventListener('wheel', (e) => {
  if (!state.image) return;
  e.preventDefault();
  const r = els.canvas.getBoundingClientRect();
  // Trackpad pinch arrives as ctrlKey wheel events in Chromium.
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
  zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
}, { passive: false });

let panning = null;
els.canvas.addEventListener('pointerdown', (e) => {
  if (!state.image || e.button !== 0 && e.button !== 1) return;
  panning = { x: e.clientX, y: e.clientY };
  els.canvas.classList.add('grabbing');
  els.canvas.setPointerCapture(e.pointerId);
});
els.canvas.addEventListener('pointermove', (e) => {
  if (!panning) return;
  const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
  panning = { x: e.clientX, y: e.clientY };
  state.view.x += dx;
  state.view.y += dy;
  state.userTransformed = true;
  draw();
});
const endPan = (e) => {
  if (!panning) return;
  panning = null;
  els.canvas.classList.remove('grabbing');
  try { els.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
};
els.canvas.addEventListener('pointerup', endPan);
els.canvas.addEventListener('pointercancel', endPan);

// Tree-wide view controls. The tree is fully rendered in the DOM (backend
// caps it at 20k nodes), so a single class sweep covers everything.
function setAllNodesCollapsed(collapsed) {
  const nodes = els.tree.querySelectorAll('.node');
  for (const n of nodes) n.classList.toggle('collapsed', collapsed);
}
els.btnExpandAll.addEventListener('click', () => setAllNodesCollapsed(false));
els.btnCollapseAll.addEventListener('click', () => setAllNodesCollapsed(true));

els.btnFit.addEventListener('click', () => state.image && fitToPane());
els.btn100.addEventListener('click', set100Percent);
els.arraySelect.addEventListener('change', () => {
  if (els.arraySelect.value) selectAndRequest(els.arraySelect.value);
});

// Keep the canvas backing store in sync with pane resizes; refit untouched
// views, merely redraw user-transformed ones.
new ResizeObserver(() => {
  if (!state.image) { syncCanvasSize(); return; }
  if (!state.userTransformed) fitToPane();
  else draw();
}).observe(els.canvasWrap);

/* ====================================================================== misc */

function showPlaceholder(spinnerHtml, text) {
  els.placeholder.classList.remove('hidden');
  els.placeholder.innerHTML = '';
  if (spinnerHtml) {
    const s = document.createElement('div');
    s.innerHTML = spinnerHtml;
    els.placeholder.appendChild(s.firstElementChild);
  }
  const t = document.createElement('div');
  t.className = 'ph-text';
  t.textContent = text || '';
  els.placeholder.appendChild(t);
}

function hidePlaceholder() {
  els.placeholder.classList.add('hidden');
}

function showError(scope, code, message, hint) {
  if (scope === 'image') {
    // Tree stays usable: report inside the image pane only.
    showPlaceholder(null, `Image unavailable (${code})\n\n${message}${hint ? '\n\n' + hint : ''}`);
    setImageStatus('');
    return;
  }

  // Whole-file failure (no python / no asdf / parse error / backend died).
  const isEnvProblem = code === 'E_NO_PYTHON' || code === 'E_NO_ASDLIB';
  els.banner.classList.remove('hidden');
  els.banner.classList.toggle('warn', !isEnvProblem);
  let text = `${code}: ${message}`;
  if (hint) text += '\n\n' + hint;
  if (code === 'E_BACKEND_DIED') text += '\n\nThe extension will retry automatically on the next load.';
  els.bannerText.textContent = text;

  els.bannerActions.innerHTML = '';
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', hideBanner);
  els.bannerActions.append(retry, dismiss);

  if (scope === 'tree') {
    els.tree.innerHTML = '<div class="muted-note" style="padding:8px 12px">metadata unavailable — see error above</div>';
  }
}

function hideBanner() {
  els.banner.classList.add('hidden');
}

/* ------------------------------------------------------------------ helpers */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmtNum(n) {
  if (n == null) return '?';
  n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : String(n);
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1e6).toFixed(1) + ' MB';
}

function fmt(x) {
  if (x === null || x === undefined) return '–';
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(2);
  return String(Number(n.toPrecision(5)));
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortClass(cls) {
  const parts = String(cls).split('.');
  return parts[parts.length - 1];
}

/* Boot: tell the extension host we are ready to receive data. */
vscode.postMessage({ type: 'ready' });
