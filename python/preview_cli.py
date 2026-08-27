#!/usr/bin/env python3
"""Terminal quick-look for .asdf files (no VSCode needed).

Uses the exact same inspection/imaging modules as the persistent backend, so
what you see here matches what the webview renders.

    python preview_cli.py FILE [--array PATH] [--max-side N]
                            [--out PNG] [--tree-depth D] [--no-image]

Examples:
    python preview_cli.py wfi_image-1.asdf                 # summary + outline, default PNG
    python preview_cli.py f.asdf --array dq --out dq.png   # specific array
    python preview_cli.py f.asdf --tree-depth 4            # deeper outline
"""
from __future__ import annotations

import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import protocol  # noqa: E402
from protocol import BackendError  # noqa: E402
import inspection  # noqa: E402
import imaging  # noqa: E402


def outline(node, depth: int, max_depth: int, lines: list[str], prefix: str = "") -> None:
    """Human-readable tree outline (scalars inline, arrays as chips)."""
    if node.get("type") == "object" and "children" in node:
        for key, child in node["children"].items():
            if depth >= max_depth:
                lines.append(f"{prefix}{key}: …")
                continue
            _outline_entry(key, child, depth, max_depth, lines, prefix)


def _outline_entry(name, node, depth, max_depth, lines, prefix) -> None:
    t = node.get("type")
    if t == "object":
        lines.append(f"{prefix}{name}/  ({node.get('keys', '?')} keys)")
        outline(node, depth + 1, max_depth, lines, prefix + "  ")
    elif t == "list":
        trunc = f"… +{node['length'] - len(node['items'])} more" if node.get("truncated") else ""
        lines.append(f"{prefix}{name}: [{node.get('length', '?')} items]{trunc}")
        for i, item in enumerate(node["items"][:5]):  # keep outlines short
            _outline_entry(f"[{i}]", item, depth + 1, max_depth, lines, prefix + "   ")
    elif t == "ndarray":
        shape = "×".join(str(s) for s in node.get("shape", []))
        mark = "  ◀ previewable" if node.get("previewable") else ""
        lines.append(f"{prefix}{name}: [{shape}] {node.get('dtype', '?')}{mark}")
    elif t == "omitted":
        lines.append(f"{prefix}{name}: … (truncated)")
    else:
        val = node.get("value")
        if isinstance(val, str) and len(val) > 80:
            val = val[:79] + "…"
        unit = f" {node['unit']}" if node.get("unit") else ""
        rep = f" ({node.get('representation')})" if node.get("representation") else ""
        lines.append(f"{prefix}{name}: {val!r}{rep}{unit}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="path to the .asdf file")
    ap.add_argument("--array", default=None, help="dotted path of the array to preview (default: recommended)")
    ap.add_argument("--max-side", type=int, default=1024, help="max preview side in pixels (64-4096)")
    ap.add_argument("--out", default=None, help="output PNG path (default: <file>.quicklook.png)")
    ap.add_argument("--tree-depth", type=int, default=3, help="outline depth (default 3)")
    ap.add_argument("--no-image", action="store_true", help="skip rendering the PNG")
    args = ap.parse_args()

    try:
        rec = inspection.build_record(args.file)
    except BackendError as exc:
        print(f"error [{exc.code}]: {exc}", file=sys.stderr)
        if getattr(exc, "extra", {}).get("hint"):
            print(exc.extra["hint"], file=sys.stderr)
        return 1

    # --- summary -------------------------------------------------------------
    size_mb = rec["size_bytes"] / 1e6
    print(f"{rec['title']}   ({os.path.basename(args.file)}, {size_mb:.1f} MB)")
    if rec.get("schema_uri"):
        print(f"schema : {rec['schema_uri']}")
    print(f"parser : {rec['opened_with']}" + (f" (asdf {rec['asdf_version']})" if rec.get("asdf_version") else ""))

    n_previewable = sum(1 for a in rec["arrays"] if a.get("previewable"))
    print(f"arrays : {len(rec['arrays'])} total, {n_previewable} previewable (2-D)")
    for a in rec["arrays"]:
        shape = "×".join(str(s) for s in a["shape"])
        tag = " ◀ default" if a.get("recommended") else (" (2-D)" if a.get("previewable") else "")
        print(f"  - {a['path']}: [{shape}] {a['dtype']}{tag}")

    # --- outline -------------------------------------------------------------
    lines: list[str] = []
    outline(rec["tree"], 0, args.tree_depth, lines)
    if rec.get("truncated"):
        lines.append("… (tree truncated by backend node cap)")
    print("\nmetadata outline:")
    print("\n".join(lines))

    # --- image ---------------------------------------------------------------
    if args.no_image:
        return 0
    array_path = args.array or rec.get("preview_array")
    if not array_path:
        print("\nno 2-D image-like array found; nothing to render")
        return 0

    try:
        entry = inspection.get_entry(args.file)
        result = imaging.make_preview(entry.tree, str(array_path), args.max_side)
    except BackendError as exc:
        print(f"\nerror [{exc.code}]: could not render {array_path!r}: {exc}", file=sys.stderr)
        return 1

    out = args.out or os.path.splitext(args.file)[0] + ".quicklook.png"
    with open(out, "wb") as fh:
        fh.write(base64.b64decode(result["png"]))

    st = result["stats"]
    print(
        f"\npreview: {out}\n"
        f"  array   : {result['array_path']} full={result['full_shape']} "
        f"stride={result['downsample_factor']} -> {result['width']}x{result['height']}\n"
        f"  stretch : {result['stretch']['algorithm']} "
        f"[{result['stretch']['vmin']}, {result['stretch']['vmax']}]\n"
        f"  stats   : min={st['min']} max={st['max']} mean={st['mean']} std={st['std']}"
    )
    inspection.close_file(args.file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
