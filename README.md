# ASDF Preview — VSCode extension

Open any `.asdf` file (NASA Roman Space Telescope / JWST calibrated products, or any
ASDF-based data) in VSCode/VSCodium and immediately see:

- a **collapsible tree** of the full metadata (keys, types, values), and
- if a 2-D image-like array is present (e.g. a Roman WFI `data` array), a
  **quick-look image**: auto-scaled, with scroll-to-zoom and drag-to-pan.
  Stretch is selectable — *zscale* by default (astropy's `ZScaleInterval`
  when available), plus linear / percentile / manual bounds and γ — as is the
  colormap (gray always; matplotlib's cmaps when it is installed).

Everything renders inside a VSCode webview panel — no notebook, no browser tab,
no JDaviz, no Firefly, no Jupyter kernel. A single small Python backend process
starts on first `.asdf` open and is then reused for every file you open.

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
| `Pillow` (pip) | optional | faster PNG encoding; **required** for non-gray colormaps — the built-in gray-only zlib writer is used otherwise |
| `matplotlib` (pip) | optional | named colormaps (viridis, plasma, …); without it only `gray` renders |

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
./.venv/bin/pip install pillow matplotlib     # optional: colormaps (+ faster PNG)
#    (on Windows use .venv\Scripts\python instead of ./.venv/bin/python)

# 2. Extension side
npm install
npm run compile

# 3. Press F5 ("Run Extension (ASDF Preview)") in VSCode, then open any *.asdf file
```

> If you already have `asdf` installed system-wide (or in the venv VSCode itself
> runs from), skip step 1 entirely — the extension will find it.

### ⚠️ After installing/updating the extension: reload the window

VSCode keeps running extensions in memory. If you install or update this
extension while a window is already open, **run `Developer: Reload Window` (or
restart) before opening `.asdf` files** — otherwise the new version is not
actually what gets activated, and you can't tell which build a failure came
from.

(v0.1.1+ also logs activation and per-open diagnostics to the **ASDF Preview**
output channel, so any remaining failure mode is visible there instead of as
an opaque workbench assertion.)

### Using a command-line preview instead of the editor?

The same backend doubles as a tiny CLI (it reuses the exact inspection/imaging
modules, so what you see matches the webview). Run it with an interpreter that
has `asdf` (e.g. your `.venv`) and any absolute or relative file path:

```bash
python3 python/preview_cli.py file.asdf                  # summary + outline; writes <file>.quicklook.png by default
python3 python/preview_cli.py file.asdf --no-image       # summary + tree outline only
python3 python/preview_cli.py file.asdf --out ql.png     # quick-look PNG to a specific path
python3 python/preview_cli.py file.asdf --array pixel_scale   # pick a specific array
```

Other flags: `--max-side N` (default 1024, clamped to 64–4096) and
`--tree-depth D` (outline depth, default 3); see `--help`.

## Usage

1. **Open** an `.asdf` file (double-click in the Explorer). The tree appears first;
   the image follows a moment later if a 2-D array exists.
2. **Zoom/pan** the image: scroll wheel (zoom at cursor), trackpad pinch, drag to pan.
   `Fit` and `100%` buttons reset the view. The status line shows full shape,
   downsample factor, stretch bounds and min/max/mean/σ of the *full* array
   (γ and colormap are shown when they differ from defaults).
3. **Pick another array** with the dropdown (or the "show image" button next to any
   2-D array in the tree) — e.g. preview `dq` or an error array.
4. **Tune the render** with the settings row: stretch (zscale / linear /
   percentile / manual), colormap, γ, and manual vmin/vmax bounds — changes
   re-render the current array without re-parsing. Non-gray colormaps need
   `matplotlib` in the backend interpreter.
5. Commands:
   - `ASDF Preview: Reload File` — re-read from disk (files also auto-reload when changed).
   - `ASDF Preview: Restart Python Backend` — force a backend respawn (after fixing env issues).
6. Settings (`asdfPreview.*`):
   - `pythonPath` — pin a specific interpreter (empty by default = auto-detect;
     see the detection order under Requirements).
   - `maxImageSide` — max preview side in pixels (default 1024, range 64–4096);
     larger arrays are stride-downsampled to it.
   - `requestTimeoutSeconds` — per-request timeout for slow opens/renders
     (default 60 s, range 5–600).

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

### Real Roman / JWST files: install the tag handlers too

Plain `asdf` can't load products that embed WCS objects (grism/slits L2 files,
anything with gwcs models): parsing dies with an error about unrecognizable
tags like `tag:stsci.edu:gwcs/...`. The webview shows this as a clear error
with the fix. One extra install is all it takes:

```bash
./.venv/bin/pip install gwcs              # WCS objects (required for many L2 files)
./.venv/bin/pip install roman_datamodels  # optional: full Roman-aware parsing
```

Then `ASDF Preview: Restart Python Backend`.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Webview shows `E_NO_PYTHON` / `E_NO_ASDLIB` | Set `asdfPreview.pythonPath` to an interpreter that has `pip install asdf` done. |
| Workbench error `Assertion Failed: Argument is undefined or null` when opening `.asdf` | An exception escaped the extension's editor resolver (historically a detached `webview.asWebviewUri` call; fixed in 0.1.2). The **ASDF Preview** output channel now logs the full stack — open View ▸ Output, pick "ASDF Preview", and check for a `resolveCustomEditor FAILED` line. If it still happens on ≥0.1.2, report that log. |
| Nothing changed after installing/updating | Reload the window (`Developer: Reload Window`) so the in-memory extension matches disk. |
| `E_PARSE … tag:…gwcs…` / unknown model type | Install `gwcs` (and/or `roman_datamodels`) into the backend interpreter, then restart the backend. |
| Tree appears but image says nothing to render | File genuinely has no 2-D array — the tree is still fully usable. |

## Testing

- `npm run smoke` — end-to-end wire-protocol test against the real backend
  (handshake, cold/hot opens, tree caps, stretch/colormap options, PNG validity,
  error paths, clean shutdown). It uses your PATH `python3`; if that lacks
  `asdf`, run `.venv/bin/python testdata/smoke_test.py` instead.
- `testdata/generate.py` — regenerates the fixtures `small.asdf` (~1 MB) and
  `big.asdf` (~109 MB): `.venv/bin/python testdata/generate.py`.
- `test/host_sim.js` — drives the compiled manager (and editor provider) against
  the real backend in plain Node, including SIGKILL → auto-respawn. Run after
  `npm run compile`: `node test/host_sim.js`.

Coverage table and rationale: DEVELOPMENT.md §7.

## Packaging / release

Shippable `.vsix` builds are supported (`@vscode/vsce` is a devDependency; the
repo keeps exactly one versioned artifact at the root). From the repo root:

```bash
rm -f asdf-preview-0.*.vsix                                    # drop stale artifacts first
npx vsce package --allow-missing-repository --skip-license     # -> asdf-preview-<version>.vsix
codium --install-extension $PWD/asdf-preview-<new>.vsix        # then Developer: Reload Window
```

Full procedure, and how to verify what actually got installed: DEVELOPMENT.md §7a.

## Repository layout

```
src/            TypeScript extension host
  backend/      manager.ts (lifecycle), client.ts (JSONL transport), types.ts (protocol)
  editor.ts     CustomReadonlyEditorProvider for *.asdf
  extension.ts  activation, commands
python/         persistent Python backend
  protocol.py   framing + error model
  inspection.py ASDF opening, LRU cache, tree serialization
  imaging.py    downsample → stretch → 8-bit → PNG (+ full-array stats)
  backend_main.py request loop (entry point)
  preview_cli.py terminal quick-look CLI
media/          webview assets (style.css, main.js — no external dependencies)
testdata/       fixture generator, generated fixtures (small/big .asdf) + pipe-level smoke test
test/host_sim.js Node harness driving the compiled manager + editor provider against the real backend
```

See DEVELOPMENT.md for the wire protocol spec and design rationale.
