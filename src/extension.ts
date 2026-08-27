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
  manager = new BackendManager(context.extensionUri.fsPath, context);
  provider = new AsdfEditorProvider(manager, context.extensionUri);

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

  manager.output.appendLine(
    "ASDF Preview activated. The Python backend starts on first .asdf open."
  );
}

export function deactivate(): void {
  manager?.dispose();
  manager = null;
  provider?.dispose();
  provider = null;
}
