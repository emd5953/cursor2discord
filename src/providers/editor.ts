import * as vscode from "vscode";
import * as path from "node:path";
import type { Config } from "../config.js";
import type { EditorState, Store } from "../state.js";

/**
 * Active editor, cursor position, and diagnostics.
 *
 * Only `file` and `untitled` URIs count. vscord renders output panels, git
 * diffs and webviews as garbage file names; ignoring them is the fix.
 */
export class EditorProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastPath: string | undefined;

  constructor(
    private readonly store: Store,
    private config: Config,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.store.patch({ lastInputAt: Date.now() });
        if (event.textEditor === vscode.window.activeTextEditor) this.refresh();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.store.patch({ lastInputAt: Date.now() });
          this.refresh();
        }
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.refresh()),
    );

    this.refresh();
  }

  updateConfig(config: Config): void {
    this.config = config;
    this.refresh();
  }

  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    const next = editor ? this.describe(editor) : null;

    const changedFile = next?.relPath !== this.lastPath;
    this.lastPath = next?.relPath;

    this.store.patch(
      changedFile ? { editor: next, fileOpenedAt: Date.now() } : { editor: next },
    );
  }

  private describe(editor: vscode.TextEditor): EditorState | null {
    const document = editor.document;
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return null;

    const fileName = path.basename(document.fileName);
    const hidden = this.isHidden(document);
    const selection = editor.selection.active;

    return {
      fileName: hidden ? "a file" : fileName,
      relPath: hidden ? "a file" : vscode.workspace.asRelativePath(document.uri, false),
      languageId: document.languageId,
      line: selection.line + 1,
      column: selection.character + 1,
      lineCount: document.lineCount,
      problems: countProblems(document.uri),
      isUntitled: document.isUntitled,
    };
  }

  /** `privacy.ignoredFiles` globs, matched by the host's own matcher. */
  private isHidden(document: vscode.TextDocument): boolean {
    return this.config.privacy.ignoredFiles.some(
      (pattern) => vscode.languages.match({ pattern }, document) > 0,
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function countProblems(uri: vscode.Uri): number {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error ||
      d.severity === vscode.DiagnosticSeverity.Warning).length;
}
