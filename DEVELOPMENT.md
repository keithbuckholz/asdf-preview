# DEVELOPMENT.md — ASDF Preview architecture & protocol

Contributor-facing document. The user guide lives in [README.md](README.md).

## 1. Architecture at a glance

```
 VSCode extension host (TypeScript)                Python backend (one process, whole session)
 ┌──────────────────────────────────────┐          ┌────────────────────────────────────────┐
 │ AsdfEditorProvider (src/editor.ts)   │  spawn   │ python/backend_main.py                 │
 │   • CustomReadonlyEditorProvider     ├─────────▶│   request loop (single thread)         │
 │   • webview panel + messages         │ stdin ──▶│   h_status / h_open / h_image / h_close│
 │ BackendManager (src/backend/manager) │          │        │                               │
 │   • python detection, lifecycle      │ stdout ◀─┤        ├─ inspection.py  (open, LRU    │
 │   • restart throttling, status bar   │   JSONL  │        │        cache, tree serialize) │
 │ BackendProcess (src/backend/client)  │          │        └─ imaging.py     (downsample → │
 │   • line framing, id-matching,       │          │            zscale → u8 → PNG)          │
 │   • timeouts, orphan-frame drops     │          │                                          │
 └──────────────┬───────────────────────┘          └────────────────────────────────────────┘
                │ postMessage (tree JSON / base64 PNG / errors)
        ┌───────▼────────┐
        │ webview        │  media/main.js + style.css — no network, no CDN, no runtime deps
        │ tree | canvas  │  zoom/pan in plain JS; images arrive as data: URLs
        └────────────────┘
```

Data flow per file open: `open` request → backend returns the serialized tree **and** an
array catalog → extension posts the tree to the webview immediately → then requests the
recommended array's PNG → posts it when ready. The UI never blocks on the image.

## 2. Why a persistent backend (not spawn-per-file)

1. **Import cost is dominant and one-time.** Python + `asdf` (+ `astropy`, optionally
   `roman_datamodels`) takes ~0.5–3 s to import depending on machine. A spawn-per-file
   design pays this for *every* open; the whole point of "well under a second, especially
   on repeat opens" is impossible without persistence.
2. **Parsed files are expensive and reusable.** An `asdf.open()` of a 100 MB WFI frame
   materializes arrays in RAM (or lazy block views — asdf ≥4). The backend keeps an LRU of
   4 parsed files keyed by `(mtime_ns, size)`: re-opening the same file is served from
   memory in **<1 ms** (measured 0.5 ms server-side), and array switches for the image
   skip parsing entirely.
3. **One process is trivially testable.** The backend speaks a line-oriented protocol on
   stdin/stdout, so it can be driven by `printf`, by `testdata/smoke_test.py`, or by any
   other language's child-process API — no sockets, ports, or OS-specific naming involved.

**Why JSON-lines over stdio instead of Unix domain sockets / named pipes?**

- **Portability.** UDS paths and Windows named pipes (`\\.\pipe\...`) differ per OS;
  stdio pipes are identical everywhere VSCode runs.
- **No address management.** No port allocation, no socket-path length limits (a classic
  macOS pain), nothing to clean up if the extension host dies (the child simply EOFs on
  stdin and exits).
- **VSCode already gives us a supervised child** with structured stdio streams, exit codes,
  and signals — using it for the transport adds zero new machinery.
- **Backpressure is not an issue at this scale.** Frames are ≤ hundreds of KB; pipes buffer
  far more than one frame before blocking, which is exactly the flow control we want.
  (The LSP-style framing choice is deliberate: newline-delimited JSON is the same family.)

## 3. Wire protocol (normative)

Transport: UTF-8, one JSON object per line (`\n` terminated). **Only** complete frames are
ever written to stdout; anything non-protocol goes to stderr. Max frame: 50 MB — a longer
line aborts the session (client kills & restarts).

### 3.1 Frames

```jsonc
// request (client -> server)
{ "id": 42, "method": "open", "params": { "path": "/abs/file.asdf" } }   // params optional

// success (server -> client)
{ "id": 42, "ok": true,  "result": { ... } }

// error (server -> client)
{ "id": 42, "ok": false, "error": { "code": "E_PARSE", "message": "...", "hint": "..." } }
```

Rules:

- `id` is an opaque integer chosen by the **client**; the server only echoes it and keeps
  no per-client state (the backend is single-client by construction).
- A malformed line that carries a recoverable `id` gets an `E_BAD_REQUEST` error frame;
  without one it is logged to stderr and dropped (responding with a null-id frame would
  desync clients that don't expect unsolicited messages).
- Responses may arrive **late** — after the client timed out. Clients must ignore frames
  whose id has no pending request ("orphans"). This is what makes client-side timeouts
  safe without killing the process: the server keeps going, the late answer is dropped.
- A client restart renumbers ids from 1; any orphaned in-flight frame on a *new*
  connection is impossible because each connection is a fresh process.

### 3.2 Methods

`status` — no params. Always succeeds (even without `asdf`); used as the spawn handshake.

```jsonc
{ "python": "3.14.7", "asdf": "5.3.1" | null, "numpy": "2.5.2",
  "has_roman_datamodels": false,
  "stretch_backend": "astropy ZScaleInterval" | "percentile(2-98) fallback",
  "pid": 1234 }
```

`ping` → `{ "pong": true, "uptime_s": 12.3 }`

`open` — params: `path: string` (absolute). Result (the **OpenRecord**):

```jsonc
{ "uri": "file:///…", "path": "/abs/file.asdf", "size_bytes": 109123456,
  "mtime_ns": 1718000000000000000,
  "title": "wfi_image",                          // from schema_uri, else file stem
  "schema_uri": "http://stsci.edu/schemas/roman/wfi_image-1.0.0" | null,
  "opened_with": "asdf" | "roman_datamodels",
  "asdf_version": "5.3.1",
  "tree": <TreeNode>,                            // see 3.3
  "truncated": false,                            // node cap hit during serialization?
  "arrays": [                                    // document-order catalog of every ndarray
    { "path": "data", "shape": [4096, 4096], "dtype": "float32", "nbytes": 67108864,
      "previewable": true, "recommended": true } ],
  "preview_array": "data" | null }               // first previewable in document order
```

Caching: if the file's `(mtime_ns, size)` matches a cached entry, the same serialized
record is returned without re-parsing. LRU evicts beyond 4 entries (closes the `AsdfFile`).

`image` — params: `path`, optional `array_path` (defaults to `preview_array`),
optional `max_side` (int, clamped to 64–4096). Result:

```jsonc
{ "array_path": "data",
  "png": "<base64, 8-bit grayscale>",
  "width": 1024, "height": 1024,                  // rendered (downsampled) size
  "full_shape": [4096, 4096],
  "downsample_factor": [4, 4],
  "stretch": { "algorithm": "astropy ZScaleInterval", "vmin": 0.0186, "vmax": 0.201 },
  "stats": { "min": -0.025, "max": 3.214, "mean": 0.082, "std": 0.0599,
             "finite_fraction": 0.9961, "sampled": false },   // over the FULL array
  "note": "optional, e.g. 'array contains no finite values'" }
```

`close` — params: `path`. Result `{ "closed": true|false }`. Releases the LRU slot when an
editor tab is disposed (keeps backend RAM bounded; reopening re-parses if stale).

### 3.3 TreeNode shapes

All node kinds are objects with a `type` discriminator:

| type | fields |
|---|---|
| `object` | `keys`, `children: {name: TreeNode}` (document order) |
| `list` | `length`, `truncated`, `items: TreeNode[]` (first 256) |
| `ndarray` | `path` (dotted), `shape`, `dtype`, `nbytes`, `masked?`, `unit?`, `previewable`, `recommended?` |
| `integer` / `number` / `bool` / `null` / `str` / `datetime` / `date` / `time` / `bytes` / `quantity` | `value` (+ `unit` for quantity; `truncated`+`length` for long strings) |
| `other` | `class`, `value` (repr, truncated) — anything exotic still shows something |
| `omitted` | `reason` — emitted when the node budget is exhausted |

Non-finite numbers never appear as JSON NaN/Inf literals (JS `JSON.parse` rejects them);
they are encoded as `"value": null, "representation": "NaN" | "Infinity" | "-Infinity"`.

### 3.4 Error codes

| code | raised by | meaning / UI behavior |
|---|---|---|
| `E_BAD_REQUEST` | server | bad params / unknown method |
| `E_FILE_NOT_FOUND` | server | path missing / not a regular file |
| `E_PARSE` | server | asdf/roman_datamodels couldn't parse (message includes the cause) |
| `E_NO_ASDLIB` | server | backend's interpreter lacks `asdf` → webview shows install hint |
| `E_NO_ARRAY` | server | no 2-D array at requested path / in file |
| `E_BAD_ARRAY` | server | array exists but isn't previewable (ndim, dtype) |
| `E_INTERNAL` | server | unexpected exception; traceback on stderr |
| `E_NO_PYTHON` | **client** | no usable interpreter found (install hint in webview) |
| `E_TIMEOUT` | **client** | request exceeded its deadline |
| `E_BACKEND_DIED` | **client** | process exited / failed to start; stderr tail attached |

### 3.5 Concurrency & ordering

The server is single-threaded and processes requests in arrival order. That matches the
realistic workload (one user, one active editor) and removes any need for locks around the
file cache. The client serializes nothing — multiple panels may have outstanding requests;
id-matching keeps responses attributed correctly.

## 4. Backend lifecycle (extension host)

State machine in `src/backend/manager.ts`:

```
 stopped ──first request──▶ starting ──status handshake ok──▶ ready
    ▲                           │  spawn fail / import fail      │ process exits
    └──── markDead() ◀──────── failed ◀──────────────────────────┘
```

- **Lazy start.** No Python process exists until the first `.asdf` open. The first request
  queues on a single `starting` promise so concurrent opens can't double-spawn.
- **Handshake = capability probe.** The first request on a fresh process is always
  `status`. If it reports `asdf: null`, we fail fast with `E_NO_ASDLIB` + install hint
  instead of letting every `open` error out individually.
- **Crash handling.** Any unexpected exit rejects all pending requests with
  `E_BACKEND_DIED` (with the last ~4 KB of stderr) and clears state. The *next* request
  transparently re-spawns — no user action needed for a one-off crash.
- **Restart throttling.** 3 hard failures within 60 s pause auto-restart until the window
  elapses (prevents hot loops on, e.g., a broken interpreter). `asdfPreview.restartBackend`
  resets the counter and forces an immediate respawn + reload of all open tabs.
- **Timeouts are soft.** A timed-out request does not kill the process; its late response
  is dropped as an orphan (see §3.1). Timeouts: 30 s for cold `status`, 60 s (configurable)
  for `open`/`image`, 10 s for the rest.
- **Python detection** (`manager.detectPython`): setting → env var → `<ext>/.venv` →
  `$VIRTUAL_ENV` → PATH defaults; each candidate is verified with a 5 s-capped
  `--version` probe and successes cached for the session.

## 5. Image pipeline (python/imaging.py)

For a selected array `a` (H×W):

1. **Validate.** ndim must be 2, dtype kind in `{f,i,u,b}`, non-empty; complex/other →
   `E_BAD_ARRAY`. Quantities are unit-stripped; masked arrays use `.data` (v1).
2. **Stride downsample** to ≤ `max_side` (default 1024):
   `sh = ceil(H/max_side)`, `sw = ceil(W/max_side)`, view `a[::sh, ::sw]`. Striding is a
   zero-copy view — the only allocations are the contiguous float32 working copy and the
   output u8 array. (Block averaging would look slightly nicer but costs a full pass;
   striding keeps warm re-renders ~75 ms for 4096² frames.)
3. **Zscale bounds.** Sample ≤ 1 M finite values from the downsampled array (a stride-4
   4096² frame gives ≈ 1 M points — good coverage, cheap) and run astropy's
   `ZScaleInterval` (`get_limits` on astropy ≥ 8, `bounds` before). Zscale iteratively
   tightens min/max with robust clipping, so a handful of PSF pixels can't wash out the
   background — this is why we don't use naive percentiles when astropy is present.
   Without astropy: percentile(2, 98) fallback, algorithm name reported in the response.
   Constant/degenerate arrays get ±max(1, 5%·|mid|) bounds so they render gray instead of
   clipping to black/white.
4. **Stretch.** Non-finite values are mapped to the nearest bound (NaN → dark, not white
   speckle), then linear map `(v - vmin) * 255 / (vmax - vmin)` clipped to `[0,255]`.
   Linear power-law in v1; a gamma/exposure toggle is an easy later addition.
5. **Encode.** 8-bit grayscale PNG via Pillow if importable, else a built-in ~30-line
   writer (zlib + manual IHDR/IDAT/IEND) — so the backend has *zero* hard dependencies
   beyond `asdf`.

Stats (min/max/mean/σ, nan-aware) are computed over the **full** array (up to 50 M elements;
beyond that a strided subsample is used and flagged `sampled: true`) — so the status line
describes the real data, not just the preview.

## 6. Extension host notes

- `src/editor.ts` implements `CustomReadonlyEditorProvider`; the custom document object is
  deliberately just `{uri}` — all parsing lives in the backend. `open` is on-demand per
  panel; multiple tabs of one file share the backend's parse cache.
- Webviews are created with `retainContextWhenHidden` (zoom level and expanded-tree state
  survive tab switches). CSP allows only our own assets plus `data:` images — scripts run
  under a random nonce, nothing external can load, it works fully offline.
- A per-file `FileSystemWatcher` triggers an auto-reload when the file on disk changes
  (debounce-less: re-parses are cheap when unchanged, thanks to the mtime cache).
- On panel dispose we send `close` (best-effort, 2 s timeout) so a closed tab releases its
  LRU slot and the backend's RAM tracks what you actually have open.

## 7. Testing

| Test | What it covers | How |
|---|---|---|
| `testdata/generate.py` | builds `small.asdf` (~1 MB) + `big.asdf` (~109 MB, NaN corner, PSF blob) | `.venv/bin/python testdata/generate.py` |
| `testdata/smoke_test.py` | the whole wire protocol over real pipes: handshake, open (cold/hot timing), tree caps, zscale, PNG validity, all error paths, malformed-line robustness, clean shutdown | `.venv/bin/python testdata/smoke_test.py` |
| `test/host_sim.js` | the compiled TS manager against the real backend: python detection, spawn+handshake, crash (SIGKILL) → auto-respawn, restart command | `node test/host_sim.js` (after `npm run compile`) |

Suggested additions when you extend this: pytest for the imaging math (zrange invariants,
stride factors), and a fixture with real Roman tags to exercise the roman_datamodels path.

## 8. Extending for cubes / spectra later

The seams are already in place — no protocol change needed for either:

**3-D quick-look.** `image` gains two optional params: `axis: int` (which non-spatial axis)
and `index: int | "center" | "max"`. The backend picks the slice from the cached tree and
runs the *existing* 2-D pipeline; add `slice_index` to the response so the webview can
offer a slider + per-slice histogram. Tree nodes already carry full shapes, so the webview
knows which arrays are 3-D today (they're just not in the dropdown).

**Spectra / 1-D.** Add an `x_array_path` param: render a line plot to PNG server-side
(Pillow's drawing or a tiny custom rasterizer) and reuse the same canvas viewer. The
catalog already exposes 1-D arrays with their shapes, so pairing detection (e.g.
`meta.wcsinfo.spectral` pointing at `wavelengths`) is pure inspection-layer work.

**Other ideas that fit the same contract:** cube max-projection or moment-1 maps as new
`image` variants; multi-array mosaic thumbnails in the tree; a `stretch: "linear"|"zscale"|"hist-equalized"` param once we collect user preferences.

## 9. Custom-built vs JDaviz / Firefly (why this exists)

Both existing astronomy viewers were evaluated and rejected as backends for *this*
use case:

- **JDaviz** is excellent for in-notebook interactive analysis, but it drags in the full
  Jupyter-widget stack (ipyvue/voila-style dependencies) with multi-second startup *per
  file view* and a browser-side rendering model. We wanted an in-editor panel that opens
  in well under a second, with zero notebook machinery.
- **Firefly/IPAC** is a mature Java server with strong astronomy UX, but it needs a
  separate long-running server process, has no native ASDF reader (you'd still need the
  Python parsing layer — i.e. this backend anyway), and adds a protocol+deployment surface
  far larger than one supervised child process.

What remains from that analysis: the *requirements* (real ASDF parsing via `asdf`,
zscale-stretched quick-look, in-editor rendering) are implemented here directly, with the
heavy lifting delegated to the libraries already trusted by the Roman/JWST pipeline
(`asdf`, `numpy`, optionally `astropy` + `roman_datamodels`).

## 10. Known sharp edges (honest list)

- asdf ≥4 exposes **lazy tag objects** (`NDArrayType`) in `.tree`, not raw ndarrays —
  `inspection.materialize_array()` is the single place that normalizes this; any new code
  touching arrays should go through it.
- astropy renamed `ZScaleInterval.bounds` → `get_limits` in v8; both are probed at runtime.
- First open of a *genuinely* huge (multi-GB) file can exceed the default 60 s timeout on
  slow disks — raise `asdfPreview.requestTimeoutSeconds`; the backend isn't killed by the
  timeout, so the response will arrive and be dropped cleanly if it does.
- The webview tree renders all nodes into the DOM (backend caps it at 20 k nodes); a very
  large but shallow file could still be sluggish — virtualization is the fix if that ever
  matters.
