import * as path from "node:path";

/**
 * Is `cwd` inside `folder`?
 *
 * Claude Code's working directory may be the workspace root or any
 * subdirectory of it. Compared on a path-segment boundary, so `/work/app`
 * does not match a sidecar from `/work/app2`.
 */
export function belongsTo(cwd: string | null | undefined, folder: string): boolean {
  if (!cwd) return false;
  const a = path.resolve(cwd);
  const b = path.resolve(folder);
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
