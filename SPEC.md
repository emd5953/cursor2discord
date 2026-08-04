# cursor2discord

Discord Rich Presence for Cursor. Reference implementation:
[LeonardSSH/vscord](https://github.com/LeonardSSH/vscord) — this spec records where we
follow it, where we fix it, and what we add.

**Status:** draft v1 · **Date:** 2026-08-03 · Repo is empty; this is a greenfield project,
so there are no existing conventions to match beyond standard VS Code extension layout.
  
---

## Problem

Cursor users have no rich presence that knows anything about Cursor. vscord works in
Cursor (it's a VS Code fork) but reports it as "VS Code" and is blind to the two things a
Cursor user actually spends their day doing: driving Cursor's AI, and running Claude Code
in the integrated terminal. Meanwhile vscord has three long-standing correctness bugs —
multi-window presence thrash, silently dropped updates from Discord's rate limiter, and
treating "window unfocused" as "idle" — that make it feel unreliable.

## Goals

- Editing presence with vscord-level configurability: template strings, privacy modes,
  custom application ID, per-language icons.
- **Claude Code sessions** in Cursor's integrated terminal as a first-class presence state.
- **Cursor AI activity** (Composer / Chat / inline edit) as a distinct presence state.
- Fix the three vscord correctness bugs above.

## Non-goals (v1)

- A Claude Code daemon, CLI hook, or any out-of-editor integration. Claude Code is
  detected **only** when it runs inside Cursor's terminal. (Decided with the user.)
- JetBrains / Neovim / Zed.
- Any Discord bot, server component, or network call to a non-local host.
- Reading Cursor's internal SQLite state — see Approach.
- Localization, theming of the status bar, per-repo config files.

---

## Approach

A single-process VS Code extension with one-way data flow: **providers → store → pure
presence pipeline → client**. Providers own all `vscode` event subscriptions and only
write to a snapshot store. Everything that turns a snapshot into a Discord payload is a
pure function, which is what makes the interesting behavior testable without a VS Code
host.

*Alternative considered:* vscord's shape, where presence construction is interleaved with
RPC calls. Rejected — it's why vscord's behavior is hard to reason about and why its rate
limiting and multi-window bugs have survived so long.

**Cursor AI detection.** The honest constraint: Cursor exposes no public API for
Composer/Chat/agent state.

| Option | Verdict |
|---|---|
| Read `workspaceStorage/<md5>/state.vscdb` | **Rejected.** Undocumented, breaks on every Cursor update, and parsing the user's chat history to render a status line is an unacceptable privacy trade. |
| `window.tabGroups` webview inspection | Weak — detects the panel being *open*, not the AI *working*. Secondary signal only. |
| Edit-shape heuristic | **Chosen.** AI-authored edits have a distinguishable shape from human typing. It is inference, not instrumentation, and the spec treats it as such. |

**Claude Code detection.** `window.onDidStartTerminalShellExecution` (stable since VS Code
1.93) gives us the command line of every terminal command. This is real instrumentation,
not a heuristic, and it needs no daemon — which is what makes the user's "Cursor extension
only" scope decision workable.

---

## Design

### Data model

```ts
type ActivityKind = "claudeCode" | "cursorAi" | "editing" | "idle";

interface Snapshot {
  readonly editor: {
    fileName: string; relPath: string; languageId: string;
    line: number; column: number; lineCount: number;
    problems: number; isUntitled: boolean;
  } | null;
  readonly workspace: { name: string; folderPath: string } | null;
  readonly git: { branch: string; repoName: string; remoteUrl: string | null } | null;
  readonly claudeCode: { sessions: number; since: number | null };
  readonly cursorAi: { active: boolean; since: number | null; confidence: number };
  readonly focused: boolean;
  readonly lastInputAt: number;
  readonly sessionStartedAt: number;
  readonly fileOpenedAt: number;
}
```

Replaced wholesale on change, never mutated. Providers call `store.patch(partial)`.

### Interfaces

```ts
// client.ts — the only module that touches Discord
interface DiscordClient {
  connect(appId: string): Promise<void>;
  setActivity(activity: Activity | null): Promise<void>;   // throttled + deduped
  destroy(): Promise<void>;
  readonly onStateChange: Event<"connecting" | "connected" | "disconnected">;
}

// presence/ — pure
function select(s: Snapshot, c: Config): ActivityKind;
function format(template: string, s: Snapshot, c: Config): string;
function build(s: Snapshot, c: Config): Activity | null;
function assetFor(languageId: string): { key: string; text: string };

// leader.ts
interface Leadership {
  readonly isLeader: boolean;
  readonly onChange: Event<boolean>;
  release(): void;
}

// util/ — pure
function parseCommand(line: string): { bin: string; argv: string[] } | null;
function matchGlob(path: string, patterns: string[]): boolean;
function throttle<T>(fn: (v: T) => void, ms: number): (v: T) => void;
```

### File layout

| File | Owns | Pure |
|---|---|---|
| `src/extension.ts` | activate/deactivate, wiring, commands, status bar | no |
| `src/config.ts` | typed config read, live reload on `affectsConfiguration` | no |
| `src/state.ts` | snapshot store, 250ms trailing debounce | no |
| `src/log.ts` | `LogOutputChannel` wrapper | no |
| `src/client.ts` | IPC, reconnect backoff, rate-limit coalescer, dedupe | no |
| `src/leader.ts` | cross-window election | no |
| `src/providers/editor.ts` | active editor, file, language, cursor, diagnostics | no |
| `src/providers/workspace.ts` | folder name and path | no |
| `src/providers/git.ts` | branch, repo, remote via `vscode.git` API | no |
| `src/providers/terminal.ts` | Claude Code session tracking | no |
| `src/providers/cursorAi.ts` | AI-edit heuristic | no |
| `src/providers/idle.ts` | focus + input timers | no |
| `src/presence/{select,format,build,assets}.ts` | snapshot → activity | **yes** |
| `src/util/{cmdline,glob,throttle}.ts` | primitives | **yes** |

Already written and consistent with this spec: `package.json`, `tsconfig.json`,
`tsup.config.ts`. The manifest's config schema is authoritative; `config.ts` mirrors it.

### Dependencies

| Dep | Why |
|---|---|
| `@xhayper/discord-rpc` | Discord IPC transport. Wrapped behind `DiscordClient` — the npm history here is a graveyard (the original `discord-rpc` was abandoned; vscord migrated for that reason) and the underlying protocol is ~150 LOC, so if it rots we replace one file. |
| `tsup` | Bundle to a single CJS file. `vscode` external, everything else inlined. |
| `@vscode/vsce` | Packaging. |

No runtime deps beyond the RPC client. Glob matching for files reuses the host's own
matcher via `vscode.languages.match({ pattern }, doc)`; workspace-path globs use a ~30-line
compiler in `util/glob.ts`.

---

## Behavior

### Happy path

1. Cursor starts → `onStartupFinished` → read config, init providers, claim leadership.
2. Leader connects to Discord IPC; non-leaders build snapshots but short-circuit before
   `client`.
3. User opens a file → `editor.ts` patches the store → 250ms debounce → `select` returns
   `editing` → `build` produces the payload → `client.setActivity`.
4. User runs `claude` in the terminal → `terminal.ts` patches `claudeCode.sessions = 1` →
   `select` returns `claudeCode` (higher priority) → presence flips within 250ms.
5. Claude Code exits → session cleared → presence returns to `editing`.

### Activity selection

Config `priority`, default `["claudeCode", "cursorAi", "editing", "idle"]`. First matching
predicate wins: `claudeCode` if `sessions > 0`; `cursorAi` if `active`; `editing` if an
editor exists and not idle; `idle` always. Priority is config rather than hardcoded — ~10
lines, and it pre-empts "I'd rather see my file than my agent."

### Rate limiting — the load-bearing behavior

**Discord silently drops `SET_ACTIVITY` beyond ~1 per 15s.** No error, no rejected promise.
Send faster and updates vanish nondeterministically — this is exactly the "presence is
stale" symptom vscord users report. `setActivity` therefore coalesces:

- ≥15s since last send → send now, stamp the clock.
- Otherwise → hold as pending, flush at `lastSend + 15s`. A newer call replaces the pending
  payload; exactly one timer ever exists.
- **Dedupe:** hash the serialized payload; if equal to the last *sent* one, drop it
  entirely — no send, no timer. Without this, typing in one file queues a flush every
  debounce tick.
- `null` (clear) goes through the same path so it can't race ahead of a pending set.

### Reconnect

Discord not running at startup is the **common** case, not an error. Never a toast, never a
modal — status bar and log only. Backoff `min(60s, 2^n)` with ±20% jitter, retried
indefinitely while enabled, `n` reset on handshake. On mid-session socket error, tear down
fully rather than reusing half-open state — that reuse is the source of most "presence just
stopped" reports.

### Claude Code detection

Parse `execution.commandLine.value` in `util/cmdline.ts`: tokenize, then strip leading env
assignments (`FOO=bar claude`), wrappers (`sudo`, `env`, `nohup`, `time`), and package
runners (`npx`, `bunx`, `pnpm dlx`, `bun x`). Basename the first surviving token, strip
`.exe`/`.cmd`, match case-insensitively against `claudeCodeCommands`.

Must fire on: `claude`, `claude --resume`, `npx claude@latest`,
`ANTHROPIC_API_KEY=x claude -p "…"`. Must **not** fire on: `git commit -m "claude"`,
`echo claude`, `vim claude.md`.

- `commandLine.confidence === Low` means the shell reported a partial line → don't trust
  it, fall back to the name heuristic.
- **No shell integration** → zero events fire. Fall back to polling `window.terminals`
  every 5s *only while a terminal exists*, matching `terminal.name` (Cursor renames
  terminals after the foreground process on macOS/Linux). Explicitly **not** walking the
  process tree via `ps` in v1 — spawning a subprocess on a timer to power a status line is
  a bad trade.
- Lifecycle: `Map<Terminal, {startedAt}>`. Cleared on end-execution, `onDidCloseTerminal`,
  and `deactivate`. `since` is the **minimum** `startedAt`, so a second concurrent session
  doesn't reset the elapsed timer.
- **Privacy:** the command line is parsed in memory and never stored, never logged above
  trace, never sent to Discord. Only a boolean and a timestamp leave the module.

### Cursor AI heuristic

Classify a `TextDocumentChangeEvent` as AI-authored when, within a 600ms window: inserted
length ≥120 chars **or** ≥2 distinct files changed; **and** no `Keyboard`-kind selection
change in the preceding 300ms; **and** not attributable to a known non-AI source.

Must-exclude sources, each a real false positive:

| Source | Suppression |
|---|---|
| format-on-save | 1s after `onWillSaveTextDocument` |
| paste | large single insert landing at exactly one selection |
| `git checkout` / branch switch | 2s after `repo.state.onDidChange` reports a HEAD change |
| rename-symbol, organize-imports | 1s after a multi-file edit with no Cursor chat tab open |

Emits `confidence: 0..1`; the state activates above 0.7 and holds a 10s trailing window so
an edit burst reads as one session rather than flicker.

### Idle

vscord conflates "unfocused" with "idle", so reading docs in a browser marks you idle. Two
independent timers: `noInputFor > idleTimeoutSeconds` **or**
`unfocusedFor > idleTimeoutSeconds * 2`. Either alone can be disabled with `0`.

An active Claude Code session **suppresses idle entirely** — the agent working while you
read Twitter is precisely the state worth broadcasting.

Timers are `setTimeout` to the next transition, not a poll, so steady-state CPU is zero.

### Multi-window leadership

Every Cursor window activates the extension and opens its own IPC connection; Discord
applies whichever sent last, so N windows thrash. No clean in-process fix exists.

Lock file `${os.tmpdir()}/cursor2discord-${uid}.lock` holding `{pid, windowId, focused, ts}`,
written atomically (temp + `rename`), refreshed every 10s by the holder. A window claims
leadership when the lock is absent, stale (>30s), owned by a dead pid
(`process.kill(pid, 0)` throws `ESRCH`), or — the key case — **this window just gained
focus and the leader is not focused.** Focus-follows-leadership.

Only the leader connects. On losing leadership: `destroy()` but do **not** clear presence —
the incoming leader is about to overwrite it, and clearing causes a visible blink. On
`deactivate` as leader: release the lock, clear presence only if no live claimant takes it
within 500ms.

The `kill(pid, 0)` liveness check is load-bearing: a hard-killed Cursor must not lock out
presence until a TTL expires.

### Payload construction

`type: 0` (Playing), `details`/`state`, `timestamps.start`, `assets` (language icon +
Cursor/Claude badge), up to 2 buttons.

Discord truncates `details`/`state` at 128 **bytes** and rejects 1-char strings. `build.ts`
clamps by byte length on a grapheme boundary and pads 1-char results to 2. Empty ⇒ omit the
field rather than send `""`.

Template variables: `{file}` `{ext}` `{language}` `{relPath}` `{workspace}` `{repo}`
`{branch}` `{line}` `{column}` `{lineCount}` `{problems}` `{repoUrl}`. Unresolvable
variables **collapse the surrounding separator** — `"{workspace} — {branch}"` with no git
repo yields `"my-project"`, not `"my-project — "`. Small, but it's the difference between
looking finished and looking broken.

### Assets

Discord's model wants images uploaded to the application (300 max), which forces every user
with a custom `applicationId` through a manual upload slog. Instead, `large_image` accepts
a raw `https://` URL that Discord proxies. Ship icons as pinned jsDelivr URLs into this
repo's `assets/` — zero upload for custom app IDs, and icon updates ship without a Discord
dashboard round-trip. `assets.source: "external" | "uploaded"` as an escape hatch for
locked-down networks. Unknown language ⇒ generic `file` icon, never a broken image.

### Privacy

This extension broadcasts screen contents to a chat server; settings are designed
accordingly.

- `privacy.mode`: `full` | `hideFileNames` | `hideWorkspace` | `minimal`
- `privacy.ignoredWorkspaces`: globs — presence fully suppressed in matching workspaces
- `privacy.ignoredFiles`: globs, defaulting to
  `["**/.env", "**/.env.*", "**/*.pem", "**/*.key"]` — a sane default, not an empty one
- Status bar click → instant toggle. There is always a one-click kill switch.

### Error and edge cases

| Case | Behavior |
|---|---|
| Discord never launched | status bar `disconnected`, silent backoff, no toast |
| Non-`file`/`untitled` URI active (output panel, git diff, webview) | ignored — vscord shows these as garbage file names |
| No git repo / detached HEAD | git fields null, separators collapse |
| Nested repos or submodules | pick the repo whose `rootUri` is the **longest prefix** of the active file, not the first in the list |
| Remote-SSH / devcontainer | `extensionKind: ["ui"]` in the manifest — the IPC socket is on the local machine. Easy to miss; omitting it breaks the extension entirely for remote users. |
| `onDidStartTerminalShellExecution` absent on the target Cursor build | feature-detect at activation, fall back to name polling |
| Workspace matches `ignoredWorkspaces` | no connection at all; status bar shows `suppressed` with a tooltip explaining why — otherwise "why is my presence not showing" is unanswerable |

---

## Verification

**Unit** — `node:test`, no VS Code host. This is the payoff for keeping `presence/` and
`util/` pure.

- `util/cmdline` — the full positive/negative table above
- `util/throttle` — N rapid calls yield exactly 2 sends; dedupe suppresses the timer
- `util/glob` — path patterns
- `presence/format` — substitution, separator collapsing, 128-**byte** clamping with
  multi-byte characters
- `presence/select` — priority ordering; idle suppressed under Claude Code
- `presence/build` — golden snapshots of the full payload per state

**Manual QA** — `docs/QA.md`, run before each release. `@vscode/test-electron` is not
viable against Cursor's fork; a checklist that actually gets run beats a broken harness.

- Cursor launched before / after Discord; Discord killed and relaunched mid-session
- 4 windows, focus cycling — no flicker, presence follows focus
- Claude Code: start/stop, terminal killed mid-run, two concurrent sessions, no shell
  integration
- No git / nested repos / detached HEAD
- Each privacy mode; ignored workspace
- Remote-SSH window

**Commands:** `npm run typecheck`, `npm test`, `npm run package` → install the `.vsix` in
Cursor.

---

## Risks / open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Cursor AI heuristic too noisy | headline feature feels broken | conservative 0.7 threshold, on/off setting, honest README; degrades to `editing` |
| Cursor's API baseline predates 1.93 terminal events | Claude Code detection dead | feature-detect at activation; name-polling fallback; **verify against the target Cursor build before M3** |
| `@xhayper/discord-rpc` unmaintained | can't connect | wrapped behind one interface; ~150 LOC to inline |
| Discord changes the 15s limit or external-asset proxying | stale presence / broken icons | interval is one constant; `assets.source` escape hatch |
| Cursor uses OpenVSX, not the VS Code marketplace | undistributable | publish to both; `.vsix` install documented as the floor |

**Assumptions made on your behalf** (say the word and I'll flip either):

1. **`detectCursorAi` defaults to on**, at a 0.7 threshold. It's the pitch, and off-by-default
   features go undiscovered. Revisit after M4 dogfooding.
2. **Bundled default application ID.** The extension ships a Discord application owned by the
   project, named `Cursor`, so a fresh install shows "Playing Cursor" with zero setup — the
   fix vscord's "Playing Code" needs in order to reach anyone. `applicationId` stays as an
   optional override for users who want their own app; blank means the bundled default.
   The ID lives in `src/constants.ts` as `DEFAULT_APPLICATION_ID`.

**Open:** whether `assets.source` should default to `external` (no upload, but Discord
proxies a third-party URL) or `uploaded` (self-contained, manual). Leaning `external`;
low-stakes and reversible.

---

## Milestones

Each leaves the repo working and installable.

| # | Scope | Exit criterion |
|---|---|---|
| **M1** | Skeleton, config, log, status bar, client + backoff + throttle, editor/workspace/git providers, `editing` + `idle` | vscord core parity, correct under rate limiting |
| **M2** | `leader.ts` | 4 windows, zero flicker, focus-follows |
| **M3** | Claude Code detection + fallback | §Behavior command table passes |
| **M4** | Cursor AI heuristic | ≤1 false positive per hour of normal editing |
| **M5** | Assets, README, `.vsix` + OpenVSX packaging | installable in Cursor |

M1–M3 are the product. M4 is the differentiator and the only piece resting on inference; it
ships behind a setting that can be turned off without degrading anything else.
