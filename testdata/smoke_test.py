#!/usr/bin/env python3
"""End-to-end smoke test: drive backend_main.py over real pipes.

Spawns the backend as a child process (exactly like the VSCode extension host
does), sends protocol frames on stdin, and validates responses -- including
PNG validity, timing of repeat opens (the whole point of a persistent
backend), and error-path behavior.

Usage:  python testdata/smoke_test.py [python-interpreter]
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BACKEND = os.path.join(ROOT, "python", "backend_main.py")

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def main() -> int:
    py = sys.argv[1] if len(sys.argv) > 1 else sys.executable
    small = os.path.join(HERE, "small.asdf")
    big = os.path.join(HERE, "big.asdf")
    for p in (small, big):
        if not os.path.exists(p):
            print(f"fixture missing: {p} -- run testdata/generate.py first")
            return 2

    proc = subprocess.Popen(
        [py, BACKEND],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    _id = 0

    def req(method: str, params: dict | None = None, raw: str | None = None):
        nonlocal _id
        line = raw if raw is not None else json.dumps(
            {"id": _id, "method": method, "params": params or {}})
        _id += 1
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
        resp = json.loads(proc.stdout.readline())
        return resp

    print("== status / handshake ==")
    t0 = time.perf_counter()
    r = req("status")
    dt = time.perf_counter() - t0
    check("status ok", r["ok"], json.dumps(r)[:200])
    s = r.get("result", {})
    print(f"  python={s.get('python')} asdf={s.get('asdf')} numpy={s.get('numpy')} "
          f"roman={s.get('has_roman_datamodels')} stretch={s.get('stretch_backend')} "
          f"(first response after spawn: {dt:.2f}s)")
    check("asdf available", s.get("asdf") is not None)
    caps = s.get("capabilities", {})
    check("status reports capabilities",
          "zscale" in caps.get("stretches", [])
          and "manual" in caps.get("stretches", [])
          and (caps.get("cmaps") or ["gray"])[0] == "gray")

    print("== open small (cold parse) ==")
    t0 = time.perf_counter()
    r = req("open", {"path": small})
    cold_small = time.perf_counter() - t0
    check("open ok", r["ok"], json.dumps(r)[:300])
    rec = r.get("result", {})
    check("tree is object", rec.get("tree", {}).get("type") == "object")
    check("preview_array recommended", rec.get("preview_array") == "data")
    arrays = {a["path"]: a for a in rec.get("arrays", [])}
    check("catalog has data 512x512",
          arrays.get("data", {}).get("shape") == [512, 512])
    check("wavelengths not previewable",
          arrays.get("wavelengths", {}).get("previewable") is False)
    lst = rec["tree"]["children"]["meta"]["children"]["photometry"][
        "children"]["pixel_response_table"]
    check("long list truncated & flagged",
          lst.get("truncated") is True and lst.get("length") == 400
          and len(lst.get("items", [])) == 256)
    long_text = rec["tree"]["children"]["meta"]["children"]["long_text"]
    check("long string truncated", long_text.get("truncated") is True
          and long_text.get("length") == 3000)
    instr = rec["tree"]["children"]["meta"]["children"].get("instrument", {}).get("children", {})
    if "resolution" in instr:  # only present when asdf-astropy was available at fixture time
        check("quantity leaf has unit",
              instr["resolution"].get("type") == "quantity"
              and bool(instr["resolution"].get("unit")))
    print(f"  cold open: {cold_small * 1000:.0f} ms")

    print("== open small again (cached) ==")
    t0 = time.perf_counter()
    r2 = req("open", {"path": small})
    hot_small = time.perf_counter() - t0
    check("reopen ok", r2["ok"])
    check("reopen returns same record shape",
          r2.get("result", {}).get("preview_array") == "data")
    print(f"  hot open: {hot_small * 1000:.1f} ms (must be << cold)")
    check("hot open is fast (<250ms)", hot_small < 0.25)

    print("== image from small ==")
    r = req("image", {"path": small})
    check("image ok", r["ok"], json.dumps(r)[:300])
    img = r.get("result", {})
    png = base64.b64decode(img.get("png", ""))
    check("png magic", png[:8] == b"\x89PNG\r\n\x1a\n")
    check("small image undownsampled", (img.get("width"), img.get("height")) == (512, 512),
          f"{img.get('width')}x{img.get('height')}")
    check("zscale reported", "ZScaleInterval" in str(img.get("stretch", {}).get("algorithm")))
    stats = img.get("stats", {})
    check("stats sane (max>min)", (stats.get("max") or 0) > (stats.get("min") or 0))
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(png))
        check("png decodes (PIL)", im.size == (512, 512) and im.mode == "L",
              f"{im.size} {im.mode}")
    except ImportError:
        print("  [skip] PIL not available for decode check")

    print("== explicit array_path ==")
    r = req("image", {"path": small, "array_path": "pixel_scale"})
    check("explicit array ok", r["ok"], json.dumps(r)[:200])
    if r.get("ok"):
        check("explicit dims", r["result"].get("width") == 64)

    print("== render options (stretch / gamma / manual bounds / cmaps) ==")
    r_def = req("image", {"path": small})  # default zscale gray, for comparisons
    png_zscale = base64.b64decode(r_def["result"]["png"])

    r = req("image", {"path": small, "stretch": "linear"})
    check("linear ok + different pixels",
          r["ok"] and r["result"]["png"] != r_def["result"]["png"]
          and r["result"]["stretch"]["algorithm"].startswith("linear"),
          json.dumps(r)[:200])

    r = req("image", {"path": small, "stretch": "percentile"})
    check("percentile ok + labeled",
          r["ok"] and "percentile" in r["result"]["stretch"]["algorithm"])

    r = req("image", {"path": small, "gamma": 2.0})
    check("gamma changes pixels + echoed in meta",
          r["ok"] and r["result"]["png"] != png_zscale
          and r["result"]["stretch"].get("gamma") == 2.0)

    lo, hi = r_def["result"]["stretch"]["vmin"], r_def["result"]["stretch"]["vmax"]
    r = req("image", {"path": small, "vmin": lo, "vmax": hi})
    check("manual bounds override + labeled",
          r["ok"] and r["result"]["stretch"]["algorithm"] == "manual",
          json.dumps(r)[:200])

    cmap_names = caps.get("cmaps", ["gray"])
    r = req("image", {"path": small, "cmap": "does-not-exist"})
    check("unknown cmap -> E_BAD_REQUEST listing supported",
          not r["ok"] and r["error"]["code"] == "E_BAD_REQUEST"
          and "gray" in r["error"]["message"])
    if len(cmap_names) > 1:
        cname = cmap_names[1]
        r = req("image", {"path": small, "cmap": cname})
        check(f"cmap {cname} ok + echoed in meta",
              r["ok"] and r["result"]["stretch"].get("cmap") == cname,
              json.dumps(r)[:200])
        try:
            from PIL import Image as _PILImage

            im = _PILImage.open(io.BytesIO(base64.b64decode(r["result"]["png"])))
            check(f"cmap png decodes as RGB {im.size}", im.mode == "RGB")
        except ImportError:
            print("  [skip] PIL not available for cmap decode check")
    else:
        print("  [note] matplotlib absent -> only 'gray' (graceful path)")

    r = req("image", {"path": small, "stretch": "log"})
    check("bad stretch -> E_BAD_REQUEST",
          not r["ok"] and r["error"]["code"] == "E_BAD_REQUEST")
    r = req("image", {"path": small, "vmin": 1.0})
    check("half-provided bounds -> E_BAD_REQUEST",
          not r["ok"] and r["error"]["code"] == "E_BAD_REQUEST")
    r = req("image", {"path": small, "vmin": 5.0, "vmax": 1.0})
    check("inverted bounds -> E_BAD_REQUEST",
          not r["ok"] and r["error"]["code"] == "E_BAD_REQUEST")

    print("== big file: cold open + downsampled image ==")
    t0 = time.perf_counter()
    r = req("open", {"path": big})
    cold_big = time.perf_counter() - t0
    check("big open ok", r["ok"], json.dumps(r)[:300])
    brec = r.get("result", {})
    print(f"  big cold open: {cold_big:.2f} s ({os.path.getsize(big) / 1e6:.0f} MB file)")
    t0 = time.perf_counter()
    r = req("image", {"path": big})
    dt_img = time.perf_counter() - t0
    check("big image ok", r["ok"], json.dumps(r)[:300])
    bimg = r.get("result", {})
    check("downsampled to 1024x1024", (bimg.get("width"), bimg.get("height")) == (1024, 1024),
          f"{bimg.get('width')}x{bimg.get('height')}")
    check("downsample factor [4,4]", bimg.get("downsample_factor") == [4, 4])
    png = base64.b64decode(bimg.get("png", ""))
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(png))
        check("big png decodes", im.size == (1024, 1024))
    except ImportError:
        pass
    print(f"  big image render: {dt_img * 1000:.0f} ms")

    print("== repeat image request (warm) ==")
    t0 = time.perf_counter()
    r = req("image", {"path": big})
    warm_img = time.perf_counter() - t0
    check("repeat image ok", r["ok"])
    print(f"  warm image: {warm_img * 1000:.0f} ms")

    print("== error paths ==")
    r = req("open", {"path": "/no/such/file.asdf"})
    check("missing file -> E_FILE_NOT_FOUND",
          not r["ok"] and r["error"]["code"] == "E_FILE_NOT_FOUND")
    r = req("image", {"path": small, "array_path": "meta.nonexistent"})
    check("bad array path -> E_NO_ARRAY",
          not r["ok"] and r["error"]["code"] == "E_NO_ARRAY")
    r = req("frobnicate", {})
    check("unknown method -> E_BAD_REQUEST",
          not r["ok"] and r["error"]["code"] == "E_BAD_REQUEST")
    proc.stdin.write("{not json}\n")
    proc.stdin.flush()
    r = req("ping")  # next readable line must still be our ping answer
    check("garbage line does not desync protocol",
          r.get("ok") is True and r.get("result", {}).get("pong") is True)

    print("== close + clean shutdown ==")
    r = req("close", {"path": big})
    check("close ok", r["ok"] and r["result"].get("closed") is True)
    proc.stdin.close()
    rc = proc.wait(timeout=10)
    check("backend exits cleanly (rc=0)", rc == 0, f"rc={rc}")
    stderr_tail = proc.stderr.read().strip().splitlines()
    if stderr_tail:
        print(f"  backend stderr tail:\n    " + "\n    ".join(stderr_tail[-5:]))

    print()
    if FAILURES:
        print(f"SMOKE TEST FAILED: {len(FAILURES)} failure(s): {FAILURES}")
        return 1
    print("SMOKE TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
