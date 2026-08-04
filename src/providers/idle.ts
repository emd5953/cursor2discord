import * as vscode from "vscode";
import type { Config } from "../config.js";
import type { Store } from "../state.js";

/**
 * Focus tracking plus a timer that fires at the next idle transition.
 *
 * `setTimeout` to the transition rather than a poll, so steady-state CPU is
 * zero. Input timestamps themselves are written by `EditorProvider`.
 */
export class IdleProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private config: Config,
    private readonly onTransition: () => void,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.store.patch({
          focused: state.focused,
          unfocusedSince: state.focused ? null : Date.now(),
          ...(state.focused ? { lastInputAt: Date.now() } : {}),
        });
        this.schedule();
      }),
      this.store.onDidChange(() => this.schedule()),
    );

    this.schedule();
  }

  updateConfig(config: Config): void {
    this.config = config;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const timeout = this.config.idleTimeoutSeconds;
    if (timeout <= 0) return;

    const snapshot = this.store.current;
    const now = Date.now();

    const candidates: number[] = [snapshot.lastInputAt + timeout * 1000];
    if (snapshot.unfocusedSince !== null) {
      candidates.push(snapshot.unfocusedSince + timeout * 2000);
    }

    const next = Math.min(...candidates);
    const delay = next - now;
    if (delay <= 0) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTransition();
    }, delay);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
