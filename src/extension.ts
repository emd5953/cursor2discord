import * as vscode from "vscode";
import { type Config, onConfigChange, readConfig } from "./config.js";
import { DiscordClient, type ConnectionState } from "./client.js";
import { Leadership } from "./leader.js";
import { initLog, log } from "./log.js";
import { build } from "./presence/build.js";
import { ClaudeSessionProvider } from "./providers/claudeSession.js";
import { EditorProvider } from "./providers/editor.js";
import { GitProvider } from "./providers/git.js";
import { IdleProvider } from "./providers/idle.js";
import { TerminalProvider } from "./providers/terminal.js";
import { WorkspaceProvider } from "./providers/workspace.js";
import { Store } from "./state.js";
import { matchGlob } from "./util/glob.js";

let runtime: Runtime | undefined;

const CLAUDE_CODE_SETUP = `# Show what Claude Code is doing

Run these inside Claude Code, in any session.

## 1. Add the marketplace

    /plugin marketplace add EnrinJr/cursor2discord

## 2. Install the plugin

    /plugin install cursor2discord

Your Discord card now shows the tool Claude is running and the file it's touching:

    Claude Code — editing client.ts

This adds hooks inside the plugin. It does not touch your \`~/.claude/settings.json\`.
Remove it any time with \`/plugin uninstall cursor2discord\`.

## 3. Optional — add tokens

    /cursor2discord:enable-tokens

Adds token counts, context usage, the model name and the session title.

This one does change \`~/.claude/settings.json\`, because Claude Code only exposes token
data to a \`statusLine\` command and that setting is user-scoped. Claude Code makes the
edit itself and shows you the diff. Undo it with \`/statusline delete\`.
`;

class Runtime implements vscode.Disposable {
  private config: Config;
  private readonly store = new Store();
  private readonly client = new DiscordClient();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly leadership = new Leadership();
  private readonly disposables: vscode.Disposable[] = [];

  private editor!: EditorProvider;
  private idle!: IdleProvider;
  private terminal!: TerminalProvider;
  private claudeSession!: ClaudeSessionProvider;
  private suppressed = false;
  private offeredPlugin = false;

  constructor() {
    this.config = readConfig();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "cursor2discord.toggle";

    this.editor = new EditorProvider(this.store, this.config);
    this.idle = new IdleProvider(this.store, this.config, () => this.publish());
    this.terminal = new TerminalProvider(this.store, this.config);
    this.claudeSession = new ClaudeSessionProvider(this.store, this.config);

    this.disposables.push(
      this.editor,
      this.idle,
      this.terminal,
      this.claudeSession,
      new WorkspaceProvider(this.store),
      new GitProvider(this.store),
      this.store,
      this.client,
      this.statusBar,
      this.leadership,
      this.store.onDidChange(() => this.publish()),
      this.client.onStateChange((state) => this.renderStatusBar(state)),
      this.leadership.onChange(() => this.onLeadershipChange()),
      onConfigChange((config) => this.reconfigure(config)),
    );

    this.applyEnablement();
    this.renderStatusBar(this.client.connectionState);
  }

  private reconfigure(config: Config): void {
    const wasSuppressed = this.suppressed;
    this.config = config;
    this.editor.updateConfig(config);
    this.idle.updateConfig(config);
    this.terminal.updateConfig(config);
    this.claudeSession.updateConfig(config);
    this.applyEnablement();
    if (!this.suppressed && !wasSuppressed) this.publish();
    this.renderStatusBar(this.client.connectionState);
  }

  /**
   * An ignored workspace gets no connection at all — not a filtered payload.
   * The status bar says so, because "why is my presence not showing" is
   * otherwise unanswerable.
   */
  private applyEnablement(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.suppressed = folders.some((folder) =>
      matchGlob(folder.uri.fsPath, this.config.privacy.ignoredWorkspaces),
    );

    if (!this.config.enabled || this.suppressed || !this.leadership.isLeader) {
      void this.client.disconnect();
      return;
    }

    void this.client.connect(this.config.applicationId);
  }

  /**
   * Losing leadership tears down the socket but deliberately does not clear the
   * presence — the incoming leader is about to overwrite it, and clearing first
   * shows up as a visible blink.
   */
  private onLeadershipChange(): void {
    this.applyEnablement();
    if (this.leadership.isLeader) this.publish();
    this.renderStatusBar(this.client.connectionState);
  }

  /**
   * A Claude Code session with no sidecar means the plugin isn't installed and
   * the card is showing the bare fallback. Offer the upgrade once, then never
   * again — and offer instructions, never an automated write to their config.
   */
  private maybeOfferPlugin(): void {
    if (this.offeredPlugin) return;
    if (!this.config.claudeCode.liveActivity) return;

    const snapshot = this.store.current;
    if (snapshot.claudeCode.sessions === 0 || snapshot.claudeLive !== null) return;

    this.offeredPlugin = true;
    void vscode.window
      .showInformationMessage(
        "Show what Claude Code is actually doing — the tool, the file, tokens?",
        "Show me how",
        "Not now",
        "Never",
      )
      .then((choice) => {
        if (choice === "Show me how") {
          void vscode.commands.executeCommand("cursor2discord.setUpClaudeCode");
        } else if (choice === "Never") {
          void vscode.workspace
            .getConfiguration("cursor2discord")
            .update("claudeCode.liveActivity", false, vscode.ConfigurationTarget.Global);
        }
      });
  }

  private publish(): void {
    this.maybeOfferPlugin();
    if (!this.config.enabled || this.suppressed || !this.leadership.isLeader) return;
    const activity = build(this.store.current, this.config);
    this.client.setActivity(activity);
    this.renderStatusBar(this.client.connectionState);
  }

  private renderStatusBar(state: ConnectionState): void {
    if (!this.config.statusBar.enabled) {
      this.statusBar.hide();
      return;
    }

    if (this.suppressed) {
      this.statusBar.text = "$(circle-slash) Discord";
      this.statusBar.tooltip =
        "Presence suppressed: this workspace matches cursor2discord.privacy.ignoredWorkspaces.";
    } else if (!this.config.enabled) {
      this.statusBar.text = "$(circle-slash) Discord";
      this.statusBar.tooltip = "Rich Presence disabled. Click to enable.";
    } else if (!this.leadership.isLeader) {
      this.statusBar.text = "$(eye) Discord";
      this.statusBar.tooltip =
        "Another Cursor window is driving the presence. Focus this one to take over.";
    } else {
      const label: Record<ConnectionState, string> = {
        connected: "$(check) Discord",
        connecting: "$(sync~spin) Discord",
        disconnected: "$(debug-disconnect) Discord",
      };
      this.statusBar.text = label[state];
      this.statusBar.tooltip =
        state === "connected"
          ? "Connected to Discord. Click to disable."
          : "Waiting for Discord. Click to disable.";
    }

    this.statusBar.show();
  }

  async reconnect(): Promise<void> {
    await this.client.disconnect();
    this.applyEnablement();
    this.publish();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.renderStatusBar("disconnected");
  }

  /**
   * Hand off cleanly on window close: drop the lock, and only clear the
   * presence if no other live window picks it up — otherwise the successor's
   * payload is about to arrive and clearing would blink.
   */
  async shutdown(): Promise<void> {
    const wasLeader = this.leadership.isLeader;
    const succeeded = wasLeader ? await this.leadership.release() : true;
    if (wasLeader && !succeeded) await this.client.clearNow();
    this.dispose();
  }

  private disposed = false;

  dispose(): void {
    // Reached twice: once from shutdown(), once from context.subscriptions.
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log.info("cursor2discord activating");

  runtime = new Runtime();
  context.subscriptions.push(runtime);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursor2discord.reconnect", () => runtime?.reconnect()),
    vscode.commands.registerCommand("cursor2discord.disconnect", () => runtime?.disconnect()),
    vscode.commands.registerCommand("cursor2discord.showLog", () => log.show()),
    vscode.commands.registerCommand("cursor2discord.setUpClaudeCode", async () => {
      // Instructions, not automation. Both steps mutate Claude Code's own
      // configuration, so Claude Code performs them, with the user approving.
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: CLAUDE_CODE_SETUP,
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand("cursor2discord.toggle", async () => {
      const settings = vscode.workspace.getConfiguration("cursor2discord");
      const next = !settings.get<boolean>("enabled", true);
      await settings.update("enabled", next, vscode.ConfigurationTarget.Global);
    }),
  );
}

export async function deactivate(): Promise<void> {
  await runtime?.shutdown();
  runtime = undefined;
  log.dispose();
}
