---
description: Enable token counts, context usage, model name and session title in the cursor2discord Discord presence. Use when the user asks to show tokens on their Discord status, or runs /cursor2discord:enable-tokens.
disable-model-invocation: true
---

# Enable the cursor2discord token tier

The cursor2discord plugin's hooks already publish which tool Claude is running and which
file it is touching. Token counts, context usage, the model name and the session title are
**not** available to hooks — they only reach the `statusLine` command. This skill wires the
plugin's bridge into the status line so those fields reach the Discord card too.

## What to do

1. Read the user's current `~/.claude/settings.json`.

2. **If a `statusLine` is already configured**, tell the user what it currently runs and that
   you will preserve it, then continue. Their existing status line output must survive — the
   bridge prints its own line only when there is nothing to chain.

3. Create `~/.claude/cursor2discord-statusline.sh`, `chmod +x` it, containing:

```bash
#!/bin/bash
# Fan the statusLine payload out to the cursor2discord bridge (which records
# tokens for the Discord presence) and to whatever status line was here before.
input=$(cat)

BRIDGE_OUTPUT=$(printf '%s' "$input" | node "$HOME/.claude/cursor2discord/bridge.mjs" statusline 2>/dev/null)

# --- chained command goes here, or nothing ---

printf '%s\n' "$BRIDGE_OUTPUT"
```

If the user had an existing status line command, replace the marker comment with a call to
it that passes the same stdin, and print its output instead of `$BRIDGE_OUTPUT` — or both
lines if they want both.

4. Copy the plugin's bridge to a stable path, because `${CLAUDE_PLUGIN_ROOT}` is not defined
   in a status line context:

```bash
mkdir -p ~/.claude/cursor2discord
cp "${CLAUDE_PLUGIN_ROOT}/bin/bridge.mjs" ~/.claude/cursor2discord/bridge.mjs
```

5. Add the `statusLine` entry to `~/.claude/settings.json`, preserving every other key:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/cursor2discord-statusline.sh"
  }
}
```

6. Tell the user:
   - tokens and context usage appear on the Discord card's second line, with the session
     title — no hover needed; the model name is in the icon hover text
   - it takes effect on the next session
   - to undo it, run `/statusline delete`

## Constraints

- `statusLine` is valid in **user settings only** — never write it to `.claude/settings.json`
  or `.claude/settings.local.json`, where it is silently ignored.
- Never overwrite an existing `statusLine` without saying so first.
- Do not add `refreshInterval` unless the user asks; it re-runs the command on a fixed timer
  forever, and idle token counts do not change.
