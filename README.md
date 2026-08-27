# ASDF Preview — VSCode extension

Open any `.asdf` file (NASA Roman Space Telescope / JWST calibrated products, or any
ASDF-based data) in VSCode/VSCodium and immediately see:

- a **collapsible tree** of the full metadata (keys, types, values), and
- if a 2-D image-like array is present (e.g. a Roman WFI `data` array), a
  **quick-look image**: grayscale, auto-scaled with a proper *zscale* stretch
  (astropy's `ZScaleInterval` when available), with scroll-to-zoom and drag-to-pan.

Everything renders inside a VSCode webview panel — no notebook, no browser tab,
no JDaviz, no Firefly, no Jupyter kernel. A single small Python backend process
is started once per session and reused for every file you open.

```
┌─ editor tab ────────────────────────────────────────────────┐
│ title  ·  size · parsed via asdf · schema chip              │
│ ┌────────────────────┬────────────────────────────────────┐ │
│ │ metadata           │ [array ▾ data (4096×4096)] Fit 100%│ │
│ │ ▶ meta   (18 keys) │                                    │ │
│ │   ▶ instrument …   │            .-""-.                  │ │
│ │ ▶ data   4096×4096 │          .-'     '-.               │ │
│ │           float32 [show image]  '   ●   '               │ │
│ │ ▶ dq     4096×4096 uint8        '-._____.-'            │ │
│ └────────────────────┴────────────────────────────────────┘ │
│ data · full 4096×4096 · stride 4×4 · zscale [0.02, 0.2] …   │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

| Component | Requirement | Notes |
|---|---|---|
| VSCode / VSCodium | ≥ 1.85 | Custom Editor + webview APIs |
| Python | ≥ 3.10 | auto-detected; see below |
| `asdf` (pip) | required | the only hard dependency of the backend |
| `numpy` (pip) | comes with `asdf` | |
| `astropy` (pip) | optional | proper zscale stretch (falls back to 2–98 percentile) |
| `roman_datamodels` (pip) | optional | Roman-aware parsing (tag handlers); clean fallback to plain `asdf` |
| `Pillow` (pip) | optional | faster PNG encoding; built-in zlib writer is used otherwise |

**Python auto-detection order:** the `asdfPreview.pythonPath` setting → `$ASDF_PREVIEW_PYTHON`
→ `.venv/` next to the extension → your active `$VIRTUAL_ENV` → `python3`/`python` on PATH
(`py -3` on Windows). If nothing works, the webview shows a clear error with install hints.

### Quick setup (dev mode)

```bash
# 1. Python side (from this repo's root)
python3 -m venv .venv
./.venv/bin/pip install asdf            # required
./.venv/bin/pip install astropy         # recommended: proper zscale
./.venv/bin/pip install roman_datamodels asdf-astropy   # optional: Roman products
#    (on Windows use .venv\Scripts\python instead of ./.venv/bin/python)

# 2. Extension side
npm install
npm run compile

# 3. Press F5 ("Run Extension") in VSCode, then open any *.asdf file
```

> If you already have `asdf` installed system-wide (or in the venv VSCode itself
> runs from), skip step 1 entirely — the extension will find it.

### Using a command-line preview instead of the editor?

The same backend doubles as a tiny CLI:

```bash
python3 python/preview_cli.py /path/to/file.asdf            # summary + tree outline
python3 python/preview_cli.py file.asdf --out ql.png        # write quick-look PNG
python3 python/preview_cli.py file.asdf --array pixel_scale # pick a specific array
```

## Usage

1. **Open** an `.asdf` file (double-click in the Explorer). The tree appears first;
   the image follows a moment later if a 2-D array exists.
2. **Zoom/pan** the image: scroll wheel (zoom at cursor), trackpad pinch, drag to pan.
   `Fit` and `100%` buttons reset the view. The status line shows full shape,
   downsample factor, stretch bounds and min/max/mean/σ of the *full* array.
3. **Pick another array** with the dropdown (or the "show image" button next to any
   2-D array in the tree) — e.g. preview `dq` or an error array.
4. Commands:
   - `ASDF Preview: Reload File` — re-read from disk (files also auto-reload when changed).
   - `ASDF Preview: Restart Python Backend` — force a backend respawn (after fixing env issues).
5. Settings (`asdfPreview.*`):
   - `pythonPath` — pin a specific interpreter.
   - `maxImageSide` — preview resolution cap (default 1024 px).
   - `requestTimeoutSeconds` — timeout for slow opens/renders (default 60 s).

### Performance

The Python process (and its `asdf`/`astropy` imports) is started **once**, on first
`.asdf` open, and kept alive. Parsed files are cached in an LRU (4 entries), so:

- repeat opens of the same file return from memory in **sub-millisecond** backend time;
- switching arrays for the image only re-runs the (fast) stretch + PNG stage;
- first open of a ~100 MB WFI frame is typically well under a second.

## Limitations (v1, by design)

- Read-only preview: no editing, no region tools, no WCS/photometry, no catalog overlays.
- Quick-look image is 2-D only; 3-D cubes and spectra show in the tree but are not rendered
  (a "show central slice" toggle is the natural next step — see DEVELOPMENT.md).
- Downsampling uses striding (fast, representative) rather than block averaging; previews
  may miss sub-pixel structure by design.
- Files with tags that require uninstalled Python extensions (e.g. exotic astropy objects
  without `asdf-astropy`) fail to parse and are shown as a clear error, not a crash.
- One preview per open is automatic (the recommended array); everything else is one click away.

## Repository layout

```
src/            TypeScript extension host
  backend/      manager.ts (lifecycle), client.ts (JSONL transport), types.ts (protocol)
  editor.ts     CustomReadonlyEditorProvider for *.asdf
  extension.ts  activation, commands
python/         persistent Python backend
  protocol.py   framing + error model
  inspection.py ASDF opening, LRU cache, tree serialization
  imaging.py    downsample → zscale → 8-bit → PNG
  backend_main.py request loop (entry point)
  preview_cli.py terminal quick-look CLI
media/          webview assets (style.css, main.js — no external dependencies)
testdata/       fixture generator + pipe-level smoke test
test/host_sim.js Node harness driving the compiled manager against the real backend
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the wire protocol spec and design rationale.
