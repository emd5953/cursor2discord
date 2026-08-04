import * as vscode from "vscode";
import { Client } from "@xhayper/discord-rpc";
import type { Activity } from "./presence/build.js";
import { log } from "./log.js";

export type ConnectionState = "connecting" | "connected" | "disconnected";

/**
 * Discord silently drops SET_ACTIVITY beyond roughly one per 15 seconds — no
 * error, no rejected promise, the update simply vanishes. Everything below
 * exists to make that invisible. See SPEC.md §Rate limiting.
 */
const RATE_LIMIT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

export class DiscordClient implements vscode.Disposable {
  private client: Client | undefined;
  private state: ConnectionState = "disconnected";
  private applicationId: string | undefined;

  private lastSentAt = 0;
  private lastSentHash: string | undefined;
  private pending: Activity | null | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

  private backoffAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private readonly emitter = new vscode.EventEmitter<ConnectionState>();
  readonly onStateChange = this.emitter.event;

  get connectionState(): ConnectionState {
    return this.state;
  }

  async connect(applicationId: string): Promise<void> {
    if (this.disposed) return;
    this.applicationId = applicationId;
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    if (this.disposed || !this.applicationId) return;
    if (this.state === "connected" || this.state === "connecting") return;

    this.setState("connecting");
    const client = new Client({ clientId: this.applicationId });
    this.client = client;

    client.on("disconnected", () => this.handleDrop("socket closed"));

    try {
      await client.login();
      if (this.disposed) {
        await client.destroy().catch(() => undefined);
        return;
      }
      this.backoffAttempt = 0;
      this.setState("connected");
      log.info(`connected to Discord as application ${this.applicationId}`);

      // A payload built while disconnected is still the truth — send it now.
      if (this.pending !== undefined) {
        const activity = this.pending;
        this.pending = undefined;
        void this.send(activity);
      }
    } catch (error) {
      // Discord not running is the common case, not an error worth a toast.
      this.handleDrop(error instanceof Error ? error.message : String(error));
    }
  }

  /** Throttled, coalesced, deduped. `null` clears the presence. */
  setActivity(activity: Activity | null): void {
    if (this.disposed) return;

    const hash = activity === null ? "null" : JSON.stringify(activity);
    if (hash === this.lastSentHash) {
      // Identical to what Discord already shows. Dropping this outright is what
      // stops every debounce tick while typing from queuing a flush.
      return;
    }

    if (this.state !== "connected") {
      this.pending = activity;
      return;
    }

    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed >= RATE_LIMIT_MS) {
      void this.send(activity);
      return;
    }

    // Hold it. A newer call replaces the pending payload; exactly one timer
    // ever exists, and the clear path shares it so it can't race ahead.
    this.pending = activity;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        if (this.pending === undefined) return;
        const next = this.pending;
        this.pending = undefined;
        void this.send(next);
      }, RATE_LIMIT_MS - elapsed);
    }
  }

  private async send(activity: Activity | null): Promise<void> {
    const client = this.client;
    if (!client || this.state !== "connected") {
      this.pending = activity;
      return;
    }

    const hash = activity === null ? "null" : JSON.stringify(activity);
    this.lastSentAt = Date.now();
    this.lastSentHash = hash;

    try {
      if (activity === null) {
        await client.user?.clearActivity();
        log.debug("presence cleared");
      } else {
        await client.user?.setActivity(activity as never);
        log.debug(`presence set: ${activity.details ?? ""} / ${activity.state ?? ""}`);
      }
    } catch (error) {
      this.lastSentHash = undefined;
      this.handleDrop(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Tear down fully rather than reusing a half-open socket — that reuse is the
   * source of most "presence just stopped working" reports.
   */
  private handleDrop(reason: string): void {
    if (this.disposed) return;

    const wasConnected = this.state === "connected";
    this.teardownSocket();
    this.setState("disconnected");
    this.lastSentHash = undefined;

    if (wasConnected) log.warn(`disconnected from Discord: ${reason}`);
    else log.debug(`connect failed: ${reason}`);

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.applicationId) return;

    const base = Math.min(MAX_BACKOFF_MS, 2 ** this.backoffAttempt * 1000);
    const jitter = base * (Math.random() * 0.4 - 0.2);
    const delay = Math.round(base + jitter);
    this.backoffAttempt++;

    log.debug(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket();
    }, delay);
  }

  private teardownSocket(): void {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    client.removeAllListeners();
    void client.destroy().catch(() => undefined);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitter.fire(next);
  }

  /**
   * Clear the presence and wait for it to land, bypassing the coalescer.
   * Only for shutdown, where there is no later flush to rely on.
   */
  async clearNow(): Promise<void> {
    if (this.state !== "connected") return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = undefined;
    await this.send(null);
  }

  /** Disconnect without disposing — used when this window loses leadership. */
  async disconnect(): Promise<void> {
    this.clearTimers();
    this.teardownSocket();
    this.pending = undefined;
    this.lastSentHash = undefined;
    this.setState("disconnected");
  }

  private clearTimers(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.flushTimer = undefined;
    this.reconnectTimer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.teardownSocket();
    this.emitter.dispose();
  }
}
