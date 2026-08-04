import * as vscode from "vscode";
import { debounce } from "./util/throttle.js";

export interface EditorState {
  readonly fileName: string;
  readonly relPath: string;
  readonly languageId: string;
  readonly line: number;
  readonly column: number;
  readonly lineCount: number;
  readonly problems: number;
  readonly isUntitled: boolean;
}

export interface WorkspaceState {
  readonly name: string;
  readonly folderPath: string;
}

export interface GitState {
  readonly branch: string;
  readonly repoName: string;
  readonly remoteUrl: string | null;
}

/**
 * Detail published by the Claude Code plugin, when it is installed. Kept
 * separate from `claudeCode` rather than merged into it: `terminal.ts` and
 * `claudeSession.ts` write independently, and a shared field would mean
 * whichever patched last wins.
 */
export interface ClaudeLiveState {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly sessionTitle: string | null;
  readonly model: string | null;
  readonly activity: {
    readonly tool: string;
    readonly verb: string;
    readonly target: string | null;
  } | null;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly usedPercentage: number;
  } | null;
}

export interface Snapshot {
  readonly editor: EditorState | null;
  readonly workspace: WorkspaceState | null;
  readonly git: GitState | null;
  readonly claudeCode: { readonly sessions: number; readonly since: number | null };
  /** Null when the plugin is not installed; `terminal.ts` is then the only signal. */
  readonly claudeLive: ClaudeLiveState | null;
  readonly cursorAi: {
    readonly active: boolean;
    readonly since: number | null;
    readonly confidence: number;
  };
  readonly focused: boolean;
  /** When focus was lost, or null while focused. Independent of `lastInputAt`. */
  readonly unfocusedSince: number | null;
  readonly lastInputAt: number;
  readonly sessionStartedAt: number;
  readonly fileOpenedAt: number;
}

function initial(now: number): Snapshot {
  return {
    editor: null,
    workspace: null,
    git: null,
    claudeCode: { sessions: 0, since: null },
    claudeLive: null,
    cursorAi: { active: false, since: null, confidence: 0 },
    focused: vscode.window.state.focused,
    unfocusedSince: vscode.window.state.focused ? null : now,
    lastInputAt: now,
    sessionStartedAt: now,
    fileOpenedAt: now,
  };
}

const DEBOUNCE_MS = 250;

/**
 * Holds the one snapshot every provider writes into. Snapshots are replaced
 * wholesale, never mutated, so the presence pipeline downstream stays pure.
 */
export class Store implements vscode.Disposable {
  private snapshot: Snapshot;
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  private readonly notify = debounce<Snapshot>((s) => this.emitter.fire(s), DEBOUNCE_MS);

  readonly onDidChange = this.emitter.event;

  constructor(now: number = Date.now()) {
    this.snapshot = initial(now);
  }

  get current(): Snapshot {
    return this.snapshot;
  }

  patch(partial: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.notify(this.snapshot);
  }

  /** Emit immediately, skipping the debounce — for transitions that must not lag. */
  flush(): void {
    this.notify.flush();
  }

  dispose(): void {
    this.notify.cancel();
    this.emitter.dispose();
  }
}
