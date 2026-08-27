/**
 * BackendManager -- owns the persistent python backend's lifecycle from the
 * extension host.
 *
 *   stopped ──first request──▶ starting ──handshake ok──▶ ready
 *      ▲                            │                         │
 *      │                            ▼ (spawn/handshake fail)  │ process exits
 *      └──── markDead() ◀──────── failed ◀────────────────────┘
 *
 * Invariants:
 *  - At most ONE backend process at a time; requests before it is ready queue
 *    on the same start promise (no duplicate spawns).
 *  - Python/import startup cost is paid ONCE per session, not per file open.
 *  - Repeated hard failures are throttled (no hot restart loop); the user can
 *    always force a retry via "ASDF Preview: Restart Python Backend".
 *  - A backend crash never rejects silently: pending requests fail with
 *    E_BACKEND_DIED (+ stderr tail) and the next request transparently
 *    re-spawns.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { BackendProcess, SpawnSpec } from "./client";
import { BackendError, ERROR_CODES, StatusResult } from "./types";

export type BackendState = "stopped" | "starting" | "ready" | "failed";

// Per-method timeouts (ms). `status` gets a cold budget: the first request on
// a fresh process pays for python + asdf (+ optional astropy/roman) imports.
const COLD_TIMEOUT_MS = 30_000;
const FAST_TIMEOUT_MS = 10_000;

const MAX_FAST_FAILURES = 3; // failures within the window before we pause
const FAILURE_WINDOW_MS = 60_000;

interface PythonCandidate {
  command: string;
  args: string[]; // interpreter pre-args (e.g. ["-3"] for py launcher)
  label: string;
}

export class BackendManager implements vscode.Disposable {
  private proc: BackendProcess | null = null;
  private starting: Promise<BackendProcess> | null = null;
  private resolvedPython: PythonCandidate | null = null; // cached success
  private failStreak = 0;
  private lastFailureAt = 0;
  private status: StatusResult | null = null;

  state: BackendState = "stopped";
  readonly output: vscode.OutputChannel;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(
    /** Absolute path of the extension root (contains python/backend_main.py). */
    private readonly extensionRoot: string,
    context: vscode.ExtensionContext
  ) {
    this.output = vscode.window.createOutputChannel("ASDF Preview");
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100 // only visible while the backend is alive/starting
    );
    this.statusItem.name = "ASDF Preview backend status";
    this.statusItem.command = "asdfPreview.restartBackend";
    context.subscriptions.push(this.output, this.statusItem);
  }

  private log(msg: string): void {
    this.output.appendLine(msg);
  }

  // ------------------------------------------------------------------ public

  /** Send a request to the backend, starting it on first use. */
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const proc = await this.ensureReady();
    const timeoutMs =
      method === "status"
        ? COLD_TIMEOUT_MS
        : method === "open" || method === "image"
          ? vscode.workspace
              .getConfiguration("asdfPreview")
              .get<number>("requestTimeoutSeconds", 60) * 1000
          : FAST_TIMEOUT_MS;
    try {
      return (await proc.request<T>(method, params, timeoutMs)) as T;
    } catch (err) {
      // A dead process is a manager concern: clear state so the NEXT request
      // transparently re-spawns. (dispose() during restart is idempotent-safe.)
      if (err instanceof BackendError && err.code === ERROR_CODES.E_BACKEND_DIED) {
        this.markDead();
      }
      throw err;
    }
  }

  /** Best-effort release of a cached file (called when a panel is disposed). */
  closeFile(fsPath: string): void {
    if (!this.proc || this.proc.exited) return;
    this.proc
      .request("close", { path: fsPath }, 2_000)
      .catch(() => undefined); // never surface from a dispose path
  }

  /** Kill + allow immediate respawn (command: asdfPreview.restartBackend). */
  async restart(): Promise<void> {
    this.failStreak = 0;
    this.lastFailureAt = 0;
    if (this.proc) {
      this.proc.dispose();
      this.proc = null;
    }
    this.starting = null;
    this.state = "stopped";
    this.setStatusBar("$(sync~spin) restarting backend…");
  }

  get capabilities(): StatusResult | null {
    return this.status;
  }

  dispose(): void {
    this.proc?.dispose();
    this.proc = null;
    this.statusItem.dispose(); // via subscriptions
  }

  // ------------------------------------------------------------ state machine

  private async ensureReady(): Promise<BackendProcess> {
    if (this.proc && !this.proc.exited) return this.proc;
    if (this.proc?.exited) {
      // Stale handle left behind by markDead() racing a request.
      this.proc = null;
    }

    const now = Date.now();
    if (
      this.failStreak >= MAX_FAST_FAILURES &&
      now - this.lastFailureAt < FAILURE_WINDOW_MS
    ) {
      const waitS = Math.ceil((FAILURE_WINDOW_MS - (now - this.lastFailureAt)) / 1000);
      throw new BackendError(
        ERROR_CODES.E_BACKEND_DIED,
        `Python backend has failed ${this.failStreak} times in the last minute; pausing ~${waitS}s to avoid a restart loop.`,
        "Fix the underlying problem (see 'ASDF Preview' output channel), then run 'ASDF Preview: Restart Python Backend'."
      );
    }

    if (!this.starting) {
      this.starting = this.spawn().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async spawn(): Promise<BackendProcess> {
    this.state = "starting";
    this.setStatusBar("$(loading~spin) starting Python backend…");
    const backendScript = path.join(this.extensionRoot, "python", "backend_main.py");
    let proc: BackendProcess | null = null;
    try {
      const py = await this.detectPython();
      const spec: SpawnSpec = {
        command: py.command,
        args: [...py.args, backendScript],
        cwd: this.extensionRoot,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      };
      proc = new BackendProcess(spec, (m) => this.log(m));
      // Handshake doubles as the capability report; it also proves imports
      // actually succeeded before we trust the process for real work.
      const status = await proc.request<StatusResult>("status", {}, COLD_TIMEOUT_MS);
      this.status = status;
      if (!status.asdf) {
        // Keep the process alive (it can still report), but fail loudly with
        // an install hint instead of letting every open() error out vaguely.
        proc.dispose();
        throw new BackendError(
          ERROR_CODES.E_NO_ASDLIB,
          `The Python interpreter ${py.label} does not have the 'asdf' package installed.`,
          "Install it with:  <that interpreter> -m pip install asdf\n" +
            "Optional extras: astropy (proper zscale stretch), roman_datamodels (Roman-aware parsing)."
        );
      }
      this.proc = proc;
      this.failStreak = 0;
      this.state = "ready";
      const roman = status.has_roman_datamodels ? " · roman_dm" : "";
      this.setStatusBar(
        `$(circle-filled) asdf: py${status.python}${roman}`,
        [
          `Python ${status.python} @ backend pid ${status.pid}`,
          `asdf ${status.asdf} · numpy ${status.numpy ?? "?"}`,
          `stretch: ${status.stretch_backend}`,
          "Click to restart the backend.",
        ].join("\n")
      );
      this.log(`backend ready (python ${status.python}, asdf ${status.asdf})`);
      return proc;
    } catch (err) {
      // Kill the half-started child if we got far enough to spawn one -- a
      // hung interpreter must not leak past its failed handshake.
      proc?.dispose();
      // Record failure for throttling; clean up partial state.
      this.proc = null;
      this.failStreak += 1;
      this.lastFailureAt = Date.now();
      this.state = "failed";
      const be = err instanceof BackendError ? err : null;
      this.setStatusBar(
        "$(error) asdf backend failed",
        (be?.message ?? String(err)) + (be?.stderrTail ? `\n\n${be.stderrTail}` : "")
      );
      this.log(`backend start failed: ${be ? be.message : err}${be?.stderrTail ? "\n" + be.stderrTail : ""}`);
      if (!be) throw new BackendError(ERROR_CODES.E_INTERNAL, String(err));
      throw be;
    }
  }

  private markDead(): void {
    const tail = this.proc?.tail();
    this.log(
      `backend process died (exit=${JSON.stringify(this.proc?.exitedInfo)}${tail ? `; stderr: ${tail}` : ""})`
    );
    if (this.proc) {
      this.proc.dispose(); // idempotent; also rejects any late pending requests
    }
    this.proc = null;
    this.status = null;
    this.state = "failed";
    this.setStatusBar(
      "$(warning) asdf backend exited",
      "The python backend stopped unexpectedly. It will restart on the next request."
    );
  }

  private setStatusBar(text: string, tooltip?: string): void {
    this.statusItem.text = text;
    if (tooltip) this.statusItem.tooltip = new vscode.MarkdownString(tooltip);
    this.statusItem.show();
  }

  // ----------------------------------------------------------- python probing

  /**
   * Find a usable python >=3.10. Order:
   *  1. asdfPreview.pythonPath setting (explicit path or bare command),
   *  2. $ASDF_PREVIEW_PYTHON env var,
   *  3. .venv next to the extension (developer convention for this repo),
   *  4. $VIRTUAL_ENV/bin/python (the venv VSCode itself runs in, if any),
   *  5. platform default (python3 / python; py -3 on Windows).
   *
   * Candidates are verified with a cheap `--version` probe (5s cap) before
   * use so we never spawn a garbage interpreter and wait for its import
   * failure. Successful resolutions are cached for the session.
   */
  private async detectPython(): Promise<PythonCandidate> {
    if (this.resolvedPython) return this.resolvedPython;

    const cfgPath = vscode.workspace
      .getConfiguration("asdfPreview")
      .get<string>("pythonPath", "")
      .trim();
    const isWin = process.platform === "win32";

    const candidates: PythonCandidate[] = [];
    if (cfgPath) {
      // Bare commands ("python3", "py -3") are honored as-is.
      if (!isWin || cfgPath.includes("\\") || cfgPath.includes("/")) {
        candidates.push({ command: cfgPath, args: [], label: `setting ${cfgPath}` });
      } else {
        const parts = cfgPath.split(/\s+/);
        candidates.push({ command: parts[0], args: parts.slice(1), label: `setting ${cfgPath}` });
      }
    }
    if (process.env.ASDF_PREVIEW_PYTHON) {
      candidates.push({
        command: process.env.ASDF_PREVIEW_PYTHON,
        args: [],
        label: "$ASDF_PREVIEW_PYTHON",
      });
    }
    const venvPy = isWin ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
    candidates.push({
      command: path.join(this.extensionRoot, venvPy),
      args: [],
      label: `extension .venv (${venvPy})`,
    });
    if (process.env.VIRTUAL_ENV && !isWin) {
      candidates.push({
        command: path.join(process.env.VIRTUAL_ENV, "bin", "python"),
        args: [],
        label: `$VIRTUAL_ENV (${process.env.VIRTUAL_ENV})`,
      });
    }
    if (isWin) {
      candidates.push({ command: "py", args: ["-3"], label: "py -3" });
      candidates.push({ command: "python", args: [], label: "python (PATH)" });
    } else {
      candidates.push({ command: "python3", args: [], label: "python3 (PATH)" });
      candidates.push({ command: "python", args: [], label: "python (PATH)" });
    }

    for (const cand of candidates) {
      const ok = await this.probePython(cand);
      if (ok) {
        this.resolvedPython = cand;
        this.log(`using python: ${cand.label} -> ${cand.command}`);
        return cand;
      }
    }

    throw new BackendError(
      ERROR_CODES.E_NO_PYTHON,
      "No usable Python interpreter found for the ASDF backend.",
      [
        "Install Python >= 3.10 and the asdf package:",
        "    python3 -m pip install asdf",
        "(optional: astropy for proper zscale, roman_datamodels for Roman files)",
        "Or point 'asdfPreview.pythonPath' at an interpreter that already has them.",
      ].join("\n")
    );
  }

  private probePython(cand: PythonCandidate): Promise<boolean> {
    return new Promise((resolve) => {
      const fullArgs = [...cand.args, "--version"];
      execFile(
        cand.command,
        fullArgs,
        { timeout: 5_000, maxBuffer: 64 * 1024 },
        (err, stdout, stderr) => {
          // CPython prints the version to stdout on 3.4+; be lenient.
          const out = `${stdout} ${stderr}`.trim();
          if (!err && /^Python 3\.\d+/.test(out)) return resolve(true);
          // Absolute paths must exist on disk -- catching typos early makes
          // the E_NO_PYTHON hint actionable.
          if (looksLikePath(cand.command) && !fs.existsSync(cand.command)) {
            return resolve(false);
          }
          resolve(false);
        }
      );
    });
  }
}

function looksLikePath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(s) || s.includes("/");
}
