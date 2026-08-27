/**
 * Low-level transport: one long-lived python child process speaking
 * newline-delimited JSON over stdin/stdout.
 *
 * Responsibilities (and only these):
 *  - spawn/kill the process,
 *  - frame requests as JSON lines and split stdout back into frames,
 *  - match responses to pending requests by id (ignoring "orphan" frames --
 *    responses to timed-out requests -- which is what makes client-side
 *    timeouts safe),
 *  - reject everything outstanding when the process dies.
 *
 * Lifecycle policy (when to restart, throttling) lives in manager.ts.
 */
import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

import { BackendError, ERROR_CODES, ResponseFrame } from "./types";

/** Refuse frames larger than this; mirrors protocol.MAX_FRAME_BYTES. */
const MAX_FRAME_BYTES = 50 * 1024 * 1024;
/** Keep only the last few KB of stderr for error display. */
const STDERR_TAIL_LIMIT = 4096;

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class BackendProcess extends EventEmitter {
  private readonly proc: ChildProcess;
  /** Pending requests keyed by protocol id. */
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private buf = Buffer.alloc(0);
  private stderrTail = "";
  /** Set as soon as the process exits or fails to start. */
  exitedInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(spec: SpawnSpec, private readonly logger: (msg: string) => void) {
    super();
    this.logger(`spawning backend: ${spec.command} ${spec.args.join(" ")}`);
    try {
      this.proc = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        // stdio only -- no shell, so quoting/path issues can't bite us.
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.exitedInfo = { code: 127, signal: null };
      throw new BackendError(
        ERROR_CODES.E_BACKEND_DIED,
        `Failed to spawn python interpreter "${spec.command}": ${err instanceof Error ? err.message : err}`
      );
    }

    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
    });
    this.proc.on("error", (err) => {
      // EACCES / ENOENT on spawn -- surface as a clean protocol error.
      this.exitedInfo = { code: 127, signal: null };
      this.stderrTail += `\nspawn error: ${err.message}\n`;
      this.rejectAll(
        new BackendError(
          ERROR_CODES.E_BACKEND_DIED,
          `Backend process failed to start: ${err.message}`,
          undefined,
          this.tail()
        )
      );
    });
    this.proc.on("close", (code, signal) => {
      if (!this.exitedInfo) this.exitedInfo = { code, signal };
      this.rejectAll(
        new BackendError(
          ERROR_CODES.E_BACKEND_DIED,
          `Python backend exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"}).`,
          "The extension will restart it on the next request.",
          this.tail()
        )
      );
    });
  }

  get exited(): boolean {
    return this.exitedInfo !== null;
  }

  /** Last few KB of backend stderr (for error dialogs / output channel). */
  tail(): string | undefined {
    const t = this.stderrTail.trim();
    return t ? t.slice(-STDERR_TAIL_LIMIT) : undefined;
  }

  /** Send one request; resolves with `result`, rejects with BackendError. */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.exited) {
      return Promise.reject(
        new BackendError(
          ERROR_CODES.E_BACKEND_DIED,
          "Backend process is not running.",
          undefined,
          this.tail()
        )
      );
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout does NOT kill the process: the response (when it eventually
        // arrives) carries our id and will be dropped as an orphan. The backend
        // is single-threaded per request-stream, so a genuinely stuck handler
        // would wedge later requests -- manager.ts handles that by restarting
        // on repeated timeouts if needed.
        this.pending.delete(id);
        reject(
          new BackendError(
            ERROR_CODES.E_TIMEOUT,
            `Request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.proc.stdin?.write(line + "\n", (err) => {
          if (err && this.pending.has(id)) {
            // EPIPE etc.: the write never landed; fail fast instead of waiting.
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new BackendError(ERROR_CODES.E_BACKEND_DIED, `Write to backend failed: ${err.message}`)
            );
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new BackendError(
            ERROR_CODES.E_BACKEND_DIED,
            `Write to backend failed: ${err instanceof Error ? err.message : err}`
          )
        );
      }
    });
  }

  /** Stop the process (idempotent). */
  dispose(): void {
    if (this.exitedInfo) return;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    // SIGTERM lets python flush its close handlers; escalate after 2s.
    const killTimer = setTimeout(() => {
      try {
        if (!this.exitedInfo) this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 2000);
    killTimer.unref?.();
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.rejectAll(
      new BackendError(ERROR_CODES.E_BACKEND_DIED, "Backend process was stopped.")
    );
  }

  // ---------------------------------------------------------------- internals

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // A line may span multiple chunks; keep the partial tail for next time.
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) !== -1) {
      const frameBytes = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      if (frameBytes.length === 0) continue;
      if (frameBytes.length > MAX_FRAME_BYTES) {
        // Runaway output: the channel is untrustworthy. Kill it and let the
        // manager restart -- far better than OOMing the extension host.
        this.logger("response frame exceeded max size; killing backend");
        this.dispose();
        return;
      }
      this.handleFrame(frameBytes.toString("utf8"));
    }
    // Guard against a pathological partial line growing without bound.
    if (this.buf.length > MAX_FRAME_BYTES) {
      this.logger("partial response frame exceeded max size; killing backend");
      this.dispose();
    }
  }

  private handleFrame(line: string): void {
    let frame: ResponseFrame;
    try {
      frame = JSON.parse(line) as ResponseFrame;
    } catch (err) {
      // Never let a stray line take the channel down; log and move on.
      this.logger(`unparseable response frame: ${line.slice(0, 200)} (${err})`);
      return;
    }
    const p = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
    if (!p) {
      // Orphan: client already timed out (or ids advanced after a restart).
      // Dropping is the correct behavior per the protocol contract.
      this.logger(`ignoring orphan response (id=${String(frame.id)})`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(frame.id as number);
    if (frame.ok && frame.result !== undefined) {
      p.resolve(frame.result);
    } else if (!frame.ok && frame.error) {
      p.reject(
        new BackendError(frame.error.code, frame.error.message, frame.error.hint, this.tail())
      );
    } else {
      p.reject(
        new BackendError(
          ERROR_CODES.E_INTERNAL,
          "Malformed response frame from backend."
        )
      );
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
