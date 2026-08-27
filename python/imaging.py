"""Array -> quick-look PNG pipeline.

Stages (all in-memory, numpy-first):

    find_array  -> locate ndarray by dotted path in the live tree
    prepare     -> unit/mask stripping, dtype check, stride downsample to <= max_side
    zrange      -> astropy ZScaleInterval bounds (proper iterative min/max with
                   sigma-like clipping), or a percentile fallback without astropy
    to_u8       -> clip + normalize to 8-bit gray
    full_stats  -> nan-aware min/max/mean/std over the *full* array (bounded)
    encode_png  -> 8-bit grayscale PNG via Pillow if present, else a small
                   built-in writer (zlib only) so we never hard-require Pillow

Design notes
------------
* Downsampling is plain numpy striding (``a[::sh, ::sw]``): O(1) memory for
  the view, no allocation until we astype to float32 for the working copy.
  Block-averaging would give slightly prettier previews but costs a real pass
  over the full array; for a quick-look, striding keeps repeat previews fast.
* ZScale quality depends on representative samples, so bounds are computed on
  a <=1M-element subsample of the *downsampled* array (a stride-4 4096^2
  Roman WFI frame yields exactly ~1M samples -- good coverage, cheap).
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

import numpy as np

import protocol
from inspection import find_array, is_quantity, materialize_array
from protocol import BackendError

MAX_FULL_STATS_ELEMENTS = 50_000_000  # above this, stats come from a subsample
ZSCALE_SAMPLE_CAP = 1_000_000         # ZScaleInterval wants <= ~1M points

_PREVIEWABLE_KINDS = ("f", "i", "u")  # float / signed int / unsigned int


class PreviewError(BackendError):
    """imaging-specific error (uses E_BAD_ARRAY / E_NO_ARRAY codes)."""


def _zscale_bounds(sample: np.ndarray) -> Optional[Tuple[float, float]]:
    from astropy.visualization import ZScaleInterval  # local: astropy optional

    iv = ZScaleInterval()
    # astropy >= 8 renamed bounds() -> get_limits(); support both so the same
    # backend runs on old and new astropy without code changes.
    fn = getattr(iv, "get_limits", None) or getattr(iv, "bounds")
    if fn is None:
        return None
    lo, hi = fn(sample)
    lo, hi = float(lo), float(hi)
    if math.isfinite(lo) and math.isfinite(hi) and hi > lo:
        return lo, hi
    return None


def finite_sample(work: np.ndarray, cap: int = ZSCALE_SAMPLE_CAP) -> np.ndarray:
    """1-D float64 array of finite values from *work*, subsampled to <= cap."""
    flat = np.ravel(work)
    fin = flat[np.isfinite(flat)]  # boolean-mask copy; work is already small
    if fin.size == 0:
        return fin.astype(np.float64)
    if fin.size > cap:
        step = (fin.size + cap - 1) // cap
        fin = fin[::step]
    return fin.astype(np.float64, copy=False)


def zrange(sample: np.ndarray) -> Optional[Tuple[float, float, str]]:
    """Return (vmin, vmax, algorithm-name). None if there are no finite values."""
    if sample.size == 0:
        return None
    try:
        bounds = _zscale_bounds(sample)
        if bounds is not None:
            return bounds[0], bounds[1], "astropy ZScaleInterval"
    except Exception as exc:  # astropy present but unhappy -> fallback
        protocol.log(f"ZScaleInterval failed ({exc}); using percentile fallback")

    p2, p98 = np.percentile(sample, [2, 98])
    lo, hi = float(p2), float(p98)
    if hi <= lo:  # degenerate (constant) data -- widen so it renders gray
        mid = 0.5 * (lo + hi)
        spread = max(1.0, abs(mid) * 0.05)
        lo, hi = mid - spread, mid + spread
    return lo, hi, "percentile(2-98) fallback"


def _widen(lo: float, hi: float) -> Tuple[float, float]:
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        mid = 0.5 * (lo + hi) if (math.isfinite(lo) and math.isfinite(hi)) else 0.0
        spread = max(1.0, abs(mid) * 0.05)
        return mid - spread, mid + spread
    return lo, hi


def prepare(arr: Any, max_side: int) -> Tuple[np.ndarray, Tuple[int, int], np.ndarray]:
    """Validate and downsample *arr*; return (work_copy, strides, full_f32).

    ``work`` is a contiguous float32 <= max_side x max_side view used for the
    stretch; ``full_f32`` keeps the original resolution for stats (aliased to
    the input when it is already float32 -- no extra copy in that case).
    """
    if is_quantity(arr):
        arr = arr.value  # quick-look ignores units
    if isinstance(arr, np.ma.MaskedArray):
        arr = arr.data  # v1: preview the underlying data, not the mask
    a = np.asarray(arr)

    if a.ndim != 2:
        raise PreviewError(
            protocol.E_BAD_ARRAY,
            f"Only 2-D arrays are previewable in v1 (this one is {a.ndim}-D).",
        )
    if a.size == 0:
        raise PreviewError(protocol.E_BAD_ARRAY, "Array is empty.")
    if a.dtype.kind == "c":
        raise PreviewError(
            protocol.E_BAD_ARRAY,
            "Complex arrays are not previewed in v1 (use |x| or Re(x) via a "
            "custom pipeline later).",
        )
    if a.dtype.kind not in _PREVIEWABLE_KINDS:
        raise PreviewError(
            protocol.E_BAD_ARRAY, f"Unsupported dtype for preview: {a.dtype}"
        )

    h, w = a.shape
    # Ceil-division strides: result side <= max_side, view is zero-copy.
    sh = max(1, -(-h // max_side))
    sw = max(1, -(-w // max_side))
    view = a[::sh, ::sw]

    full_f32 = a if a.dtype == np.float32 else a.astype(np.float32)
    work = (
        view
        if a.dtype == np.float32 and sh == 1 and sw == 1
        else np.ascontiguousarray(view, dtype=np.float32)
    )
    return work, (sh, sw), full_f32


def to_u8(work: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    """Clip+normalize *work* to 8-bit gray.

    Non-finite values are mapped to the nearest bound (NaN -> dark), so a
    DNaN-eroded corner renders as background rather than blowing out the
    stretch or producing white speckle.
    """
    w = np.nan_to_num(work, nan=vmin, posinf=vmax, neginf=vmin)
    scaled = (w - vmin) * (255.0 / (vmax - vmin))
    u8 = np.clip(scaled, 0.0, 255.0)
    return np.rint(u8).astype(np.uint8)


def _r6(x: Optional[float]) -> Optional[float]:
    if x is None:
        return None
    x = float(x)
    return x if not math.isfinite(x) else round_sig(x)


def round_sig(x: float, sig: int = 6) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{sig - 1}e}") or 0.0


def full_stats(a: np.ndarray) -> Dict[str, Any]:
    """Nan-aware min/max/mean/std; subsamples very large arrays (flagged)."""
    sampled = False
    src = a
    if a.size > MAX_FULL_STATS_ELEMENTS:
        flat = np.ravel(a)
        step = (a.size + MAX_FULL_STATS_ELEMENTS - 1) // MAX_FULL_STATS_ELEMENTS
        src = flat[::step]
        sampled = True

    with np.errstate(invalid="ignore", all="ignore"):
        finite = np.isfinite(src)
    frac = float(finite.mean()) if src.size else 0.0
    if not bool(finite.any()):
        return {
            "min": None, "max": None, "mean": None, "std": None,
            "finite_fraction": _r6(frac), "sampled": sampled,
        }
    out = {
        "min": _r6(np.nanmin(src)),
        "max": _r6(np.nanmax(src)),
        "mean": _r6(np.nanmean(src)),
        "std": _r6(np.nanstd(src)),
        "finite_fraction": _r6(frac),
        "sampled": sampled,
    }
    return out


# ---------------------------------------------------------------------------
# PNG encoding -- Pillow when available, otherwise a minimal built-in writer
# (grayscale, 8-bit, filter 0, zlib). Keeps the dependency list to numpy+asdf.
# ---------------------------------------------------------------------------

def encode_png(u8: np.ndarray) -> bytes:
    h, w = u8.shape
    try:
        from io import BytesIO

        from PIL import Image

        buf = BytesIO()
        Image.fromarray(np.ascontiguousarray(u8), mode="L").save(
            buf, format="PNG", compress_level=6
        )
        return buf.getvalue()
    except Exception:  # Pillow missing or broken -> built-in writer
        return _manual_png(u8, h, w)


def _manual_png(u8: np.ndarray, h: int, w: int) -> bytes:
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    # Each scanline is prefixed with filter type 0 (None). Rows must be C-order.
    rows = np.ascontiguousarray(u8)
    raw = b"".join(b"\x00" + rows[y].tobytes() for y in range(h))
    idat = zlib.compress(raw, 6)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)  # 8-bit grayscale
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------------------
# High-level entry used by the backend's `image` handler
# ---------------------------------------------------------------------------

def make_preview(tree: Any, dotted_path: str, max_side: int = 1024) -> Dict[str, Any]:
    """Full pipeline for one 2-D array. Returns a JSON-safe result dict."""
    node = find_array(tree, dotted_path)
    if is_quantity(node):
        arr_plain = np.asarray(node.value)
    else:
        mat = materialize_array(node)
        arr_plain = mat[0] if mat is not None else np.asarray(node)
    if arr_plain.ndim != 2 or arr_plain.dtype.kind not in _PREVIEWABLE_KINDS + ("b",):
        raise PreviewError(
            protocol.E_BAD_ARRAY,
            f"Array at {dotted_path!r} is not a previewable 2-D numeric array.",
        )

    max_side = int(min(max(64, max_side), 4096))  # clamp: never render >4096^2
    work, strides, full_f32 = prepare(arr_plain, max_side)

    sample = finite_sample(work)
    zr = zrange(sample)
    if zr is None:
        # No finite values at all: emit a blank (black) frame + explanation.
        u8 = np.zeros(work.shape, dtype=np.uint8)
        png_bytes = encode_png(u8)
        import base64

        return {
            "array_path": dotted_path,
            "png": base64.b64encode(png_bytes).decode("ascii"),
            "width": int(work.shape[1]),
            "height": int(work.shape[0]),
            "full_shape": list(arr_plain.shape),
            "downsample_factor": list(strides),
            "stretch": {"algorithm": "none", "vmin": None, "vmax": None},
            "stats": full_stats(full_f32),
            "note": "array contains no finite values; image shown as black",
        }

    vmin, vmax, algo = zr
    lo, hi = _widen(vmin, vmax)
    u8 = to_u8(work, lo, hi)
    png_bytes = encode_png(u8)

    import base64

    return {
        "array_path": dotted_path,
        "png": base64.b64encode(png_bytes).decode("ascii"),
        "width": int(work.shape[1]),
        "height": int(work.shape[0]),
        "full_shape": list(arr_plain.shape),
        "downsample_factor": list(strides),
        "stretch": {"algorithm": algo, "vmin": _r6(lo), "vmax": _r6(hi)},
        "stats": full_stats(full_f32),
    }
