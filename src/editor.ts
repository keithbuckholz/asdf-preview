/**
 * Custom (read-only) editor for *.asdf files.
 *
 * The webview is a plain HTML/CSS/JS panel (media/) with zero external
 * dependencies. Data flow per file open:
 *
 *   webview --ready/reload/image-->  this provider  --open/image-->  BackendManager
 *   webview <--tree / image / error--  this provider  <--responses---  python backend
 *
 * The tree is delivered first (fast, cheap when cached); the quick-look PNG
 * follows as soon as it is rendered, so the UI never blocks on the image.
 */
import * as path from "path";
import * as vscode from "vscode";

import { BackendManager } from "./backend/manager";
import {
  BackendError,
  ImageResult,
  OpenRecord,
  StatusResult,
  RenderOpts,
  ERROR_CODES,
} from "./backend/types";

const VIEW_TYPE = "asdfPreview.editor";

/** Opaque custom document: we only ever need the uri (parsing is on-demand). */
export class AsdfCustomDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    /* nothing to clean up; the backend cache slot is freed via closeFile */
  }
}

interface WebviewMsgIn {
  type?: string;
  array?: unknown;
  opts?: Partial<RenderOpts>;
}

export class AsdfEditorProvider implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  /** panels per document-uri (a file can be open in several tabs). */
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();

  constructor(
    private readonly backend: BackendManager,
    private readonly extRoot: vscode.Uri,
    private readonly output?: vscode.OutputChannel
  ) {}

  private log(msg: string): void {
    this.output?.appendLine(`[editor] ${msg}`);
  }

  // -------------------------------------------------- provider contract

  isSupportedForUri(uri: vscode.Uri): boolean {
    return uri.scheme === "file" && /\.asdf$/i.test(uri.path);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<AsdfCustomDocument> {
    // Fail-soft + observable: if anything here throws, VSCode's workbench has
    // no fallback for a failed custom-document open (it asserts). Log and rethrow.
    try {
      const doc = new AsdfCustomDocument(uri);
      this.log(`openCustomDocument ${uri.fsPath}`);
      return doc;
    } catch (err) {
      this.log(`openCustomDocument FAILED for ${uri.fsPath}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  }

  resolveCustomEditor(
    document: AsdfCustomDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    // Everything here runs inside the workbench's editor-resolution pipeline.
    // A throw would surface as an opaque assertion in renderer.log, so wrap it
    // all and at least leave a trail in our own output channel.
    try {
      this.resolveCustomEditorInner(document, panel);
    } catch (err) {
      this.log(
        `resolveCustomEditor FAILED for ${document.uri.fsPath}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`
      );
      try {
        panel.webview.html = `<html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-errorForeground)">
          <h3>ASDF Preview failed to initialize</h3>
          <pre>${String(err instanceof Error ? err.message : err)}</pre>
          <p>Details in the \u201cASDF Preview\u201d output channel (View &gt; Output).</p></body></html>`;
      } catch {
        /* panel may already be gone */
      }
      throw err;
    }
  }

  private resolveCustomEditorInner(
    document: AsdfCustomDocument,
    panel: vscode.WebviewPanel
  ): void {
    const key = document.uri.toString();
    this.panels.set(key, panel);

    panel.webview.options = {
      enableScripts: true,
      // (retainContextWhenHidden is set in registerCustomEditorProvider's
      // webviewOptions, which is where 1.85 wants it.)
    };
    panel.webview.html = this.buildHtml(panel.webview);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const watcher = this.watchers.get(key);
      if (watcher) {
        watcher.dispose();
        this.watchers.delete(key);
      }
      // Release our backend-side cache slot for this file (best effort).
      this.backend.closeFile(document.uri.fsPath);
    });

    panel.webview.onDidReceiveMessage((msg: WebviewMsgIn) => {
      void this.onWebviewMessage(document.uri, panel, msg);
    });

    this.log(`resolveCustomEditor ok for ${document.uri.fsPath}`);

    // Auto-reload when the file on disk changes (e.g. just calibrated).
    try {
      const pattern = new vscode.RelativePattern(
        path.dirname(document.uri.fsPath),
        path.basename(document.uri.fsPath)
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const reload = () => void this.load(document.uri, panel);
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      this.watchers.set(key, watcher);
    } catch {
      /* watch is a nicety; never block the editor on it */
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
  }

  // ----------------------------------------------------------------- commands

  /** "asdfPreview.reload": re-run load for the active ASDF editor tab. */
  reloadActive(): void {
    // Find the active custom-editor tab (window.tabGroups API; available since
    // 1.63 and typed in our engine range -- window.activeCustomEditor is not).
    let handled = false;
    for (const group of vscode.window.tabGroups.all) {
      const activeTab = group.tabs.find((t) => t.isActive);
      if (!activeTab) continue;
      const input = activeTab.input as { viewType?: string; document?: { uri: vscode.Uri } };
      if (
        input &&
        typeof input === "object" &&
        input.viewType === VIEW_TYPE &&
        input.document
      ) {
        const panel = this.panels.get(input.document.uri.toString());
        if (panel) {
          void this.load(input.document.uri, panel);
          handled = true;
          break;
        }
      }
    }
    if (!handled) {
      // Fallback: refresh every open ASDF tab (cheap; cached opens are ms).
      for (const [key, panel] of this.panels) {
        void this.load(vscode.Uri.parse(key), panel);
      }
    }
  }

  /** After a backend restart: refresh all open tabs so stale errors clear. */
  reloadAll(): void {
    for (const [key, panel] of this.panels) {
      void this.load(vscode.Uri.parse(key), panel);
    }
  }

  // ------------------------------------------------------------------ loading

  private async onWebviewMessage(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel,
    msg: WebviewMsgIn
  ): Promise<void> {
    switch (msg?.type) {
      case "ready": // webview script finished booting; start the first load
        await this.load(uri, panel);
        break;
      case "reload":
        await this.load(uri, panel);
        break;
      case "image": {
        if (typeof msg.array !== "string" || !msg.array) break;
        try {
          const maxSide = vscode.workspace
            .getConfiguration("asdfPreview")
            .get<number>("maxImageSide", 1024);
          // Forward user image settings; the backend validates (E_BAD_REQUEST
          // with an actionable message on anything out of contract).
          const params: Record<string, unknown> = {
            path: uri.fsPath,
            array_path: msg.array,
            max_side: maxSide,
          };
          const o = msg.opts || {};
          if (typeof o.stretch === "string") params.stretch = o.stretch;
          if (typeof o.cmap === "string") params.cmap = o.cmap;
          for (const k of ["gamma", "vmin", "vmax"] as const) {
            const v = o[k];
            if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
          }
          const payload = await this.backend.request<ImageResult>("image", params);
          this.post(panel, { kind: "image", scope: "image", payload });
        } catch (err) {
          this.postError(panel, "image", err);
        }
        break;
      }
      default:
        break; // ignore unknown messages from the webview
    }
  }

  /** Open (or re-open) *uri*: push tree first, image right after. */
  private async load(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    this.post(panel, { kind: "status", phase: "loading" });
    // Backend capabilities (stretch/colormap lists) for the settings row.
    // Fire-and-forget: a failure here must never block opening the file.
    this.backend
      .request<StatusResult>("status", {})
      .then((env) => this.post(panel, { kind: "env", env }))
      .catch(() => {/* settings row keeps its built-in defaults */});
    try {
      const rec = await this.backend.request<OpenRecord>("open", { path: uri.fsPath });
      // 1) tree immediately -- cached re-opens land in <5ms server-side.
      this.post(panel, { kind: "tree", record: rec });
      // 2) image next, without blocking anything else on it.
      if (rec.preview_array) {
        const maxSide = vscode.workspace
          .getConfiguration("asdfPreview")
          .get<number>("maxImageSide", 1024);
        this.backend
          .request<ImageResult>("image", {
            path: uri.fsPath,
            array_path: rec.preview_array,
            max_side: maxSide,
          })
          .then((payload) => this.post(panel, { kind: "image", scope: "image", payload }))
          .catch((err) => this.postError(panel, "image", err));
      } else {
        // No 2-D array in this file: say so explicitly rather than silently.
        this.post(panel, { kind: "image", scope: "image", payload: null });
      }
    } catch (err) {
      this.postError(panel, "tree", err);
    }
  }

  private post(panel: vscode.WebviewPanel, msg: Record<string, unknown>): void {
    // postMessage returns a Thenable; wrap so we can swallow disposed panels.
    Promise.resolve(panel.webview.postMessage(msg)).catch(() => undefined);
  }

  private postError(panel: vscode.WebviewPanel, scope: "tree" | "image", err: unknown): void {
    let code: string = ERROR_CODES.E_INTERNAL;
    let message = err instanceof Error ? err.message : String(err);
    let hint: string | undefined;
    if (err instanceof BackendError) {
      code = err.code;
      hint = err.hint;
      if (err.stderrTail && code === ERROR_CODES.E_BACKEND_DIED) {
        message += `\n\nBackend stderr:\n${err.stderrTail.slice(-1500)}`;
      }
    }
    this.post(panel, { kind: "error", scope, code, message, hint });
  }

  // ---------------------------------------------------------------------- html

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cspSource = webview.cspSource;
    // NOTE: asWebviewUri is a class method on the Webview proxy and relies on
    // its receiver -- always call it AS webview.asWebviewUri(...). Detaching it
    // (`const f = webview.asWebviewUri`) makes `this` undefined and throws
    // "Cannot set properties of undefined (setting '#u')" inside the API.
    const extUri = (u: vscode.Uri) => webview.asWebviewUri(u);
    const cssUri = extUri(vscode.Uri.joinPath(this.extRoot, "media", "style.css"));
    const jsUri = extUri(vscode.Uri.joinPath(this.extRoot, "media", "main.js"));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${cspSource} data:;
                 style-src ${cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${cspSource};">
  <link rel="stylesheet" href="${cssUri.toString()}">
  <title>ASDF Preview</title>
</head>
<body>
  <div id="app">
    <header id="titlebar">
      <span id="file-title" class="ellipsis">Loading…</span>
      <span id="chips"></span>
    </header>

    <div id="banner" class="hidden">
      <pre id="banner-text"></pre>
      <div id="banner-actions"></div>
    </div>

    <main id="split">
      <section id="tree-pane" aria-label="Metadata tree">
        <div id="tree-meta" class="pane-subtitle">
          <span>metadata</span><span class="spacer"></span>
          <button id="btn-expand-all" class="mini-btn" title="Expand every metadata node">expand all</button>
          <button id="btn-collapse-all" class="mini-btn" title="Collapse every metadata node">collapse all</button>
        </div>
        <div id="tree"><div class="loading-row"><span class="spinner"></span> opening file…</div></div>
      </section>

      <section id="image-pane" aria-label="Quick-look image">
        <div id="image-toolbar">
          <label for="array-select">array</label>
          <select id="array-select" disabled><option value="">–</option></select>
          <span class="spacer"></span>
          <button id="btn-fit" title="Fit image to pane">fit</button>
          <button id="btn-100" title="1:1 pixels">100%</button>
        </div>
        <div id="image-settings">
          <label for="sel-stretch" title="Stretch algorithm">stretch</label>
          <select id="sel-stretch"><option value="zscale">zscale</option></select>
          <label for="sel-cmap" title="Colormap">cmap</label>
          <select id="sel-cmap"><option value="gray">gray</option></select>
          <label for="in-gamma" title="Gamma on normalized values: &lt;1 lifts shadows, &gt;1 crushes them">γ</label>
          <input id="in-gamma" type="number" min="0.2" max="3" step="0.1" value="1">
          <label for="in-vmin" title="Manual bounds: filling either switches stretch to manual">vmin</label>
          <input id="in-vmin" type="number" placeholder="auto" title="manual vmin">
          <label for="in-vmax" title="Manual bounds">vmax</label>
          <input id="in-vmax" type="number" placeholder="auto" title="manual vmax">
        </div>
        <div id="canvas-wrap">
          <canvas id="canvas"></canvas>
          <div id="image-placeholder"><span class="spinner"></span></div>
        </div>
        <div id="image-status" class="pane-subtitle">&nbsp;</div>
      </section>
    </main>

    <footer id="statusbar">
      <span id="zoom-pct"></span>
      <span id="conn-note"></span>
    </footer>
  </div>
  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export { VIEW_TYPE };
