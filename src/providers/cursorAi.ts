import * as vscode from "vscode";
import type { Config } from "../config.js";
import type { Store } from "../state.js";
import { classify, isActive, THRESHOLDS } from "../util/aiHeuristic.js";
import { log } from "../log.js";

/**
 * Cursor AI activity, inferred from edit shape.
 *
 * Cursor exposes no public API for Composer/Chat/agent state, and the
 * alternatives were worse: reading `state.vscdb` means parsing the user's chat
 * history to render a status line, and webview inspection detects the panel
 * being open rather than the AI working. See SPEC.md §Approach.
 *
 * Changes are accumulated over a short window and classified once, so one
 * agent edit burst reads as a single session instead of flickering per change.
 */

const WINDOW_MS = 600;
/** Hold the state after the last qualifying burst, so a pause isn't an exit. */
const TRAILING_MS = 10_000;

export class CursorAiProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  private lastKeyboardAt: number | null = null;
  private lastWillSaveAt: number | null = null;
  private lastHeadChangeAt: number | null = null;

  private insertedLength = 0;
  private changeCount = 0;
  private readonly files = new Set<string>();
  private singleSelectionInsert = true;

  private windowTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private config: Config,
    onHeadChange: vscode.Event<void>,
  ) {
    this.disposables.push(
      onHeadChange(() => {
        this.lastHeadChangeAt = Date.now();
      }),
      vscode.workspace.onWillSaveTextDocument(() => {
        this.lastWillSaveAt = Date.now();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
          this.lastKeyboardAt = Date.now();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.observe(event)),
    );
  }

  updateConfig(config: Config): void {
    const wasEnabled = this.config.detectCursorAi;
    this.config = config;
    if (wasEnabled && !config.detectCursorAi) this.clear();
  }

  private observe(event: vscode.TextDocumentChangeEvent): void {
    if (!this.config.detectCursorAi) return;
    if (event.document.uri.scheme !== "file" && event.document.uri.scheme !== "untitled") return;
    if (event.contentChanges.length === 0) return;

    for (const change of event.contentChanges) {
      this.insertedLength += change.text.length;
      this.changeCount++;
    }
    this.files.add(event.document.uri.toString());

    // Paste shape: one change, landing where the one cursor already was.
    const editor = vscode.window.activeTextEditor;
    const oneSelection = editor?.selections.length === 1;
    if (!(event.contentChanges.length === 1 && oneSelection)) {
      this.singleSelectionInsert = false;
    }

    if (!this.windowTimer) {
      this.windowTimer = setTimeout(() => this.evaluate(), WINDOW_MS);
    }
  }

  private evaluate(): void {
    this.windowTimer = undefined;
    const now = Date.now();

    const confidence = classify({
      insertedLength: this.insertedLength,
      fileCount: this.files.size,
      changeCount: this.changeCount,
      msSinceKeyboard: elapsed(this.lastKeyboardAt, now),
      msSinceWillSave: elapsed(this.lastWillSaveAt, now),
      msSinceHeadChange: elapsed(this.lastHeadChangeAt, now),
      chatTabOpen: chatTabOpen(),
      singleInsertAtOneSelection: this.singleSelectionInsert && this.changeCount === 1,
    });

    this.resetWindow();

    if (!isActive(confidence)) return;

    const current = this.store.current.cursorAi;
    log.trace(`cursor ai burst classified at ${confidence.toFixed(2)}`);

    this.store.patch({
      cursorAi: {
        active: true,
        // Keep the original start so a burst reads as one session.
        since: current.active && current.since ? current.since : now,
        confidence,
      },
    });
    this.store.flush();

    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.clear(), TRAILING_MS);
  }

  private resetWindow(): void {
    this.insertedLength = 0;
    this.changeCount = 0;
    this.files.clear();
    this.singleSelectionInsert = true;
  }

  private clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.store.current.cursorAi.active) return;
    this.store.patch({ cursorAi: { active: false, since: null, confidence: 0 } });
    this.store.flush();
  }

  dispose(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function elapsed(at: number | null, now: number): number | null {
  return at === null ? null : now - at;
}

/**
 * A secondary signal only: it detects the panel being open, not the AI
 * working, which is why it merely gates the multi-file refactor suppression.
 */
function chatTabOpen(): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const label = tab.label.toLowerCase();
      if (label.includes("chat") || label.includes("composer")) return true;
    }
  }
  return false;
}

export { THRESHOLDS };
