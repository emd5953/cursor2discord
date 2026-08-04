# Claude Code live activity

**Status:** draft v1 · **Date:** 2026-08-04 · Extends `SPEC.md` M3, which shipped.

## Problem

M3 detects that `claude` is running and renders the fixed string "Running Claude Code".
Confirmed on a real card, it reads as dead weight: it tells a viewer a process exists and
nothing else. The presence has no more information than a green dot. Meanwhile the thing
worth broadcasting — what the agent is doing, on what, for how long, at what cost — is
exactly what the extension cannot see, because M3's only input is the terminal command line.

## Goals

- Replace the static string with live session detail: current tool, file under edit,
  session title, elapsed time, token usage.
- Zero added install friction for users who decline; the M3 boolean stays the fallback.
- Never require a second manual install step — the extension configures Claude Code itself,
  with consent.

## Non-goals

- Reading the transcript file. It contains the full conversation; parsing user prompts to
  render a status line is the same privacy trade `SPEC.md` rejected for Cursor's SQLite.
- Cost in USD. It is available (`cost.total_cost_usd`) and deliberately unused — broadcasting
  spend to a chat server invites nothing good.
- Claude Code sessions outside Cursor's terminal. `SPEC.md` line 30 still holds; the sidecar
  is matched to a workspace, so a session in iTerm is ignored.
- Retroactive data. A session already running when the bridge is installed shows M3-level
  detail until it restarts.

## Approach

Two channels, because neither alone is sufficient — this is the load-bearing constraint.

**Hooks** carry `tool_name` and `tool_input`, the only source of "what is it doing right
now". They carry **no token or cost data**; the docs state this explicitly.

**`statusLine`** carries `context_window.*`, `cost.total_duration_ms`, `model.display_name`
and `session_name`. It is the only source of tokens, and it is **user-settings only** —
invalid in project or local settings. So tokens cannot be had without `~/.claude/settings.json`
changing.

Both channels write the same JSON sidecar, keyed by session. The extension watches the
sidecar directory. What differs is who performs each install.

**Ship as a Claude Code plugin, and never write a config file ourselves.**

- The **hook** half lives in the plugin's own `hooks/hooks.json`. Installing a plugin does
  not touch `~/.claude/settings.json` at all, and `/plugin uninstall` removes it cleanly.
- The **statusLine** half is delegated to Claude Code's built-in `/statusline` command, which
  generates the script and updates settings itself, and which documents `/statusline delete`
  as the removal path. The plugin ships a skill that invokes it with the right instructions;
  the user approves the edit through the normal permission flow.

The result: no code in this project ever writes to a file it doesn't own. The two operations
that mutate Claude Code's configuration are performed by Claude Code, under user approval,
through the mechanisms it provides for exactly this.

*Alternative considered:* the extension merges `~/.claude/settings.json` directly, with
backup and restore. Rejected — it is a parse-and-restringify of a user's global config,
which silently drops comments and formatting, and a bad merge breaks the tool they are
using to work. Delegating costs one extra user-visible step and removes the entire class
of failure.

*Alternative considered:* an HTTP hook posting to a localhost server in the extension.
Rejected — it puts a listening socket in every Cursor window, needs port negotiation across
windows, and dies whenever the extension host restarts mid-session. A file is restartable,
inspectable, and survives both processes.

## Design

### Sidecar

`~/.claude/cursor2discord/sessions/<session_id>.json`, rewritten atomically (temp + rename).

```ts
interface SessionSidecar {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;              // join key to a Cursor workspace folder
  readonly sessionTitle: string | null;   // statusLine `session_name`
  readonly model: string | null;          // `model.display_name`
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly activity: {
    readonly tool: string | null;         // `tool_name`
    readonly target: string | null;       // basename of `tool_input.file_path`
    readonly since: number;
  } | null;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly usedPercentage: number;
  } | null;
  readonly durationMs: number | null;     // `cost.total_duration_ms`
}
```

Fields are independently nullable because the two channels fire at different times: hooks
populate `activity`, `statusLine` populates `tokens`/`durationMs`/`sessionTitle`. A write
merges into the existing file rather than replacing it.

### Plugin

A `plugins/cursor2discord/` directory in this repo, installable as
`/plugin marketplace add emd5953/cursor2discord` then `/plugin install cursor2discord`.

```
plugins/cursor2discord/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── bin/bridge.mjs
└── skills/enable-tokens/SKILL.md
```

`bridge.mjs` is Node-only with no dependencies — Claude Code already requires Node.

```
node bridge.mjs hook        # stdin: hook payload  → merge, exit 0, emit nothing
node bridge.mjs statusline  # stdin: statusLine payload → merge, print status line to stdout
```

It must never block Claude Code: every error is swallowed, exit code is always 0, and a
write failure is silent. A presence bar is not worth breaking someone's agent over.

Registered hooks. `PreToolUse` **delays the tool call until the hook returns**, so both the
matcher and the timeout are load-bearing, not hygiene:

| Event | Matcher | Timeout | Writes |
|---|---|---|---|
| `SessionStart` | — | 5s | creates the sidecar, `startedAt` |
| `PreToolUse` | `Edit\|Write\|Bash\|Read\|Task\|WebFetch` | 5s | `activity = { tool, target, since }` |
| `PostToolUse` | same | 5s | `activity = null` (back to thinking) |
| `Stop` | — | 5s | `activity = null` |
| `SessionEnd` | — | 5s | deletes the sidecar |

The matcher exists so grep/glob/todo churn doesn't pay ~40ms of Node startup per call. The
5s timeout replaces the 600s default, which would otherwise let a wedged script hang a
session indefinitely.

### Token opt-in

`skills/enable-tokens/SKILL.md` is a namespaced skill, `/cursor2discord:enable-tokens`. It
instructs Claude to run the built-in `/statusline` flow so that the generated script also
pipes its stdin through `bridge.mjs statusline`, preserving any status line the user already
has. The user sees and approves the settings edit; `/statusline delete` reverses it.

Nothing in this project writes `~/.claude/settings.json`.

### Extension side

| File | Owns |
|---|---|
| `src/providers/claudeSession.ts` | watches the sidecar dir, matches by `cwd`, patches the store |
| `src/bridge/detect.ts` | is the plugin installed? is the statusLine tier active? |
| `src/presence/build.ts` | new template variables |
| `src/state.ts` | `claudeCode` gains the live fields |

The extension only ever *reads*. It detects which tier is active by what appears in the
sidecar — `activity` present means the plugin is installed, `tokens` present means the
statusLine tier is too — and never inspects Claude Code's configuration.

Watching uses `fs.watch` on the directory with a 250ms debounce, plus a 10s sweep that drops
sidecars whose `updatedAt` is older than 60s — a hard-killed `claude` never runs `SessionEnd`.

`claudeSession.ts` supersedes `terminal.ts` when a matching sidecar exists; `terminal.ts`
remains the fallback and the two are reconciled in the store, not in the presence pipeline.

### Config additions

```jsonc
"cursor2discord.claudeCode.liveActivity": true,      // use the sidecar when present
"cursor2discord.claudeCode.showTokens": true,
"cursor2discord.claudeCode.bridgeInstalled": false   // set by the installer, not by hand
```

New template variables, usable in any template: `{tool}` `{target}` `{sessionTitle}`
`{model}` `{tokensIn}` `{tokensOut}` `{contextPercent}`.

### Default card

```
Playing Cursor
Claude Code — editing client.ts        details
add rate limiting to the RPC client    state   (session title; falls back to {workspace} — {branch})
[Opus · 15.5K in / 1.2K out · 8% ctx]  largeImageText, on hover
2h 14m                                 timestamp, from startedAt
```

Tokens live in the hover text because `details`/`state` are 128 bytes and the two visible
lines are better spent on what and why.

### Install flow

On first detection of a Claude Code session with no sidecar, one non-modal notification:

> Show what Claude Code is actually doing? **[Show me how]** **[Not now]** **[Never]**

`Show me how` opens a walkthrough with two copyable commands, not an automated write:

```
/plugin marketplace add emd5953/cursor2discord
/plugin install cursor2discord          → tool, file, duration, model
/cursor2discord:enable-tokens           → adds tokens and session title
```

`Never` sets `liveActivity: false`. Declining leaves M3's boolean intact.

Uninstall is Claude Code's own: `/plugin uninstall cursor2discord` and `/statusline delete`.
There is nothing for this extension to reverse, because there is nothing it wrote.

## Behavior

- **Happy path.** `claude` starts → `SessionStart` writes the sidecar → extension matches
  `cwd` to the workspace folder → presence flips within 250ms. Claude calls Edit →
  `PreToolUse` → "Claude Code — editing client.ts". Tool finishes → `PostToolUse` → falls
  back to the session title. `statusLine` fires on its own cadence and refreshes tokens.
- **Multiple sessions in one workspace.** Sidecars are per-session; the presence shows the
  most recently updated one and `{sessions}` reports the count.
- **Session in a different repo than the focused window.** No match, no presence change —
  the leader window's workspace decides, consistent with M2.
- **`claude` killed with -9.** No `SessionEnd`. The 60s staleness sweep drops it; `terminal.ts`
  will already have cleared the boolean on terminal close.
- **User has an existing `statusLine`.** Chained: ours runs theirs and prints its stdout
  verbatim. If theirs fails, ours prints its own line rather than nothing.
- **Sidecar is corrupt or a future `version`.** Ignored, logged at debug, M3 fallback applies.
- **Privacy.** `{target}` obeys `privacy.ignoredFiles`; `hideFileNames` drops `{tool}`'s
  target; `minimal` suppresses everything but "Claude Code". `{sessionTitle}` is AI-generated
  from the user's prompt and is therefore treated as file-level sensitive: suppressed under
  `hideWorkspace` and `minimal`.

## Verification

- Unit: sidecar merge semantics, staleness sweep, `cwd`→workspace matching, settings.json
  merge preserving foreign keys, statusLine chaining. Extends the existing `npm test`.
- Manual: install bridge → run `claude` in Cursor → ask it to edit a file → card shows the
  tool and file → hover shows tokens → `/exit` → card returns to editing.
- Manual: uninstall command restores `~/.claude/settings.json` byte-identical to a backup
  taken at install.

## Risks / open questions

| Risk | Impact | Mitigation |
|---|---|---|
| `PreToolUse` delays every matched tool call | Claude Code feels laggy, and users won't blame a Discord extension | tool matcher, `timeout: 5`, one small write, no network, no deps, always exit 0 |
| Hook payload schema changes | live detail silently stops | `version` field, defensive reads, M3 boolean always present as fallback |
| Two-step install (plugin, then tokens) loses users at each step | the feature that justifies the extension reaches a subset | plugin tier alone covers 4 of the 5 requested fields; tokens are strictly additive |
| `statusLine` tier still changes `~/.claude/settings.json` | it is a user's global config | the write is performed by Claude Code's own `/statusline`, reviewed by the user, reversed by `/statusline delete` — this project never writes it |
| Marketplace install requires trusting this repo | supply chain | plugin is ~150 lines of dependency-free Node in the same repo as the extension, pinned by commit SHA |
| Two Cursor windows, one repo | duplicate presence | M2 leadership already resolves this upstream |

**Assumptions made on your behalf:**

1. **Cost in USD is never shown**, though `cost.total_cost_usd` is available. Broadcasting
   spend to a chat server invites nothing good. One line to reverse.
2. **Nothing in this project writes a Claude Code config file.** Both mutations are delegated
   to Claude Code's own commands under user approval.
3. **Session title is treated as sensitive** — it is derived from prompt text, so it is
   suppressed under `hideWorkspace` and `minimal`.

**Open:** whether `refreshInterval` should be set on the generated `statusLine`. Without it,
tokens go stale while Claude is idle; with it, the bridge runs every N seconds forever.
Leaning unset, since idle tokens don't change.

## Milestones

| # | Scope | Exit criterion |
|---|---|---|
| **L1** | Sidecar schema + `bridge.mjs`, loaded via `--plugin-dir` | `claude` writes a correct sidecar; no config file touched |
| **L2** | `claudeSession.ts`, store fields, template variables | card shows tool + file live |
| **L3** | `enable-tokens` skill + statusLine path | tokens, model, session title populated; `/statusline delete` reverses it |
| **L4** | Plugin manifest, marketplace entry, walkthrough notification | `/plugin install` works from a clean machine |
