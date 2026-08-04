import * as vscode from "vscode";
import * as path from "node:path";
import type { Store } from "../state.js";
import { log } from "../log.js";

/**
 * Branch, repo name and remote via the built-in `vscode.git` extension.
 *
 * Typed structurally rather than against `@types/vscode.git` — the surface used
 * here is four fields, and Cursor's bundled git extension version is not
 * something we control.
 */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly name?: string; readonly commit?: string };
    readonly remotes: ReadonlyArray<{ readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }>;
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitAPI {
  readonly repositories: readonly GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

export class GitProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private readonly heads = new Map<string, string>();
  private api: GitAPI | undefined;

  /**
   * Fires when a repo's HEAD moves. A branch switch rewrites many files at
   * once, which is indistinguishable from an agent by edit shape alone, so the
   * Cursor AI heuristic needs to know it happened.
   */
  private readonly headChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeHead = this.headChanged.event;

  constructor(private readonly store: Store) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    void this.activate();
  }

  private async activate(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>("vscode.git");
    if (!extension) {
      log.debug("vscode.git not present; git fields stay null");
      return;
    }

    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      this.api = exports.getAPI(1);
    } catch (error) {
      log.warn(`could not activate vscode.git: ${String(error)}`);
      return;
    }

    const api = this.api;
    this.disposables.push(
      api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.refresh();
      }),
      api.onDidCloseRepository((repo) => {
        this.repoListeners.get(repo.rootUri.fsPath)?.dispose();
        this.repoListeners.delete(repo.rootUri.fsPath);
        this.refresh();
      }),
    );

    for (const repo of api.repositories) this.watch(repo);
    this.refresh();
  }

  private watch(repo: GitRepository): void {
    const key = repo.rootUri.fsPath;
    if (this.repoListeners.has(key)) return;
    this.repoListeners.set(
      key,
      repo.state.onDidChange(() => {
        const head = repo.state.HEAD?.commit ?? repo.state.HEAD?.name ?? "";
        if (this.heads.get(key) !== head) {
          const known = this.heads.has(key);
          this.heads.set(key, head);
          // Not on first observation — that's startup, not a checkout.
          if (known) this.headChanged.fire();
        }
        this.refresh();
      }),
    );
    this.heads.set(key, repo.state.HEAD?.commit ?? repo.state.HEAD?.name ?? "");
  }

  refresh(): void {
    const repo = this.repoForActiveFile();
    if (!repo) {
      this.store.patch({ git: null });
      return;
    }

    const branch = repo.state.HEAD?.name;
    if (!branch) {
      // Detached HEAD — a commit hash is not a useful thing to broadcast.
      this.store.patch({ git: null });
      return;
    }

    const remote =
      repo.state.remotes.find((r) => r.name === "origin") ?? repo.state.remotes[0];

    this.store.patch({
      git: {
        branch,
        repoName: path.basename(repo.rootUri.fsPath),
        remoteUrl: normaliseRemote(remote?.fetchUrl ?? remote?.pushUrl),
      },
    });
  }

  /**
   * With nested repos or submodules, pick the repo whose root is the longest
   * prefix of the active file — not the first one the API happens to list.
   */
  private repoForActiveFile(): GitRepository | undefined {
    const repos = this.api?.repositories ?? [];
    if (repos.length === 0) return undefined;

    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return repos[0];

    let best: GitRepository | undefined;
    for (const repo of repos) {
      const root = repo.rootUri.fsPath;
      if (!file.startsWith(root)) continue;
      if (!best || root.length > best.rootUri.fsPath.length) best = repo;
    }
    return best ?? repos[0];
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const listener of this.repoListeners.values()) listener.dispose();
    this.repoListeners.clear();
    this.headChanged.dispose();
  }
}

/** `git@github.com:o/r.git` and `https://…/r.git` both become a browsable URL. */
function normaliseRemote(url: string | undefined): string | null {
  if (!url) return null;

  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  const https = /^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?$/.exec(url);
  if (https) return `https://${https[1]}`;

  return null;
}
