"""Wire protocol for the ASDF preview backend.

Framing
-------
One JSON object per line (UTF-8, ``\\n`` terminated). The server only ever
writes *complete* response lines, so the client can naively split on newlines.

    request  : {"id": <int>, "method": <str>, "params": <obj>}   # params optional
    response : {"id": <int>, "ok": true,  "result": <obj>}
               {"id": <int>, "ok": false, "error": {"code", "message", ...}}

Contract rules (mirror in TypeScript: src/backend/types.ts + client.ts)
-----------------------------------------------------------------------
* ``id`` is an opaque integer chosen by the *client*. The server only echoes
  it back; it keeps no per-client state.
* Responses may arrive late (e.g. after the client timed out and gave up).
  The client MUST ignore frames whose id has no pending request ("orphans")
  instead of treating them as corruption -- this is what makes client-side
  timeouts safe without killing the process.
* Malformed lines are dropped and logged to stderr (they carry no usable id).
* A single frame must not exceed MAX_FRAME_BYTES; a longer line aborts the
  connection rather than eating unbounded memory.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Dict, Optional, Tuple

MAX_FRAME_BYTES = 50 * 1024 * 1024  # sanity cap on one request/response frame


# ---------------------------------------------------------------------------
# Error codes -- shared vocabulary between backend, extension host and webview.
# Keep in sync with src/backend/types.ts (ERROR_CODES).
# ---------------------------------------------------------------------------
E_BAD_REQUEST = "E_BAD_REQUEST"        # malformed params / unknown method
E_FILE_NOT_FOUND = "E_FILE_NOT_FOUND"  # path does not exist / not a file
E_PARSE = "E_PARSE"                    # asdf could not parse the file
E_NO_ASDLIB = "E_NO_ASDLIB"            # 'asdf' package missing in this python
E_NO_ARRAY = "E_NO_ARRAY"              # no (2-D) array at requested path
E_BAD_ARRAY = "E_BAD_ARRAY"            # array exists but cannot be previewed
E_INTERNAL = "E_INTERNAL"              # unexpected backend failure

# Errors synthesized by the *extension host* (client side), not by this process:
E_NO_PYTHON = "E_NO_PYTHON"            # no usable python interpreter found
E_TIMEOUT = "E_TIMEOUT"                # request exceeded its deadline
E_BACKEND_DIED = "E_BACKEND_DIED"      # backend process exited / failed to start


class BackendError(Exception):
    """Protocol-level error carrying a stable code for the UI layer."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.extra = extra  # optional structured detail (e.g. stderr tail)


def parse_request(line: str) -> Tuple[int, str, Dict[str, Any]]:
    """Parse one request line into (id, method, params).

    Raises BackendError(E_BAD_REQUEST) with a descriptive message on any
    shape violation. The caller decides whether the id is recoverable and
    worth answering.
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise BackendError(E_BAD_REQUEST, f"request is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise BackendError(E_BAD_REQUEST, "request must be a JSON object")
    rid = obj.get("id")
    method = obj.get("method")
    if not isinstance(rid, int) or isinstance(rid, bool):
        raise BackendError(E_BAD_REQUEST, '"id" must be an integer')
    if not isinstance(method, str) or not method:
        raise BackendError(E_BAD_REQUEST, '"method" must be a non-empty string')
    params = obj.get("params") or {}
    if not isinstance(params, dict):
        raise BackendError(E_BAD_REQUEST, '"params" must be an object')
    return rid, method, params


def ok(rid: int, result: Any) -> Dict[str, Any]:
    return {"id": rid, "ok": True, "result": result}


def err(rid: Optional[int], error: Dict[str, Any]) -> Dict[str, Any]:
    if rid is None:
        # Frame without a usable id (should not happen in practice): emit
        # with null id so clients still see *something* and can log it.
        return {"id": None, "ok": False, "error": error}
    return {"id": rid, "ok": False, "error": error}


def make_error(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    out = {"code": code, "message": message}
    out.update(extra)
    return out


def write_response(stream: Any, frame: Dict[str, Any]) -> None:
    """Serialize one frame and flush immediately.

    Never raises into the main loop for I/O errors (a broken pipe simply ends
    the session); stdout discipline (only protocol frames on stdout) is what
    keeps this channel trustworthy.
    """
    try:
        line = json.dumps(frame, ensure_ascii=False, allow_nan=False) + "\n"
        stream.write(line)
        stream.flush()
    except (BrokenPipeError, OSError) as exc:
        log(f"stdout write failed ({exc}); session over")


def log(message: str) -> None:
    """Log to stderr -- stdout is reserved for protocol frames."""
    try:
        sys.stderr.write("[asdf-preview-backend] " + message + "\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover - logging must never kill the loop
        pass
