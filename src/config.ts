import * as vscode from "vscode";
import { DEFAULT_APPLICATION_ID } from "./constants.js";

export type ActivityKind = "claudeCode" | "cursorAi" | "editing" | "idle";
export type PrivacyMode = "full" | "hideFileNames" | "hideWorkspace" | "minimal";
export type IdleBehavior = "showIdle" | "clearPresence" | "ignore";

export interface ButtonConfig {
  readonly label: string;
  readonly url: string;
}

export interface TemplatePair {
  readonly details: string;
  readonly state: string;
}

export interface Config {
  readonly enabled: boolean;
  readonly applicationId: string;
  readonly showElapsedTime: boolean;
  readonly elapsedTimeResetsOnFileChange: boolean;
  readonly idleTimeoutSeconds: number;
  readonly idleBehavior: IdleBehavior;
  readonly detectClaudeCode: boolean;
  readonly claudeCodeCommands: readonly string[];
  readonly detectCursorAi: boolean;
  readonly priority: readonly ActivityKind[];
  readonly privacy: {
    readonly mode: PrivacyMode;
    readonly ignoredWorkspaces: readonly string[];
    readonly ignoredFiles: readonly string[];
  };
  readonly templates: Readonly<Record<ActivityKind, TemplatePair>>;
  readonly buttons: readonly ButtonConfig[];
  readonly statusBar: { readonly enabled: boolean };
}

const SECTION = "cursor2discord";

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration(SECTION);

  // A blank applicationId means "use the app this project ships".
  const applicationId = c.get<string>("applicationId", "").trim() || DEFAULT_APPLICATION_ID;

  return {
    enabled: c.get<boolean>("enabled", true),
    applicationId,
    showElapsedTime: c.get<boolean>("showElapsedTime", true),
    elapsedTimeResetsOnFileChange: c.get<boolean>("elapsedTimeResetsOnFileChange", false),
    idleTimeoutSeconds: Math.max(0, c.get<number>("idleTimeoutSeconds", 300)),
    idleBehavior: c.get<IdleBehavior>("idleBehavior", "showIdle"),
    detectClaudeCode: c.get<boolean>("detectClaudeCode", true),
    claudeCodeCommands: c.get<string[]>("claudeCodeCommands", ["claude", "claude-code"]),
    detectCursorAi: c.get<boolean>("detectCursorAi", true),
    priority: c.get<ActivityKind[]>("priority", ["claudeCode", "cursorAi", "editing", "idle"]),
    privacy: {
      mode: c.get<PrivacyMode>("privacy.mode", "full"),
      ignoredWorkspaces: c.get<string[]>("privacy.ignoredWorkspaces", []),
      ignoredFiles: c.get<string[]>("privacy.ignoredFiles", [
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.key",
      ]),
    },
    templates: {
      editing: {
        details: c.get<string>("templates.editing.details", "Editing {file}"),
        state: c.get<string>("templates.editing.state", "{workspace} — {branch}"),
      },
      idle: {
        details: c.get<string>("templates.idle.details", "Idle"),
        state: c.get<string>("templates.idle.state", "in {workspace}"),
      },
      claudeCode: {
        details: c.get<string>("templates.claudeCode.details", "Running Claude Code"),
        state: c.get<string>("templates.claudeCode.state", "{workspace} — {branch}"),
      },
      cursorAi: {
        details: c.get<string>("templates.cursorAi.details", "Vibing with Cursor AI"),
        state: c.get<string>("templates.cursorAi.state", "{workspace} — {branch}"),
      },
    },
    buttons: (c.get<ButtonConfig[]>("buttons", []) ?? []).slice(0, 2),
    statusBar: { enabled: c.get<boolean>("statusBar.enabled", true) },
  };
}

/** Fires on any change under the `cursor2discord.` section. */
export function onConfigChange(listener: (config: Config) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener(readConfig());
  });
}
