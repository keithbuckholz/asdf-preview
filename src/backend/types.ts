/**
 * Shared protocol types for the extension-host <-> Python backend channel.
 *
 * These mirror python/protocol.py and the handler results in
 * python/{inspection,imaging}.py EXACTLY (field names included) -- if you
 * change one side, change the other. The wire format is newline-delimited
 * JSON; see DEVELOPMENT.md for the normative spec.
 */

/** Stable error codes (python/protocol.py + host-side syntheses). */
export const ERROR_CODES = {
  E_BAD_REQUEST: "E_BAD_REQUEST",
  E_FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
  E_PARSE: "E_PARSE",
  E_NO_ASDLIB: "E_NO_ASDLIB",
  E_NO_ARRAY: "E_NO_ARRAY",
  E_BAD_ARRAY: "E_BAD_ARRAY",
  E_INTERNAL: "E_INTERNAL",
  // Synthesized by the extension host, never sent by the python process:
  E_NO_PYTHON: "E_NO_PYTHON",
  E_TIMEOUT: "E_TIMEOUT",
  E_BACKEND_DIED: "E_BACKEND_DIED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Typed error carrying a protocol error code + optional install hint. */
export class BackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly stderrTail?: string
  ) {
    super(message);
    this.name = "BackendError";
  }
}

// ---------------------------------------------------------------------------
// Methods (request -> result)
// ---------------------------------------------------------------------------

export interface StatusResult {
  python: string;
  asdf: string | null; // null when the package is missing in that interpreter
  numpy: string | null;
  has_roman_datamodels: boolean;
  stretch_backend: "astropy ZScaleInterval" | "percentile(2-98) fallback";
  /** UI builds its dropdowns from this; a minimal interpreter reports only 'gray'. */
  capabilities?: { stretches: string[]; cmaps: string[] };
  pid: number;
}

/** Optional user image settings forwarded to the backend `image` method. */
export interface RenderOpts {
  stretch?: "zscale" | "linear" | "percentile" | "manual";
  gamma?: number; // 0.05..10, 1 = no change
  cmap?: string; // 'gray' always; matplotlib names when available
  vmin?: number; // both present -> manual override
  vmax?: number;
}

export interface PingResult {
  pong: true;
  uptime_s: number;
}

/** Catalog entry for one ndarray found anywhere in the tree. */
export interface ArrayInfo {
  path: string; // dotted path, e.g. "meta.pointing.data" or "data"
  shape: number[];
  dtype: string;
  nbytes: number;
  masked?: boolean;
  unit?: string; // only for astropy Quantities with ndim >= 1
  previewable: boolean; // 2-D numeric and non-empty
  recommended?: boolean; // the default quick-look array
}

/** One node of the serialized metadata tree (JSON-safe, capped). */
export interface TreeNode {
  type:
    | "object"
    | "list"
    | "ndarray"
    | "integer"
    | "number"
    | "str"
    | "bool"
    | "null"
    | "datetime"
    | "date"
    | "time"
    | "bytes"
    | "quantity"
    | "other"
    | "omitted";
  // object
  keys?: number;
  children?: { [key: string]: TreeNode };
  // list
  length?: number;
  truncated?: boolean;
  items?: TreeNode[];
  // ndarray leaves
  path?: string;
  shape?: number[];
  dtype?: string;
  nbytes?: number;
  masked?: boolean;
  unit?: string;
  previewable?: boolean;
  recommended?: boolean;
  // scalar leaves
  value?: unknown;
  representation?: string; // NaN / Infinity / -Infinity, or repr for "other"
  class?: string; // python class name for type "other"
  reason?: string; // for "omitted" (node cap)
}

/** Result of the `open` method. */
export interface OpenRecord {
  uri: string;
  path: string;
  size_bytes: number;
  mtime_ns: number;
  title: string;
  schema_uri: string | null;
  opened_with: "asdf" | "roman_datamodels";
  asdf_version: string | null;
  tree: TreeNode;
  truncated: boolean;
  arrays: ArrayInfo[];
  preview_array: string | null;
}

/** Result of the `image` method (PNG arrives base64-inlined). */
export interface ImageResult {
  array_path: string;
  png: string; // base64 PNG (8-bit gray, or RGB when a colormap is applied)
  width: number;
  height: number;
  full_shape: number[];
  downsample_factor: [number, number];
  stretch: {
    algorithm: string;
    vmin: number | null;
    vmax: number | null;
    gamma?: number;
    cmap?: string;
  };
  stats: {
    min: number | null;
    max: number | null;
    mean: number | null;
    std: number | null;
    finite_fraction: number | null;
    sampled: boolean;
  };
  note?: string; // e.g. "no finite values"
}

export interface CloseResult {
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export interface RequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseFrame<T = unknown> {
  id: number | null; // null only for unsalvageable malformed lines
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; hint?: string };
}
