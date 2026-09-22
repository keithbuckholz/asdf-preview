#!/usr/bin/env python3
"""Persistent ASDF preview backend -- entry point.

Transport: newline-delimited JSON over stdin/stdout (see protocol.py for the
full contract). The extension host spawns exactly one instance of this
process and reuses it for every file opened in the session; Python/imports
are paid once, not per file.

    python3 backend_main.py

Requests are handled in arrival order on a single thread (sufficient for a
local UI: one editor at a time is the realistic load). The loop is written so
that *no* handler exception can kill the process -- every failure becomes an
error frame, and truly unexpected ones become E_INTERNAL with the traceback
logged to stderr.
"""
from __future__ import annotations

import os
import signal
import sys
import time

# Allow running from any cwd: the extension spawns us by absolute path, but a
# developer may too. The script's directory is already on sys.path[0] when
# invoked as `python /path/backend_main.py`, so sibling imports just work.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import protocol  # noqa: E402
from protocol import BackendError  # noqa: E402
import inspection  # noqa: E402
import imaging  # noqa: E402

START_MONOTONIC = time.monotonic()
_STOP = False


def _handle_signal(signum, _frame) -> None:
    global _STOP
    protocol.log(f"received signal {signum}; shutting down after current request")
    _STOP = True


# ---------------------------------------------------------------------------
# Handlers -- each returns a JSON-safe result or raises BackendError(code, ...)
# ---------------------------------------------------------------------------

def h_status(_params):
    """Handshake: report environment + capabilities. Always succeeds."""
    return {
        "python": sys.version.split()[0],
        "asdf": inspection._asdf_version(),  # None when the package is missing
        "numpy": _safe_attr("numpy", "__version__"),
        "has_roman_datamodels": inspection.has_roman_datamodels(),
        "stretch_backend": (
            "astropy ZScaleInterval"
            if _find_spec_ok("astropy")
            else "percentile(2-98) fallback"
        ),
        # The webview builds its stretch/colormap dropdowns from this, so an
        # interpreter without matplotlib simply shows 'gray' (no error path).
        "capabilities": {
            "stretches": list(imaging.STRETCHES),
            "transfers": list(imaging.TRANSFERS),
            "cmaps": imaging.available_cmaps(),
        },
        "pid": os.getpid(),
    }


def h_ping(_params):
    return {"pong": True, "uptime_s": round(time.monotonic() - START_MONOTONIC, 3)}


def h_open(params):
    path = _require_str(params, "path")
    return inspection.build_record(path)


def h_image(params):
    path = _require_str(params, "path")
    array_path = params.get("array_path")
    max_side = params.get("max_side", 1024)
    try:
        max_side = int(max_side)
    except (TypeError, ValueError):
        raise BackendError(protocol.E_BAD_REQUEST, '"max_side" must be an integer')

    entry = inspection.get_entry(path)  # parses+caches on first use
    if array_path is None:
        array_path = entry.record.get("preview_array")
        if array_path is None:
            raise BackendError(
                protocol.E_NO_ARRAY,
                "No 2-D image-like array found in this file; showing tree only.",
            )

    opts = imaging.validate_render_opts(params)
    return imaging.make_preview(entry.tree, str(array_path), max_side, opts)


def h_close(params):
    path = _require_str(params, "path")
    closed = inspection.close_file(path)
    return {"closed": closed}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_attr(mod_name: str, attr: str):
    try:
        mod = sys.modules.get(mod_name) or __import__(mod_name)
        return getattr(mod, attr, None)
    except Exception:
        return None


def _find_spec_ok(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _require_str(params: dict, key: str) -> str:
    val = params.get(key)
    if not isinstance(val, str) or not val:
        raise BackendError(protocol.E_BAD_REQUEST, f'params.{key!r} must be a non-empty string')
    return val


METHODS = {
    "status": h_status,
    "ping": h_ping,
    "open": h_open,
    "image": h_image,
    "close": h_close,
}


def main() -> int:
    # Force UTF-8 regardless of locale (ASDF metadata may contain non-ASCII),
    # and line-buffering so responses leave promptly even under odd stdio setups.
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handle_signal)
        except Exception:
            pass

    protocol.log(f"backend ready (pid {os.getpid()}, python {sys.version.split()[0]})")

    for line in sys.stdin:
        if _STOP:
            break
        line = line.rstrip("\r\n")
        if not line:
            continue
        if len(line.encode("utf-8", "replace")) > protocol.MAX_FRAME_BYTES:
            protocol.log(f"frame too large ({len(line)} chars); dropping connection")
            break

        try:
            rid, method, params = protocol.parse_request(line)
        except BackendError as exc:
            # Recover id if we can so the client gets *some* answer.
            import json as _json

            rid = None
            try:
                maybe = _json.loads(line)
                if isinstance(maybe, dict) and isinstance(maybe.get("id"), int):
                    rid = maybe["id"]
            except Exception:
                pass
            if rid is None:
                # No recoverable id: a response would be unmatched garbage to
                # the client. Log and drop instead of speaking out of turn.
                protocol.log(f"unparseable line dropped: {exc}")
                continue
            protocol.write_response(sys.stdout, protocol.err(rid, protocol.make_error(exc.code, str(exc))))
            continue

        handler = METHODS.get(method)
        if handler is None:
            resp = protocol.err(rid, protocol.make_error(
                protocol.E_BAD_REQUEST, f"unknown method {method!r}"))
        else:
            t0 = time.perf_counter()
            try:
                result = handler(params)
                resp = protocol.ok(rid, result)
            except BackendError as exc:
                resp = protocol.err(rid, protocol.make_error(exc.code, str(exc), **exc.extra))
            except Exception:
                import traceback

                traceback.print_exc(file=sys.stderr)
                resp = protocol.err(rid, protocol.make_error(
                    protocol.E_INTERNAL, "unexpected backend error; see stderr log"))
            dt = time.perf_counter() - t0
            if dt > 0.5:
                protocol.log(f"slow request: {method} id={rid} took {dt:.2f}s")

        protocol.write_response(sys.stdout, resp)

    inspection.close_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
