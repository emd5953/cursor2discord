# Manual QA

Run before each release. `@vscode/test-electron` is not viable against Cursor's fork, so
this checklist is the integration test.

**Setup:** `npm run typecheck && npm test && npm run package`, then
`cursor --install-extension cursor2discord-<version>.vsix` and reload the window.

Keep the log open the whole time: `Rich Presence: Show Log`. Anything unexplained in the
log is a finding even if the presence looks right.

---

## 1. Connection lifecycle

| # | Step | Expect |
|---|---|---|
| 1.1 | Discord already running, launch Cursor | presence appears within ~15s; status bar `connected` |
| 1.2 | Discord **not** running, launch Cursor | status bar `disconnected`; **no toast, no modal**; log shows backoff retries growing to 60s |
| 1.3 | Launch Discord while Cursor is waiting | connects on the next retry; presence appears |
| 1.4 | Quit Discord mid-session | teardown logged; status bar `disconnected`; retries resume |
| 1.5 | Relaunch Discord | reconnects; presence correct, not stale from before the drop |
| 1.6 | `Rich Presence: Disconnect` then `Reconnect` | presence clears, then returns |
| 1.7 | `Rich Presence: Toggle Enabled` off | presence clears and stays cleared across a reload |

## 2. Rate limiting

| # | Step | Expect |
|---|---|---|
| 2.1 | Type continuously in one file for 60s | log shows ~4 sends, not one per keystroke; presence never goes stale |
| 2.2 | Switch files rapidly (10 files in 5s) | at most one send now + one flush at the 15s boundary; final presence matches the **last** file |
| 2.3 | Sit idle on an unchanged file for 2min | zero sends (dedupe drops identical payloads) |

## 3. Multi-window leadership

| # | Step | Expect |
|---|---|---|
| 3.1 | Open 4 Cursor windows on different folders | exactly one connects; the other three log "not leader" |
| 3.2 | Cycle focus across all 4, pausing ~3s each | presence follows the focused window; **no flicker or blink** on handoff |
| 3.3 | Close the leader window | another window claims leadership within ~15s |
| 3.4 | `kill -9` the leader's Cursor process | a surviving window claims leadership via the dead-pid check, not after a 30s TTL |
| 3.5 | Close the last window | presence clears |

## 4. Claude Code detection

Shell integration on (default macOS/Linux shell).

| # | Step | Expect |
|---|---|---|
| 4.1 | `claude` in the integrated terminal | presence flips to the Claude Code state within ~15s |
| 4.2 | `claude --resume`, `npx claude@latest`, `ANTHROPIC_API_KEY=x claude -p "hi"` | each fires |
| 4.3 | `git commit -m "claude"`, `echo claude`, `vim claude.md` | none fire |
| 4.4 | Exit Claude Code | presence returns to `editing` |
| 4.5 | Kill the terminal mid-run | session cleared; presence returns to `editing` |
| 4.6 | Two concurrent sessions in two terminals; exit one | elapsed timer does **not** reset — it tracks the earlier session |
| 4.7 | Shell integration disabled (`terminal.integrated.shellIntegration.enabled: false`) | name-polling fallback still detects a running `claude`; log says it fell back |
| 4.8 | Grep the log at default level for the command line | never present — only a boolean and a timestamp leave the module |

### 4b. Live activity (companion plugin)

Install with `/plugin marketplace add emd5953/cursor2discord` then
`/plugin install cursor2discord`.

| # | Step | Expect |
|---|---|---|
| 4b.1 | Run a task that edits a file | line 1 becomes `Claude Code — editing <file>`; the file tracks the real edit |
| 4b.2 | Line 2 | shows the session title |
| 4b.3 | `/cursor2discord:enable-tokens`, then a task | line 2 reads `<title> · 72.0K in / 199 out · 7% ctx · up 3h 12m` — no hover needed |
| 4b.3a | Same, without the token tier | line 2 is the bare title, no dangling `·` |
| 4b.3b | Leave Cursor open across a Claude session restart | `up …` keeps climbing; the timer restarts with the new session |
| 4b.3c | Watch the card through a long turn | line 1 holds the last tool between tool calls — it must **never** read a bare `Claude Code` |
| 4b.3d | Let the turn finish and sit at the prompt | line 1 becomes `Claude Code — thinking` |
| 4b.3e | Ask Claude to search the codebase | line 1 reads `searching <dir>` / `looking for files`, never the search pattern |
| 4b.3f | Hover the small Claude badge during a session | `Cursor — <your open file>` |
| 4b.4 | `~/.claude/settings.json` before vs after install | **unchanged** |
| 4b.4a | `grep -r "<a secret from a command you ran>" ~/.claude/cursor2discord/sessions/` | no match |
| 4b.5 | `/plugin uninstall cursor2discord` | falls back to the plain Claude Code state, no errors |
| 4b.6 | `cursor2discord.claudeCode.liveActivity: false` | plain state even with the plugin installed |
| 4b.7 | Reload the window twice | the setup doc appears at most once, not on every reload |

## 5. Cursor AI heuristic

Exit criterion: **≤1 false positive per hour of normal editing.** Log each one.

| # | Step | Expect |
|---|---|---|
| 5.1 | Composer / Chat applies a multi-file edit | `Vibing with Cursor AI` within ~15s, holds ~10s past the last edit |
| 5.2 | Inline edit (Cmd-K) of ≥120 chars | fires |
| 5.3 | Format-on-save of a large file | does **not** fire |
| 5.4 | Paste 500 chars at one cursor | does **not** fire |
| 5.5 | `git checkout` another branch with wide diffs | does **not** fire |
| 5.6 | Rename-symbol across files, organize-imports | does **not** fire |
| 5.7 | Type normally for 30min with no AI use | zero activations |
| 5.8 | `detectCursorAi: false` | never fires; `editing` and `claudeCode` unaffected |

## 6. Privacy

| # | Mode | Expect |
|---|---|---|
| 6.1 | `full` | file name, workspace, branch |
| 6.2 | `hideFileNames` | language only, no file name anywhere including the hover |
| 6.3 | `hideWorkspace` | file name, no workspace or repo |
| 6.4 | `minimal` | just "Working in Cursor" |
| 6.5 | Open `.env`, `id_rsa.pem` | file name never shown, in any mode |
| 6.6 | `privacy.ignoredWorkspaces` matching the open folder | **no connection at all**; status bar `suppressed` with a tooltip saying why |
| 6.7 | Click the status bar item | toggles presence off immediately |

## 7. Workspace edge cases

| # | Step | Expect |
|---|---|---|
| 7.1 | Folder with no git repo | git fields absent; line 2 is `my-project`, **not** `my-project — ` |
| 7.2 | Detached HEAD | same — no dangling separator |
| 7.3 | Nested repos / submodule; open a file inside the submodule | the submodule's branch, not the outer repo's |
| 7.4 | Focus the output panel, a git diff view, a webview, a settings tab | presence keeps the last real file; never shows a garbage name |
| 7.5 | Untitled file | handled, no crash |
| 7.6 | No folder open (bare window) | no crash; workspace fields collapse |
| 7.7 | A file whose name pushes `details` past 128 bytes, with emoji/CJK | clamped on a character boundary, no mojibake |

## 8. Idle

| # | Step | Expect |
|---|---|---|
| 8.1 | Stop typing for 5min, Cursor focused | `Idle` |
| 8.2 | Focus another app for 10min | `Idle` (the 2× unfocused timer) |
| 8.3 | Focus another app for 5min while typing was recent | **not** idle — unfocused alone is not idle |
| 8.4 | Go idle with Claude Code running | **not** idle — the agent state wins |
| 8.5 | `idleBehavior: clearPresence` | presence clears instead of showing Idle |
| 8.6 | `idleTimeoutSeconds: 0` | idle never triggers |

## 9. Remote

| # | Step | Expect |
|---|---|---|
| 9.1 | Open a Remote-SSH window | extension runs on the **local** UI host; presence works |
| 9.2 | Devcontainer | same |

## 10. Assets and buttons

| # | Step | Expect |
|---|---|---|
| 10.1 | Open .ts, .py, .rs, .go, .md | correct language icon each time |
| 10.2 | Open an unknown extension (`.xyzzy`) | generic file icon, never a broken image |
| 10.3 | Configure two buttons with `{repoUrl}` | both render and open the right URL |
| 10.4 | Same, in a folder with no git remote | the `{repoUrl}` button is dropped, not rendered dead |

---

## What can be checked without Cursor

Most of this checklist needs a running Cursor and a running Discord. A useful subset does
not, and it is worth running first — it is fast, and it covers the rows where a regression
would be silent:

| Rows | How |
|---|---|
| 4.2, 4.3 | `npm test` — `util/cmdline` is the command table verbatim |
| 4b.3c, 4b.3d, 4b.3e | pipe hook payloads into `bridge.mjs hook`, read the sidecar |
| 4b.4a | pipe a payload carrying a secret, then grep the sidecar for it |
| 4b.4 | `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json'))).get('statusLine','absent'))"` |
| 7.7 | `npm test` — `presence/format` clamps on byte length |
| 10.1, 10.2 | `curl -sLo /dev/null -w '%{http_code}'` every URL `presence/assets.ts` can emit |

## Sign-off

| Version | Date | Runner | Result | Notes |
|---|---|---|---|---|
| 0.1.1 | 2026-08-27 | Claude Opus 5 | partial | Mechanical subset above only — §1, §2, §3, §5, §6, §8, §9 need a GUI and were not run. Two findings, both filed below. |

### Findings, 0.1.1

- **The token tier runs a frozen copy of `bridge.mjs`.** `enable-tokens` copies the bridge to
  `~/.claude/cursor2discord/bridge.mjs` because `${CLAUDE_PLUGIN_ROOT}` is undefined in a
  status line context. Nothing ever refreshes that copy: on the machine this was run on it
  was still the pre-R2 build from 2026-08-04, three weeks and two milestones behind the
  plugin. Today the damage is contained — statusline mode only calls `fromStatusLine`, which
  has not changed — but the next change to that half, or to `SIDECAR_VERSION`, reaches
  nobody who enabled tokens. Add §4b.8: after updating the plugin, `diff` the copy against
  the plugin's bin.
- **`ASSET_REF` is `"main"`,** while the comment directly above it says the ref is pinned so
  that a bad icon commit cannot change what installed copies render. The comment describes
  the intent; the value does not implement it.
