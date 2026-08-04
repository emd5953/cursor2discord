import * as vscode from "vscode";
import type { Config } from "../config.js";
import type { Store } from "../state.js";
import { matchesCommand, nameMatchesCommand } from "../util/cmdline.js";
import { log } from "../log.js";

/**
 * Claude Code sessions in the integrated terminal.
 *
 * `onDidStartTerminalShellExecution` (stable since VS Code 1.93) reports the
 * command line of every terminal command — real instrumentation, not a
 * heuristic. Cursor's API baseline may predate it, so it is feature-detected
 * with a terminal-name fallback.
 *
 * Privacy: the command line is parsed in memory, never stored, never logged
 * above trace, never sent to Discord. Only a count and a timestamp leave here.
 */

const POLL_MS = 5_000;

interface Session {
  readonly startedAt: number;
}

export class TerminalProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sessions = new Map<vscode.Terminal, Session>();
  private pollTimer: NodeJS.Timeout | undefined;
  private usingFallback = false;

  constructor(
    private readonly store: Store,
    private config: Config,
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.sessions.delete(terminal)) this.commit();
        this.syncPolling();
      }),
      vscode.window.onDidOpenTerminal(() => this.syncPolling()),
    );

    const start = vscode.window.onDidStartTerminalShellExecution;
    const end = vscode.window.onDidEndTerminalShellExecution;

    if (typeof start === "function" && typeof end === "function") {
      this.disposables.push(
        start((event) => this.onStart(event)),
        end((event) => this.onEnd(event)),
      );
      log.debug("claude code detection: shell integration");
    } else {
      this.usingFallback = true;
      log.debug("claude code detection: terminal-name fallback (no shell integration API)");
    }

    this.syncPolling();
  }

  updateConfig(config: Config): void {
    const wasEnabled = this.config.detectClaudeCode;
    this.config = config;
    if (wasEnabled && !config.detectClaudeCode) {
      this.sessions.clear();
      this.commit();
    }
    this.syncPolling();
  }

  private onStart(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!this.config.detectClaudeCode) return;

    const execution = event.execution as {
      commandLine?: { value?: string; confidence?: number };
    };
    const line = execution.commandLine?.value;
    if (!line) return;

    // Confidence `Low` (0) means the shell reported a partial line — trusting
    // it produces both misses and false hits, so defer to the name heuristic.
    if (execution.commandLine?.confidence === 0) {
      if (!nameMatchesCommand(event.terminal.name, this.config.claudeCodeCommands)) return;
    } else if (!matchesCommand(line, this.config.claudeCodeCommands)) {
      return;
    }

    log.trace("claude code session started");
    this.sessions.set(event.terminal, { startedAt: Date.now() });
    this.commit();
  }

  private onEnd(event: vscode.TerminalShellExecutionEndEvent): void {
    if (this.sessions.delete(event.terminal)) {
      log.trace("claude code session ended");
      this.commit();
    }
  }

  /** Only poll while a terminal exists, and only without shell integration. */
  private syncPolling(): void {
    const wanted =
      this.usingFallback &&
      this.config.detectClaudeCode &&
      vscode.window.terminals.length > 0;

    if (wanted && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
      this.poll();
    } else if (!wanted && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private poll(): void {
    let changed = false;

    for (const terminal of vscode.window.terminals) {
      const matches = nameMatchesCommand(terminal.name, this.config.claudeCodeCommands);
      const known = this.sessions.has(terminal);
      if (matches && !known) {
        this.sessions.set(terminal, { startedAt: Date.now() });
        changed = true;
      } else if (!matches && known) {
        this.sessions.delete(terminal);
        changed = true;
      }
    }

    // Terminals that vanished between polls.
    for (const terminal of this.sessions.keys()) {
      if (!vscode.window.terminals.includes(terminal)) {
        this.sessions.delete(terminal);
        changed = true;
      }
    }

    if (changed) this.commit();
  }

  private commit(): void {
    const starts = [...this.sessions.values()].map((s) => s.startedAt);
    this.store.patch({
      claudeCode: {
        sessions: starts.length,
        // Earliest start, so a second concurrent session doesn't reset the timer.
        since: starts.length > 0 ? Math.min(...starts) : null,
      },
    });
    // A state this significant shouldn't wait out the debounce.
    this.store.flush();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.sessions.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
