#!/usr/bin/env python3
"""Generate synthetic ASDF fixtures for smoke-testing the backend.

Creates (next to this file):
  small.asdf -- ~1 MB: 512^2 data + a second 2-D array + assorted metadata,
                including a >256-element list to exercise tree truncation.
  big.asdf   -- ~90 MB: 4096^2 float32 `data` with a Gaussian PSF blob,
                NaN corner (DQ-style), int/uint arrays, 1-D array.

Usage:  python testdata/generate.py
"""
from __future__ import annotations

import datetime
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def make_small(path: str) -> None:
    rng = np.random.default_rng(42)
    yy, xx = np.mgrid[0:512, 0:512]
    blob = 2.4 * np.exp(-(((xx - 260) ** 2 + (yy - 230) ** 2) / (2 * 18.0**2)))
    data = (blob + 0.05 + 0.01 * rng.standard_normal((512, 512))).astype(np.float32)

    tree = {
        "meta": {
            "title": "Synthetic small fixture",
            "program": {"id": 1076, "title": "Roman synthetic program"},
            "observation": {
                "target_name": "M31-core",
                "pointing_ra": 10.6847,
                "pointing_dec": 41.2689,
                "date_observed": datetime.datetime(2027, 3, 15, 2, 41, 7, tzinfo=datetime.timezone.utc),
                "obs_id": "702557cc-877b-588e-a844-98cb1addfbb4",  # UUID-like string (plain asdf can't write UUID objects)
            },
            "instrument": {"name": "WFI", "optical_element": "F087R"},
            "photometry": {
                "zeropoint": 25.413,
                # >256 items: exercises the list-truncation cap in the tree view
                "pixel_response_table": [round(1.0 + i * 0.001, 4) for i in range(400)],
            },
            "long_text": "x" * 3000,  # exercises string truncation
        },
        "data": data,
        "pixel_scale": rng.random((64, 64), dtype=np.float32) + 1.0,
        "wavelengths": np.linspace(0.5, 0.9, 20, dtype=np.float32),  # 1-D: not previewable
    }

    try:
        # Importing asdf_astropy registers its converters; without it these
        # objects are not serializable by plain asdf (and the fixture omits
        # them instead of failing). Loading such files likewise needs an
        # astropy-aware environment -- realistic, since JWST/Roman products
        # commonly embed Angle/Quantity nodes.
        import asdf_astropy  # noqa: F401
        from astropy import units as u
        from astropy.coordinates import Angle

        tree["meta"]["instrument"]["resolution"] = Angle(0.11, unit="arcsec")
        tree["meta"]["photometry"]["mag_zeropoint_unc"] = 0.02 * u.mag
    except Exception:
        pass

    _write(path, tree)


def make_big(path: str) -> None:
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[0:4096, 0:4096]
    # A bright Gaussian PSF on a noisy background, plus one NaN corner block
    # (mimics DQ-margined data to test the stretch pipeline's nan handling).
    blob = 3.1 * np.exp(-(((xx - 2100) ** 2 + (yy - 1700) ** 2) / (2 * 42.0**2)))
    data = (blob + 0.08 + 0.02 * rng.standard_normal((4096, 4096))).astype(np.float32)
    data[:256, :256] = np.nan

    tree = {
        "meta": {
            "title": "Synthetic big fixture (Roman WFI-shaped)",
            "instrument": {"name": "WFI"},
            "date_observed": datetime.datetime(2027, 3, 15, 3, 0, 0),
        },
        "data": data,
        "dq": (rng.integers(0, 4, (4096, 4096), dtype=np.uint8) * 0).astype(np.uint8),
        "err": (0.01 + 0.005 * rng.random((2048, 2048))).astype(np.float32),
        "flags_sci": rng.integers(0, 8, (2048, 2048)).astype(np.uint16),
    }
    _write(path, tree)


def _write(path: str, tree: dict) -> None:
    import asdf

    with asdf.AsdfFile(tree) as af:
        # Copy blocks to a temp file first (avoids in-place rewrite races) and
        # then move into place so the on-disk artifact is always complete.
        tmp = path + ".tmp"
        af.write_to(tmp)
    os.replace(tmp, path)
    print(f"wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)")


if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else HERE
    os.makedirs(outdir, exist_ok=True)
    make_small(os.path.join(outdir, "small.asdf"))
    make_big(os.path.join(outdir, "big.asdf"))
