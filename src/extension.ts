/**
 * Extension entry point.
 *
 * Activation is intentionally LAZY: registering the custom editor does not
 * start any Python process. The backend spawns on the first `.asdf` open and
 * is then reused for the whole session (see BackendManager). Users who never
 * touch an ASDF file pay zero cost.
 */
import * as vscode from "vscode";

import { BackendManager } from "./backend/manager";
import { AsdfEditorProvider, VIEW_TYPE } from "./editor";

let manager: BackendManager | null = null;
let provider: AsdfEditorProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Fail loud but contained: an activation error must surface as a message +
  // log line, never as a bare throw (a thrown activation used to leave the
  // custom editor registered in the manifest but without a provider, which
  // made VSCode's workbench assert when opening .asdf files).
  const output = vscode.window.createOutputChannel("ASDF Preview");
  context.subscriptions.push(output);
  try {
    manager = new BackendManager(context.extensionUri.fsPath, context, output);
    provider = new AsdfEditorProvider(manager, context.extensionUri, output);

    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand("asdfPreview.reload", () => provider?.reloadActive()),
      vscode.commands.registerCommand("asdfPreview.restartBackend", async () => {
        if (!manager) return;
        await manager.restart();
        // Refresh any open ASDF tabs so stale error banners clear and (if the
        // user restarted because of a fixed environment) content re-loads.
        provider?.reloadAll();
      })
    );

    output.appendLine(
      `ASDF Preview v${context.extension?.packageJSON?.version ?? "?"} activated from ${context.extensionUri.fsPath}. The Python backend starts on first .asdf open. NOTE: after installing/updating this extension, reload the VSCode window (Developer: Reload Window) so the in-memory copy matches the files on disk.`
    );
  } catch (err) {
    output.appendLine(`ACTIVATION FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    void vscode.window.showErrorMessage(
      `ASDF Preview failed to activate: ${err instanceof Error ? err.message : String(err)}. See the "ASDF Preview" output channel (View > Output).`
    );
  }
}

export function deactivate(): void {
  manager?.dispose();
  manager = null;
  provider?.dispose();
  provider = null;
}
