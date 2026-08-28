"""ASDF inspection: opening files, caching them, and serializing metadata.

Responsibilities
----------------
* Open ``.asdf`` files with :mod:`asdf`, preferring ``roman_datamodels`` when
  it is installed (it registers the Roman/JWST tag handlers that plain asdf
  lacks -- without them, Roman products can fail to parse). Both paths are
  best-effort: any roman_datamodels problem falls back to plain ``asdf.open``.
* Keep a small LRU cache of *open* files so re-opening (new tab, reload,
  image request) is served from memory and does not re-read/re-parse the file.
* Serialize the YAML tree into a compact JSON-safe structure for the webview,
  with bounded caps (string length, list length, total node count) so a
  pathological file cannot blow up the protocol frame.
* Catalog every ndarray in the tree (dotted path, shape, dtype) and mark the
  recommended quick-look array (first 2-D array in document order).

All public entry points raise :class:`protocol.BackendError` with a stable
code; they never let raw tracebacks escape into the protocol loop.
"""
from __future__ import annotations

import datetime
import math
import os
import re
import sys
import uuid
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import numpy as np

import protocol
from protocol import BackendError

# ---------------------------------------------------------------------------
# Optional dependency detection (never hard-required)
# ---------------------------------------------------------------------------

_ASDF = None          # cached module or None (checked once per process)
_ASDF_CHECKED = False
_ROMAN = None         # roman_datamodels module, or None
_ROMAN_CHECKED = False


def _ensure_asdf():
    """Import asdf lazily so the backend can still answer `status` without it."""
    global _ASDF, _ASDF_CHECKED
    if not _ASDF_CHECKED:
        try:
            import asdf  # type: ignore

            _ASDF = asdf
        except Exception:
            _ASDF = None
        _ASDF_CHECKED = True
    return _ASDF


def _asdf_version() -> Optional[str]:
    mod = _ensure_asdf()
    return getattr(mod, "__version__", "unknown") if mod else None


def _find_spec_ok(name: str) -> bool:
    """Cheap availability probe (no import side effects / startup cost)."""
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _ensure_roman():
    global _ROMAN, _ROMAN_CHECKED
    if not _ROMAN_CHECKED:
        _ROMAN = None
        if _find_spec_ok("roman_datamodels"):
            try:
                import roman_datamodels  # type: ignore

                _ROMAN = roman_datamodels
            except Exception as exc:  # broken install -> behave as absent
                protocol.log(f"roman_datamodels import failed, ignoring: {exc}")
        _ROMAN_CHECKED = True
    return _ROMAN


def has_roman_datamodels() -> bool:
    return _find_spec_ok("roman_datamodels")


# astropy.units.Quantity is a subclass of ndarray, so it must be tested first
# during the tree walk. Import guard keeps astropy optional.
try:  # pragma: no cover - trivial import guard
    from astropy.units import Quantity as _AstropyQuantity  # type: ignore
except Exception:  # pragma: no cover
    _AstropyQuantity = None


def is_quantity(obj: Any) -> bool:
    return _AstropyQuantity is not None and isinstance(obj, _AstropyQuantity)


def strip_units(arr: Any) -> np.ndarray:
    """Return the plain ndarray behind a possible astropy Quantity."""
    if is_quantity(arr):
        return np.asarray(arr.value)
    return np.asarray(arr)


def materialize_array(obj: Any) -> Optional[Tuple[np.ndarray, bool]]:
    """Turn an array node of the asdf tree into (ndarray, masked).

    asdf >= 4 does NOT put raw ndarrays in ``AsdfFile.tree``: array nodes are
    lazy tag objects (``NDArrayType`` / masked variants) that expose
    ``.shape``/``.dtype`` without loading and materialize via the ``__array__``
    protocol (first access reads the block from disk once; subsequent uses are
    free because asdf caches the base data). Older asdf versions and trees
    built by other tools give plain ndarrays, which pass through unchanged.

    Returns None for non-array objects so callers can keep their dispatch.
    """
    if isinstance(obj, np.ndarray):
        return obj, isinstance(obj, np.ma.MaskedArray)
    if (isinstance(obj, (str, bytes)) is False
            and hasattr(obj, "shape") and hasattr(obj, "dtype")
            and callable(getattr(obj, "__array__", None))):
        try:
            arr = np.asarray(obj)  # triggers the one-time block load
        except Exception as exc:  # pragma: no cover - defensive
            protocol.log(f"could not materialize array node: {exc}")
            return None
        if isinstance(arr, np.ndarray):
            # `_mask` is a private attr of the tag object; best-effort probe so
            # the tree can show "masked" without us having to load it.
            masked = getattr(obj, "_mask", None) is not None
            return arr, masked
    return None


# ---------------------------------------------------------------------------
# Serialization caps (tune here; documented in DEVELOPMENT.md)
# ---------------------------------------------------------------------------
MAX_NODES = 20_000        # total serialized nodes before giving up (per file)
MAX_LIST_ITEMS = 256      # items rendered per list; longer lists are flagged
MAX_STR_LEN = 1024        # string values are truncated beyond this
MAX_OPEN_FILES = 4        # LRU cache of parsed files held in RAM


class _Walker:
    """Recursive tree -> JSON-safe node serializer with a shared budget."""

    def __init__(self) -> None:
        self.budget = MAX_NODES
        self.truncated = False
        self.arrays: List[Dict[str, Any]] = []

    # -- dispatch ----------------------------------------------------------
    def node(self, obj: Any, path: str) -> Dict[str, Any]:
        if self.budget <= 0:
            self.truncated = True
            return {"type": "omitted", "reason": "node limit reached"}
        self.budget -= 1

        # Order matters: Quantity is-a ndarray; bool is-a int.
        if is_quantity(obj):
            return self._quantity(obj, path)
        arr = materialize_array(obj)  # plain ndarrays AND asdf>=4 lazy tags
        if arr is not None:
            data, masked = arr
            return self._ndarray(data, path, masked)
        if isinstance(obj, dict):
            return self._mapping(obj.items(), path)
        try:  # mapping-like but not a dict (UserDict subclasses, ...)
            from collections.abc import ItemsView

            items = getattr(obj, "items", None)
            if callable(items) and not isinstance(obj, (str, bytes)):
                iv = items()
                if isinstance(iv, ItemsView):
                    return self._mapping(iter(iv), path)
        except Exception:
            pass
        if isinstance(obj, (list, tuple)):
            return self._list(obj, path)
        return self._scalar(obj, path)

    # -- containers ---------------------------------------------------------
    def _mapping(self, items, path: str) -> Dict[str, Any]:
        children: "OrderedDict[str, Any]" = OrderedDict()
        for k, v in items:
            key = k if isinstance(k, str) else str(k)  # YAML keys can be numeric
            child_path = f"{path}.{key}" if path else key
            children[key] = self.node(v, child_path)
        return {"type": "object", "keys": len(children), "children": children}

    def _list(self, obj: Any, path: str) -> Dict[str, Any]:
        length = len(obj)
        shown = min(length, MAX_LIST_ITEMS)
        items = [self.node(obj[i], f"{path}[{i}]") for i in range(shown)]
        return {
            "type": "list",
            "length": length,
            "truncated": length > shown,
            "items": items,
        }

    # -- leaves --------------------------------------------------------------
    def _ndarray(self, arr: np.ndarray, path: str, masked: bool = False) -> Dict[str, Any]:
        previewable = (
            arr.ndim == 2 and arr.dtype.kind in ("f", "i", "u") and arr.size > 0
        )
        info = {
            "type": "ndarray",
            "path": path or "<root>",
            "shape": list(arr.shape),
            "dtype": str(arr.dtype),
            "nbytes": int(arr.nbytes),
            "masked": masked or isinstance(arr, np.ma.MaskedArray),
            "previewable": previewable,
        }
        # Document-order catalog used by `open`/`image` handlers.
        self.arrays.append(info)
        return info

    def _quantity(self, qty: Any, path: str) -> Dict[str, Any]:
        unit = str(getattr(qty, "unit", "")) or None
        if getattr(qty, "ndim", 1) == 0:
            val = qty.value
            node = self._scalar(val, path)
            node["type"] = "quantity"
            node["unit"] = unit
            return node
        mat = materialize_array(np.asarray(qty)) or (np.asarray(qty), False)
        node = self._ndarray(mat[0], path, mat[1])
        if unit:
            node["unit"] = unit
        return node

    def _scalar(self, obj: Any, path: str) -> Dict[str, Any]:
        if obj is None:
            return {"type": "null", "value": None}
        if isinstance(obj, bool):
            return {"type": "bool", "value": obj}
        if isinstance(obj, (int, np.integer)):
            return {"type": "integer", "value": int(obj)}
        if isinstance(obj, (float, np.floating)):
            v = float(obj)
            if math.isfinite(v):
                return {"type": "number", "value": _round_sig(v)}
            rep = "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")
            # JSON has no NaN/Inf literals and JS's JSON.parse rejects them.
            return {"type": "number", "value": None, "representation": rep}
        if isinstance(obj, str):
            if len(obj) <= MAX_STR_LEN:
                return {"type": "str", "value": obj}
            return {
                "type": "str",
                "value": obj[:MAX_STR_LEN] + "…",
                "truncated": True,
                "length": len(obj),
            }
        if isinstance(obj, datetime.datetime):
            return {"type": "datetime", "value": obj.isoformat()}
        if isinstance(obj, (datetime.date, datetime.time)):
            return {"type": obj.__class__.__name__, "value": obj.isoformat()}
        if isinstance(obj, uuid.UUID):
            return {"type": "str", "value": str(obj)}
        if isinstance(obj, (bytes, bytearray)):
            import base64

            raw = bytes(obj)
            val = base64.b64encode(raw).decode("ascii") if len(raw) <= 32 else None
            return {"type": "bytes", "value": val, "length": len(raw)}
        # Anything exotic: show class + truncated repr so the user still sees
        # *something* instead of a silent hole in the tree.
        cls = f"{type(obj).__module__}.{type(obj).__qualname__}"
        try:
            rep = repr(obj)
        except Exception as exc:  # some objects explode in repr
            rep = f"<unrepresentable: {exc}>"
        if len(rep) > MAX_STR_LEN:
            rep = rep[:MAX_STR_LEN] + "…"
        return {"type": "other", "class": cls, "value": rep}


def _round_sig(x: float, sig: int = 6) -> float:
    """Round to significant figures keeps JSON small without losing meaning."""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{sig - 1}e}") or 0.0


# ---------------------------------------------------------------------------
# Open-file LRU cache
# ---------------------------------------------------------------------------
class FileRecord:
    """One parsed ASDF file plus its pre-serialized, JSON-ready payload."""

    __slots__ = ("path", "mtime_ns", "size_bytes", "source", "closers", "tree", "record")

    def __init__(self) -> None:
        self.path = ""
        self.mtime_ns = 0
        self.size_bytes = 0
        self.source = "asdf"  # or "roman_datamodels"
        self.closers: List[Any] = []  # things to .close() on eviction
        self.tree: Dict[str, Any] = {}  # live tree (holds the real ndarrays)
        self.record: Dict[str, Any] = {}


class FileCache:
    """LRU cache of parsed files.

    Holding the live AsdfFile is deliberate: `image` requests need the actual
    numpy arrays in RAM, so caching the parse *is* the feature -- repeated
    opens and image swaps never touch disk again until mtime changes or the
    entry is evicted (MAX_OPEN_FILES entries).
    """

    def __init__(self, max_open: int = MAX_OPEN_FILES) -> None:
        self._entries: "OrderedDict[str, FileRecord]" = OrderedDict()
        self.max_open = max_open

    def get(self, path: str) -> Optional[FileRecord]:
        return self._entries.get(path)

    def put(self, rec: FileRecord) -> None:
        self._entries[rec.path] = rec
        self._entries.move_to_end(rec.path)
        while len(self._entries) > self.max_open:
            _, victim = self._entries.popitem(last=False)
            self._close(victim)
            protocol.log(f"evicted (LRU): {victim.path}")

    def close(self, path: str) -> bool:
        rec = self._entries.pop(path, None)
        if rec is None:
            return False
        self._close(rec)
        return True

    def close_all(self) -> None:
        for rec in list(self._entries.values()):
            self._close(rec)
        self._entries.clear()

    @staticmethod
    def _close(rec: FileRecord) -> None:
        for closer in rec.closers:
            try:
                closer.close()
            except Exception as exc:
                protocol.log(f"close failed for {rec.path}: {exc}")
        rec.closers.clear()


_cache = FileCache()


# ---------------------------------------------------------------------------
# Opening
# ---------------------------------------------------------------------------
_VERSION_RE = re.compile(r"-\d[\w.-]*$")  # trailing "-1.0.0" style version


def _title_from_schema(schema_uri: Optional[str], fallback: str) -> str:
    if not schema_uri:
        return fallback
    seg = schema_uri.rstrip("/").rsplit("/", 1)[-1]
    return _VERSION_RE.sub("", seg) or fallback


def _open_asdf(path: str):
    """Open *path*; return (asffile, source, extra_closers).

    Tries roman_datamodels first when available (it registers the Roman/JWST
    tag mappings plain asdf does not know), falling back to asdf.open on any
    problem -- never a hard dependency.
    """
    asdf = _ensure_asdf()
    if asdf is None:
        raise BackendError(
            protocol.E_NO_ASDLIB,
            "The 'asdf' Python package is not installed for the interpreter "
            f"running the backend ({sys.executable}).",
            hint="Install it with:  python -m pip install asdf\n"
                 "Optional extras: astropy (proper zscale stretch), "
                 "roman_datamodels (Roman-aware parsing).",
        )

    roman = _ensure_roman()
    if roman is not None:
        dm = None
        try:
            dm = roman.DataModel.open(path)
            asffile = dm.to_asdf()  # AsdfFile with Roman tree structure intact
            return asffile, "roman_datamodels", [asffile, dm]
        except Exception as exc:
            # Close the half-opened DataModel before falling back -- a leak
            # here would pin file handles (and mmap'd blocks) for no reason.
            if dm is not None:
                try:
                    dm.close()
                except Exception:
                    pass
            protocol.log(f"roman_datamodels failed for {path}, using plain asdf: {exc}")

    result = asdf.open(path)
    return result, "asdf", [result]


_TAG_HINT = (
    "This file uses ASDF tags the backend interpreter cannot load yet "
    "(common for Roman/JWST products with gwcs WCS objects). Install the "
    "missing packages into that interpreter, e.g.:\n"
    "    python -m pip install gwcs roman_datamodels\n"
    "then run 'ASDF Preview: Restart Python Backend' and retry."
)


def _parse_hint(exc_text: str) -> Optional[str]:
    """Turn a raw parse traceback into an actionable hint when we recognize it."""
    lowered = exc_text.lower()
    if any(marker in lowered for marker in (
        "tag:", "not recognized", "gwcs", "stsci.edu",
        "unknown right model type", "no handler found",
    )):
        return _TAG_HINT
    if "checksum" in lowered:
        return ("ASDF reported a checksum mismatch; the file may be corrupt or "
                "still being written. Re-open after the pipeline finishes.")
    return None


def build_record(path: str) -> Dict[str, Any]:
    """Parse (or fetch from cache) *path* and return its JSON-ready record.

    The record is cached keyed on (mtime_ns, size): if the file on disk has not
    changed, a second `open` is served from memory in well under a millisecond
    -- this is what makes repeat opens feel instant even for 100 MB files.
    """
    apath = os.path.abspath(path)
    try:
        st = os.stat(apath)
    except FileNotFoundError:
        raise BackendError(protocol.E_FILE_NOT_FOUND, f"File not found: {apath}")
    except OSError as exc:
        raise BackendError(protocol.E_BAD_REQUEST, f"Cannot stat {apath}: {exc}")
    if not os.path.isfile(apath):
        raise BackendError(protocol.E_BAD_REQUEST, f"Not a regular file: {apath}")

    existing = _cache.get(apath)
    if existing is not None and existing.mtime_ns == st.st_mtime_ns \
            and existing.size_bytes == st.st_size:
        return existing.record  # hot path: nothing below runs again

    try:
        # NOTE: on failure nothing is left to close here -- _open_asdf cleans
        # up its own half-opened handles before letting the exception escape.
        asffile, source, closers = _open_asdf(apath)
    except BackendError:
        raise
    except Exception as exc:
        raise BackendError(
            protocol.E_PARSE,
            f"Failed to parse ASDF file: {exc.__class__.__name__}: {exc}",
            hint=_parse_hint(str(exc)),
        )

    try:
        walker = _Walker()
        tree_node = walker.node(asffile.tree, "")
        preview_array = next(
            (a["path"] for a in walker.arrays if a.get("previewable")), None
        )
        for a in walker.arrays:
            if a["path"] == preview_array:
                a["recommended"] = True

        schema_uri = None
        try:
            schema_uri = asffile.schema_uri or asffile.headers.get("schema_uri")
        except Exception:
            pass

        rec = FileRecord()
        rec.path = apath
        rec.mtime_ns = st.st_mtime_ns
        rec.size_bytes = st.st_size
        rec.source = source
        rec.closers = closers
        rec.tree = asffile.tree  # live reference; `image` reads arrays from here
        rec.record = {
            "uri": _file_uri(apath),
            "path": apath,
            "size_bytes": st.st_size,
            "mtime_ns": st.st_mtime_ns,
            "title": _title_from_schema(schema_uri, os.path.basename(apath)),
            "schema_uri": schema_uri,
            "opened_with": source,
            "asdf_version": _asdf_version(),
            "tree": tree_node,
            "truncated": walker.truncated,
            "arrays": walker.arrays,
            "preview_array": preview_array,
        }
    except Exception:
        # Serialization failed -- do not leak the half-built file handle.
        _safe_close(closers)
        raise

    _cache.put(rec)
    return rec.record


def _safe_close(closers) -> None:
    for c in closers or []:
        if c is None:
            continue
        try:
            c.close()
        except Exception as exc:
            protocol.log(f"close failed: {exc}")


def get_entry(path: str) -> FileRecord:
    """Internal: live entry for `image`/`close` handlers (opens if needed)."""
    apath = os.path.abspath(path)
    rec = _cache.get(apath)
    if rec is None or not _still_fresh(rec, apath):
        build_record(apath)  # populates/replaces the cache entry
        rec = _cache.get(apath)
        assert rec is not None
    return rec


def _still_fresh(rec: FileRecord, apath: str) -> bool:
    try:
        st = os.stat(apath)
        return rec.mtime_ns == st.st_mtime_ns and rec.size_bytes == st.st_size
    except OSError:
        return False


def close_file(path: str) -> bool:
    """Release a cached file (called when an editor panel is disposed)."""
    return _cache.close(os.path.abspath(path))


def close_all() -> None:
    _cache.close_all()


# ---------------------------------------------------------------------------
# Dotted-path lookup (shared with the imaging module)
# ---------------------------------------------------------------------------
_TOKEN_RE = re.compile(r"[^\.\[\]]+|\[\d+\]")


def find_array(tree: Any, dotted_path: str) -> Any:
    """Walk *tree* following a dotted path like ``meta.flavor.sci[3]``."""
    node = tree
    for tok in _TOKEN_RE.findall(dotted_path or ""):
        if tok.startswith("["):
            idx = int(tok[1:-1])
            try:
                node = node[idx]
            except (IndexError, TypeError, KeyError):
                break
        else:
            if isinstance(node, dict) and tok in node:
                node = node[tok]
            else:
                break
    else:
        return node
    raise BackendError(
        protocol.E_NO_ARRAY, f"No array at path {dotted_path!r} in this file."
    )


def _file_uri(apath: str) -> str:
    return "file://" + quote(apath)
