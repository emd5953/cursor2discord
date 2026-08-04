import * as vscode from "vscode";
import type { Store } from "../state.js";

/**
 * The workspace folder containing the active file. With multi-root folders the
 * active file decides, not folder order.
 */
export class WorkspaceProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: Store) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
  }

  refresh(): void {
    const folder = this.activeFolder();
    this.store.patch({
      workspace: folder ? { name: folder.name, folderPath: folder.uri.fsPath } : null,
    });
  }

  activeFolder(): vscode.WorkspaceFolder | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const owner = vscode.workspace.getWorkspaceFolder(uri);
      if (owner) return owner;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
