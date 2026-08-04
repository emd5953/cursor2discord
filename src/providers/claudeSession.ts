import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.js";
import type { ClaudeLiveState, Store } from "../state.js";
import { debounce } from "../util/throttle.js";
import { belongsTo } from "../util/paths.js";
import { log } from "../log.js";

/**
 * Reads the sidecar files written by the cursor2discord Claude Code plugin.
 *
 * This provider only ever reads. Installing and removing the plugin is done
 * through Claude Code's own commands, so there is no configuration here to
 * write, back up, or repair.
 *
 * Supersedes `terminal.ts` when a sidecar matches the active workspace;
 * `terminal.ts` remains the fallback for anyone without the plugin.
 */

const SIDECAR_VERSION = 1;
const DEBOUNCE_MS = 250;
const SWEEP_MS = 10_000;
/** A `kill -9`'d Claude never runs SessionEnd, so its file is reaped on age. */
const STALE_MS = 60_000;

interface Sidecar {
  readonly version: number;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly sessionTitle: string | null;
  readonly model: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly activity: { tool: string; verb: string; target: string | null; since: number } | null;
  readonly tokens: { input: number; output: number; usedPercentage: number } | null;
}

function sessionsDir(): string {
  return path.join(os.homedir(), ".claude", "cursor2discord", "sessions");
}

export class ClaudeSessionProvider implements vscode.Disposable {
  private readonly dir = sessionsDir();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: fs.FSWatcher | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly refresh = debounce<void>(() => this.scan(), DEBOUNCE_MS);

  constructor(
    private readonly store: Store,
    private config: Config,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scan()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scan()),
    );

    this.start();
  }

  updateConfig(config: Config): void {
    const wasEnabled = this.config.claudeCode.liveActivity;
    this.config = config;

    if (wasEnabled && !config.claudeCode.liveActivity) {
      this.stop();
      this.store.patch({ claudeLive: null });
    } else if (!wasEnabled && config.claudeCode.liveActivity) {
      this.start();
    }
  }

  private start(): void {
    if (!this.config.claudeCode.liveActivity || this.watcher) return;

    try {
      // Created by the plugin on first run; watching a missing directory throws.
      fs.mkdirSync(this.dir, { recursive: true });
      this.watcher = fs.watch(this.dir, () => this.refresh());
      this.watcher.on("error", (error) => {
        log.debug(`sidecar watch failed: ${String(error)}`);
        this.stop();
      });
    } catch (error) {
      log.debug(`could not watch ${this.dir}: ${String(error)}`);
      return;
    }

    this.sweepTimer = setInterval(() => this.scan(), SWEEP_MS);
    this.scan();
  }

  private stop(): void {
    this.refresh.cancel();
    this.watcher?.close();
    this.watcher = undefined;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private scan(): void {
    if (!this.config.claudeCode.liveActivity) return;

    const folder = this.workspacePath();
    const now = Date.now();

    let best: Sidecar | undefined;
    for (const sidecar of this.readAll()) {
      if (now - sidecar.updatedAt > STALE_MS) continue;
      if (folder && !belongsTo(sidecar.cwd, folder)) continue;
      // Most recently updated wins when one workspace has several sessions.
      if (!best || sidecar.updatedAt > best.updatedAt) best = sidecar;
    }

    this.store.patch({ claudeLive: best ? toState(best) : null });
    // A session starting or a tool changing shouldn't wait out the debounce.
    this.store.flush();
  }

  private readAll(): Sidecar[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }

    const out: Sidecar[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as Sidecar;
        // An unknown version means a newer plugin than this extension knows.
        if (parsed?.version !== SIDECAR_VERSION) continue;
        if (typeof parsed.sessionId !== "string") continue;
        out.push(parsed);
      } catch {
        // Half-written or corrupt; the next event will bring a good one.
      }
    }
    return out;
  }

  /** The folder the presence is describing — the active file's, else the first. */
  private workspacePath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const owner = vscode.workspace.getWorkspaceFolder(uri);
      if (owner) return owner.uri.fsPath;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  dispose(): void {
    this.stop();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function toState(sidecar: Sidecar): ClaudeLiveState {
  return {
    sessionId: sidecar.sessionId,
    startedAt: sidecar.startedAt,
    sessionTitle: sidecar.sessionTitle,
    model: sidecar.model,
    activity: sidecar.activity
      ? { tool: sidecar.activity.tool, verb: sidecar.activity.verb, target: sidecar.activity.target }
      : null,
    tokens: sidecar.tokens,
  };
}
