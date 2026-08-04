import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("cursor2discord", { log: true });
  return channel;
}

function get(): vscode.LogOutputChannel {
  return initLog();
}

export const log = {
  trace: (message: string, ...args: unknown[]) => get().trace(message, ...args),
  debug: (message: string, ...args: unknown[]) => get().debug(message, ...args),
  info: (message: string, ...args: unknown[]) => get().info(message, ...args),
  warn: (message: string, ...args: unknown[]) => get().warn(message, ...args),
  error: (message: string, ...args: unknown[]) => get().error(message, ...args),
  show: () => get().show(),
  dispose: () => {
    channel?.dispose();
    channel = undefined;
  },
};
