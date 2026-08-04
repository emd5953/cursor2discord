import type { ActivityKind, Config } from "../config.js";
import type { Snapshot } from "../state.js";

/**
 * First predicate in `priority` order wins. Priority is config rather than
 * hardcoded so "I'd rather see my file than my agent" is a setting, not a fork.
 */
export function select(snapshot: Snapshot, config: Config): ActivityKind {
  const idle = isIdle(snapshot, config);

  for (const kind of config.priority) {
    switch (kind) {
      case "claudeCode":
        if (config.detectClaudeCode && snapshot.claudeCode.sessions > 0) return "claudeCode";
        break;
      case "cursorAi":
        if (config.detectCursorAi && snapshot.cursorAi.active) return "cursorAi";
        break;
      case "editing":
        if (snapshot.editor && !idle) return "editing";
        break;
      case "idle":
        if (idle || !snapshot.editor) return "idle";
        break;
    }
  }

  return "idle";
}

/**
 * Two independent timers. vscord conflates "window unfocused" with "idle", so
 * reading docs in a browser marks you idle — hence the separate, more forgiving
 * unfocused budget. Either timer alone is disabled with 0.
 */
export function isIdle(snapshot: Snapshot, config: Config): boolean {
  // An agent working while you read Twitter is exactly the state worth showing.
  if (config.detectClaudeCode && snapshot.claudeCode.sessions > 0) return false;

  const timeout = config.idleTimeoutSeconds;
  if (timeout <= 0) return false;

  const now = Date.now();
  const noInputFor = (now - snapshot.lastInputAt) / 1000;
  if (noInputFor > timeout) return true;

  if (snapshot.unfocusedSince !== null) {
    const unfocusedFor = (now - snapshot.unfocusedSince) / 1000;
    if (unfocusedFor > timeout * 2) return true;
  }

  return false;
}
