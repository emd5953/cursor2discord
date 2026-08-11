# Richer presence card

## Problem

The card answers "a Claude Code session is running" and little else. Three concrete
failures, all visible in a single screenshot taken during normal use:

```
Cursor
Claude Code                 ← no activity: between tool calls, which is most of the time
cursor2discord — main       ← the editing fallback, because {sessionTitle} was empty
1:03:22
```

1. **Activity collapses in the gaps.** Hooks fire on `PreToolUse` / `PostToolUse`, so
   `activity` is non-null only *while a tool runs* — seconds at a time. Between tools the
   model is thinking and writing, which is most of the wall clock, and line 1 degrades to
   bare `Claude Code`.
2. **Tokens are invisible.** They render into `largeImageText`, which requires a mouse
   hover. The user wants them on the card.
3. **The activity is coarse.** `editing build.ts` is the ceiling today, and only for the
   seven tools in the hook matcher — `Grep`, `Glob` and `WebSearch` have verbs in
   `VERBS` but never fire, so a search-heavy stretch shows nothing at all.

## Goals

- Tokens and context % visible on the card, no hover required
- Line 1 says what Claude is doing precisely, and keeps saying it during the gaps
- The chat/session title stays on the card
- Claude session duration on the live timer; Cursor uptime still reachable
- Nothing new leaves the machine that isn't already allowed by `privacy.mode`

## Non-goals

- A second live timer. Discord renders exactly one; Cursor uptime is text.
- Sending prompts, command lines, file contents, or search patterns. The existing rule in
  `targetOf` — "never the whole `tool_input`" — is not relaxed. Detail comes from
  *widening which tools report* and from safe fragments, never from raw user content.
- Changing `SIDECAR_VERSION`. Every field below is additive and optional, so a new plugin
  against an old extension degrades instead of going dark.
- Showing Cursor AI activity and Claude activity at once. `select()` still picks one.

## Approach

The card has four slots — two 128-byte lines, one timer, two hover strings — and the ask
names six facts. They fit without contention once the budget is done honestly: line 2 at
`Project status update · 72.0K in / 199 out · 7% ctx` is 50 of 128 bytes, so the chat title
and the tokens are not actually competing.

The gaps are the harder half. Rather than have the extension guess, the *plugin* stops
reporting `activity: null` on `PostToolUse` and instead reports what phase the turn is in.
The gap between two tools is not the same state as a finished turn, and only the hook
knows which one it's in:

| Event | `activity` becomes |
|---|---|
| `PreToolUse` | the tool, verb and target — as today |
| `PostToolUse` | **unchanged**; the last tool holds |
| `Stop` (turn ended) | `{tool: null, verb: "thinking", target: null}` |
| `SessionEnd` | file removed |

*Alternative considered:* hold the last activity in the extension with a decay timer. It
loses, because the extension can't distinguish "tool finished, another is coming" from
"turn is over" without the `Stop` event it would then have to consume anyway — and a decay
timer makes the card lie for the length of the timeout.

## Design

### Sidecar (additive, still `version: 1`)

```ts
interface Activity {
  readonly tool: string | null;        // null while thinking
  readonly verb: string;               // "editing" | "thinking" | …
  readonly target: string | null;
  readonly since: number;
}
```

`ClaudeLiveState.activity` in `state.ts` widens `tool` to `string | null` and gains nothing
else. `durationMs` is already written by the statusline tier and already ignored.

### New template variables (`presence/format.ts`)

| Variable | Value | Null when |
|---|---|---|
| `{tokenSummary}` | `72.0K in / 199 out · 7% ctx` | no tokens, or `showTokens: false` |
| `{contextPercent}` | existing | — |
| `{cursorUptime}` | `3h 12m` | never |
| `{claudeUptime}` | `1h 3m` | no live session |

`compact()` moves from `build.ts` to `format.ts` so both the line and the hover share one
number format. `{claudeActivity}` composition is unchanged apart from tolerating a null
`tool`.

### Changed defaults

```jsonc
"templates.claudeCode.details": "Claude Code — {claudeActivity}",   // unchanged
"templates.claudeCode.state":   "{sessionTitle} · {tokenSummary} · up {cursorUptime}",
```

The `build.ts` fallback — "empty state ⇒ borrow the editing line" — stays, and now only
triggers when a session has neither title nor tokens, i.e. the plugin is installed but the
token tier isn't.

### Both durations, neither hidden

Discord renders one *counting* timer, but a duration is also just text. The timer keeps the
Claude session — it is the number that should tick — and Cursor uptime rides line 2 as
`up 3h 12m`, recomputed on every payload the throttle sends. At the 15s floor that is
accurate to within a rounding step of the minutes it displays.

Nothing the user asked for requires a hover. `largeImageText` keeps the model name and
`smallImageText` becomes `README.md` — the file *you* have open, subject to
`privacy.mode` — as overflow for context that isn't headline.

### Plugin: more tools, better targets (`bin/bridge.mjs`)

`hooks.json` matcher widens to `Edit|Write|Bash|Read|Task|WebFetch|WebSearch|Grep|Glob|NotebookEdit|TodoWrite`.

`targetOf` gains per-tool cases, each yielding a fragment that is structurally incapable of
carrying a secret:

| Tool | Target | Not |
|---|---|---|
| `Edit` `Write` `Read` `NotebookEdit` | basename — as today | the path |
| `Bash` | binary + subcommand when the second token is a bare word: `npm run`, `git commit` | flags, paths, anything with `=`, `/`, quotes |
| `Grep` `Glob` | basename of the search path, else null | **the pattern** — it is user content |
| `Task` | `subagent_type` | the prompt |
| `WebFetch` | URL **host** | the path or query |
| `TodoWrite` | null (verb `updating the plan` carries it) | the todos |

## Behavior

- **Happy path.** Claude runs `Edit build.ts` → line 1 `Claude Code — editing build.ts`,
  line 2 `Project status update · 72.0K in / 199 out · 7% ctx`, timer counting the session.
  Tool returns → line 1 **holds**. Next tool → line 1 updates. Turn ends → `Claude Code —
  thinking`.
- **No token tier.** `{tokenSummary}` is null, the separator collapses, line 2 is the bare
  title. No dangling `·`.
- **No plugin.** `claudeLive` is null, `terminal.ts` still yields the plain state, and every
  new variable resolves null. Identical to today.
- **Old plugin, new extension.** `activity` still goes null on `PostToolUse`; the card
  behaves exactly as it does now. No error path.
- **New plugin, old extension.** A null `tool` is only read for display; the field is
  optional in the consumer. Degrades to the verb.
- **Privacy.** `hideFileNames` nulls `{target}` and the badge-hover file, so line 1 falls to
  the bare verb (`Claude Code — editing`). `minimal` nulls the session title too, leaving
  the token summary — which names nothing — as line 2.
- **Rate limit.** Token counts change on every statusline write, and each distinct payload
  costs a send. The 15s coalescing in `client.ts` already bounds this; the dedupe hash
  stops an unchanged number from queueing a flush. No new machinery, but §2 of the QA
  checklist gains a token-churn row.

## Verification

Unit (`node:test`, no VS Code host):

- `format` — `{tokenSummary}` composition and its null collapse in
  `"{sessionTitle} · {tokenSummary}"`; `{cursorUptime}` / `{claudeUptime}` rounding
- `format` — null `tool` with a non-null verb renders `thinking`
- `build` — golden payloads for: tool running, gap, thinking, no-token-tier, `minimal`
- `bridge` — `targetOf` per tool, with a negative table: `curl -H "Authorization: Bearer x"`
  → `curl`; `grep -r "sk-live-…" .` → the path, never the pattern; `Task` → the
  `subagent_type`, never the prompt

Manual: `docs/QA.md` §4b gains rows for gap-hold, thinking-on-Stop, visible tokens, and a
grep of the sidecar for any string from a prompt or command line.

## Risks / open questions

| Risk | Mitigation |
|---|---|
| `TodoWrite`/`Grep` fire far more often than the 7 current tools, so the sidecar is rewritten more | writes are atomic temp+rename and the extension debounces 250ms; if it shows up as churn, drop `TodoWrite` from the matcher — one line |
| `Bash` subcommand leaks something in an unusual invocation | the bare-word rule rejects anything with `/`, `=`, or quotes; the negative test table is the contract |
| Line 2 at `minimal` is only tokens, which reads oddly | acceptable — `minimal` is a privacy mode, not a pretty mode |

**Assumption made on your behalf:** `Stop` yields the literal verb `thinking`. It is what
the model is doing between turns, and it keeps the line shaped like every other activity.

## Milestones

Each leaves the repo working and installable.

| # | Scope | Exit criterion | Status |
|---|---|---|---|
| **R1** | `{tokenSummary}`, `{cursorUptime}`, `{claudeUptime}`, new `claudeCode.state` default | tokens **and** both durations readable without hovering | **done** (v0.1.1) |
| **R2** | Plugin holds activity through `PostToolUse`, emits `thinking` on `Stop`; extension tolerates a null `tool` | card never collapses to bare `Claude Code` | |
| **R3** | Wider hook matcher + per-tool `targetOf` | `Grep`, `Glob`, `Task`, `WebSearch` reach the card; negative table passes | |
| **R4** | Badge hover carries the user's open file | overflow context reachable without displacing Claude | |

R1 satisfies the whole of "tokens and usage time without hovering". R2 is the one that
changes how the card *feels*, since it removes the state the screenshot caught.
