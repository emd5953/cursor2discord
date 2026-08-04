import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * Cross-window leader election.
 *
 * Every Cursor window activates this extension and would open its own IPC
 * connection; Discord applies whichever wrote last, so N windows thrash. There
 * is no in-process fix — the windows are separate processes — so coordination
 * goes through a lock file. See SPEC.md §Multi-window leadership.
 */

interface Lock {
  readonly pid: number;
  readonly windowId: string;
  readonly focused: boolean;
  readonly ts: number;
}

/** Older than this and the holder is presumed gone (it refreshes every 10s). */
const STALE_MS = 30_000;
const REFRESH_MS = 10_000;
const POLL_MS = 5_000;

function lockPath(): string {
  // uid-scoped: two users on one machine must not fight over one lock.
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cursor2discord-${uid}.lock`);
}

export class Leadership implements vscode.Disposable {
  private readonly file = lockPath();
  private readonly windowId = randomUUID();
  private leader = false;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  private readonly emitter = new vscode.EventEmitter<boolean>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      // Focus-follows-leadership: the window you are looking at is the one
      // whose presence should be showing.
      vscode.window.onDidChangeWindowState(() => this.tick()),
    );
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  get isLeader(): boolean {
    return this.leader;
  }

  private tick(): void {
    if (this.disposed) return;

    const current = this.read();
    const focused = vscode.window.state.focused;

    if (current && current.windowId === this.windowId) {
      // Ours — refresh the timestamp so nobody reaps us.
      if (Date.now() - current.ts >= REFRESH_MS || current.focused !== focused) {
        this.write(focused);
      }
      this.setLeader(true);
      return;
    }

    if (this.canClaim(current, focused)) {
      this.write(focused);
      // Re-read: if two windows raced, the loser sees the winner's id here.
      const after = this.read();
      this.setLeader(after?.windowId === this.windowId);
      return;
    }

    this.setLeader(false);
  }

  private canClaim(current: Lock | undefined, focused: boolean): boolean {
    if (!current) return true;
    if (Date.now() - current.ts > STALE_MS) return true;
    if (!isAlive(current.pid)) return true;
    // The key case: a hard-killed Cursor must not lock out presence for 30s,
    // and the focused window outranks an unfocused holder.
    if (focused && !current.focused) return true;
    return false;
  }

  private read(): Lock | undefined {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Lock>;
      if (typeof parsed.pid !== "number" || typeof parsed.windowId !== "string") return undefined;
      return {
        pid: parsed.pid,
        windowId: parsed.windowId,
        focused: parsed.focused === true,
        ts: typeof parsed.ts === "number" ? parsed.ts : 0,
      };
    } catch {
      return undefined;
    }
  }

  /** Temp file + rename, so a reader never sees a half-written lock. */
  private write(focused: boolean): void {
    const lock: Lock = {
      pid: process.pid,
      windowId: this.windowId,
      focused,
      ts: Date.now(),
    };
    const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(temp, JSON.stringify(lock), "utf8");
      fs.renameSync(temp, this.file);
    } catch (error) {
      log.debug(`could not write leader lock: ${String(error)}`);
      try {
        fs.unlinkSync(temp);
      } catch {
        // Best effort.
      }
    }
  }

  private setLeader(next: boolean): void {
    if (this.leader === next) return;
    this.leader = next;
    log.debug(next ? "became presence leader" : "lost presence leadership");
    this.emitter.fire(next);
  }

  /**
   * Give up the lock. Returns true if another live window claims it promptly,
   * which tells the caller not to clear the presence and cause a blink.
   */
  async release(): Promise<boolean> {
    if (!this.leader) return true;

    try {
      const current = this.read();
      if (current?.windowId === this.windowId) fs.unlinkSync(this.file);
    } catch {
      // Already gone.
    }
    this.setLeader(false);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const successor = this.read();
    return successor !== undefined && isAlive(successor.pid);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }
}

/** `kill(pid, 0)` throws ESRCH for a dead process without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
