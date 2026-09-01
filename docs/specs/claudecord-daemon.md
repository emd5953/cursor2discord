# ClaudeCord — presence outside the editor

**Status:** deferred, not built · **Date:** 2026-08-31

Designed, then declined. Scope settled instead on the behavior 0.1.4 already
ships: presence follows the focused editor window, and a Claude Code session
counts when it runs in that window's terminal. The SPEC.md non-goal "A Claude
Code daemon, CLI hook, or any out-of-editor integration" therefore **stands**.

Kept because the investigation turned up two things worth not rediscovering:

- The plugin's hooks already fire in **any** terminal — iTerm, tmux, SSH, no
  editor at all — and already write sidecars to
  `~/.claude/cursor2discord/sessions/`. Detection was never the blocker.
- The only reason out-of-editor sessions are invisible is that `DiscordClient`
  lives in the extension host. `src/presence/*` and `src/util/*` are already
  `vscode`-free, so the payload pipeline could move to a daemon unchanged,
  golden tests included.

If this is ever revived, the design below is complete and the cost is smaller
than it looks. What follows is the declined proposal, unedited.

---

## Problem

Claude Code is only visible in Discord when it runs inside Cursor's integrated
terminal. A session in iTerm, Ghostty, tmux, or over SSH shows nothing — which
is most of how people actually run it. The blocker is not detection: the
plugin's hooks already fire everywhere. It is that the Discord IPC socket is
owned by `DiscordClient`, which lives in the VS Code extension host and
therefore only exists while an editor window is open.

## Goals

- A Claude Code session shows in Discord from **any** terminal, with no editor
  running at all.
- Editing / Cursor AI presence keeps working exactly as it does today.
- The Claude Code plugin ships unchanged in its hook contract — no re-install,
  no `settings.json` churn for existing users.
- One Discord connection per machine, however many editors and sessions exist.

## Non-goals

- **The npm channel.** A terminal-only user needs the plugin regardless (see
  Approach), so bundling covers them; a standalone `npm i -g` serves only
  someone with no plugin, who by definition has no data to show. Revisit only
  if the plugin requirement ever goes away.
- **VS Code Marketplace.** Open VSX only, as today. Cursor, Windsurf and
  VSCodium install from it; VS Code proper is out of scope for now.
- **JetBrains / Zed / Neovim clients.** The reporter format is documented and
  versioned so one could be written, but none ships here.
- **Non-Claude terminal commands** (`npm`, `pytest`, …) as presence.
- **Renaming the extension ID, config keys, or command IDs.** `displayName` is
  ClaudeCord; everything addressable stays `cursor2discord.*`. Existing installs
  keep updating and existing `settings.json` keeps applying.

---

## Approach

Invert the ownership. A **daemon** owns the Discord socket and is the only
process that ever talks to Discord. Everything else — editor windows, Claude
sessions — is a *reporter* that writes state to a file the daemon watches. The
daemon merges all reports into one snapshot and runs the existing presence
pipeline over it.

Two facts from the current code make this cheap:

1. `src/presence/*` and `src/util/*` are already `vscode`-free, with golden
   payload tests. The whole build/format/select pipeline moves as-is.
2. The plugin already communicates by **sidecar files** in
   `~/.claude/cursor2discord/sessions/`, which `claudeSession.ts` merely
   watches. A daemon watching the same directory gets identical data with zero
   plugin changes.

Editor reports use the same file-watch pattern as sidecars rather than a Unix
domain socket. *Alternative considered:* a socket server in the daemon with the
extension as client. Rejected — it adds a connection lifecycle, a Windows
named-pipe branch, and a reconnect path, to replace a mechanism this repo
already runs in production, including atomic temp-and-rename writes
(`leader.ts`) and pid-liveness reaping (`claudeSession.ts`).

Consequence worth stating: `leader.ts` is deleted. Cross-window election existed
only because every window opened its own socket. With one daemon the problem
does not exist.

---

## Design

### Processes

| Process | Owns | Talks to Discord |
|---|---|---|
| Daemon | socket, merge, presence pipeline | yes, exclusively |
| Extension | editor / cursorAi / idle observation | no |
| Plugin hooks | Claude session sidecars | no |

### File layout on disk

All under `~/.claude/cursor2discord/` — the directory the plugin already uses, so
there is no second root to reason about.

```
sessions/<sessionId>.json   plugin → daemon   (exists today, unchanged)
editors/<windowId>.json     extension → daemon (new)
config.json                 terminal-only user's settings (new, optional)
status.json                 daemon → extension, for the status bar (new)
daemon.lock                 single-instance guard (new)
```

### New and changed modules

- `src/daemon/main.ts` — entrypoint. Acquires the lock, watches `sessions/` and
  `editors/`, merges, drives the client, writes `status.json`, exits when idle.
- `src/daemon/reports.ts` — the directory watcher generalized from
  `claudeSession.ts`: debounce, pid-liveness reaping, periodic sweep.
- `src/presence/merge.ts` — **pure.** `(reports: Report[]) => Snapshot`. The
  arbitration rules live here so they are unit-testable without a daemon.
- `src/reporter.ts` — extension side. Writes its `Snapshot` + resolved `Config`
  to `editors/<windowId>.json`, debounced; unlinks on deactivate.
- `src/client.ts` — drop the `vscode.EventEmitter` / `Disposable` imports for a
  minimal emitter. Logic unchanged, including the rate limiter.
- `src/extension.ts` — providers and store stay; the client, leader election and
  reconnect commands are replaced by reporter writes and daemon spawn.
- `src/leader.ts` — **deleted.**

### Interfaces

```ts
// editors/<windowId>.json — versioned, since a stale extension may outlive an update
interface EditorReport {
  version: 1;
  windowId: string;
  pid: number;
  focused: boolean;
  updatedAt: number;
  host: "cursor" | "vscode" | "other";
  snapshot: Snapshot;   // existing type
  config: Config;       // existing type, already resolved
}

// status.json — daemon → extension status bar
interface DaemonStatus {
  version: 1;
  pid: number;
  connection: ConnectionState;   // existing type
  updatedAt: number;
}
```

### Arbitration (`merge.ts`)

1. **Editor state** comes from the focused report; ties break by `updatedAt`.
   No live editor report → no editor/cursorAi state, and `select()` naturally
   falls through to `claudeCode` or `idle`.
2. **Claude session** is the most recently active sidecar, machine-wide. The
   existing workspace-matching in `claudeSession.ts` is dropped: a session in
   another directory is exactly what this feature exists to show.
3. **Config** is `config.json` as the base, overlaid by the focused editor's
   config when one exists. An editor user never notices the file; a
   terminal-only user gets defaults unless they write one.

### Distribution

`tsup` grows a second entrypoint. The daemon is emitted **twice**: to
`dist/daemon.js` for the `.vsix`, and to `plugins/cursor2discord/bin/daemon.mjs`,
which is committed because the plugin is installed straight from the git repo:
`/plugin marketplace add` clones and runs, with no build step on the far side.

Drift is prevented in CI rather than by convention. `release.yml` gains a step
that rebuilds on the clean runner and fails if the result differs from what is
committed:

```yaml
- name: Daemon bundle is current
  run: |
    npm run build
    git diff --exit-code plugins/cursor2discord/bin/daemon.mjs
```

It runs alongside the existing version-agreement gate, before anything is
published. `tsup` must therefore emit this file deterministically — no
timestamps or absolute paths in the banner — which is a build-config
requirement, not an afterthought.

No new dependency. `@xhayper/discord-rpc` moves from the extension's runtime to
the daemon's; both are bundled by `tsup`.

---

## Behavior

**Happy path, terminal only.** `claude` starts in iTerm → `SessionStart` hook
writes a sidecar and spawns the daemon if `daemon.lock` is absent or stale →
daemon connects to Discord, sees one session, no editor reports → presence shows
the Claude Code card. `SessionEnd` removes the sidecar; with nothing left to
report the daemon clears the presence and exits after the idle grace period.

**Happy path, editor.** Extension activates → spawns the daemon if needed →
writes `editors/<windowId>.json` on every store change → daemon merges and
sends. Identical output to today, one process removed from the socket.

**Both at once.** Two Cursor windows and a bare-terminal session: three reports,
one merge, one payload. The focused window supplies editor state; the most
recently active session supplies Claude state; `select()` and `priority` decide
which wins, unchanged.

**Daemon already running.** Spawn is idempotent — the lock holder is checked for
liveness first, exactly as `leader.ts` does today. Losing the race is not an
error; the loser exits silently.

**Daemon dies.** Reports keep accumulating on disk. The next hook or the
extension's periodic check finds a stale lock and respawns; the merge is
stateless, so presence resumes from whatever is on disk with no recovery step.

**Discord not running.** Unchanged: `handleDrop` → exponential backoff. The
daemon stays alive and reconnects.

**Stale reports.** A hard-killed editor leaves its file behind. The sweep reaps
any report whose pid is dead, and any sidecar past the existing `STALE_MS`
budget. This is `claudeSession.ts`'s current logic, generalized.

**Spawn must never break a session.** The plugin's spawn path inherits
`bridge.mjs`'s hard rule — never throw, never hang, never exit non-zero,
detached and `unref`'d so `PreToolUse` is not held open.

**Privacy.** Unchanged rules, applied in the daemon where they already run
(`build.ts`). `ignoredWorkspaces` suppressing presence entirely now means the
daemon sends nothing for that report rather than the window not connecting —
same observable result. Reports live in the user's home directory, mode 0600.

---

## Verification

- **Unit, pure:** `merge.ts` — focus ties, no-editor case, multi-session
  ordering, config overlay. Golden payload tests in `build.test.ts` keep passing
  untouched; that is the regression proof that extraction changed no behavior.
- **Unit, daemon:** lock acquisition under a simulated race, dead-pid reaping,
  idle exit.
- **`npm test` stays a single `node --test` run** — the daemon modules are
  plain Node, no VS Code host required.
- **Manual matrix:** terminal-only session; one editor; two editors with focus
  switching; editor + terminal simultaneously; Discord restarted mid-session;
  daemon killed mid-session.

## Risks / open questions

- **A committed build artifact** (`plugins/.../daemon.mjs`) is the ugliest part
  of this design, though the CI rebuild-and-diff check turns drift from a silent
  failure into a blocked release. The residual risk is a non-deterministic
  bundle making that check flap. Alternative — having the plugin shell out to
  the extension's copy — fails for the terminal-only user, which is the whole
  point.
- **Idle-exit timing is a guess.** Too short and the daemon thrashes between
  sessions; too long and it lingers. Starting at 5 minutes, tunable.
- **`fs.watch` reliability across platforms** is uneven; the existing 10s sweep
  is the backstop and already ships.
- **Assumption:** hooks fire reliably enough outside an editor to keep a session
  looking alive. If a long thinking pause with no hook makes presence stutter,
  the fix is a heartbeat in the statusline path, not a design change.

## Milestones

1. **Extract the core.** De-`vscode` `client.ts`; move shared types. No
   behavior change, extension still owns the socket. Repo ships as today.
2. **Daemon + reporter.** Daemon owns the socket, extension becomes a reporter,
   `leader.ts` deleted, `merge.ts` and its tests land. Parity for editor users.
3. **Terminal-only support.** Plugin bundles and spawns the daemon; drop the
   workspace-matching restriction on sidecars. *This is the feature.*
4. **Finish.** Host-mark detection on the card, `config.json` for terminal-only
   users, README and SPEC.md updated, CI drift check added.
