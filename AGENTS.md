# max-gateway — install runbook (for an AI assistant)

You are an AI assistant installing **max-gateway** on a user's machine: a reliable
**MAX** (мессенджер от VK) channel for their **Claude Code** session. After this, the
user talks to their Claude from MAX (phone) and gets "typing…", read receipts, voice
transcription, and a control panel.

This is the **bridge** deployment: the user keeps a Claude Code window open; messages
from MAX inject into that open session, replies go back to MAX. A background daemon
(the gateway) owns the MAX connection and is supervised so it restarts on crash/boot.

> Execute the steps for the detected OS. Run commands one at a time, check each result
> before moving on, and STOP and ask the user if anything is unexpected.

How it works (so you can reason about failures):
- **gateway** = an always-on daemon that owns the MAX Bot API connection (robust
  long-poll on `GET /updates` by marker-cursor). It writes inbound to a spool dir and
  sends outbound from it. Prebuilt node bundle: `gateway/dist/gateway.js`.
- **bridge** = a tiny MCP plugin loaded into the Claude Code session via `--channels`.
  No network. It forwards spooled inbound into the session and runs tools via the spool.
  Prebuilt node bundle: `bridge/dist/bridge.js`.
- They talk over files in `STATE` (`inbox/`, `outbox/`). If the session or bridge
  blinks, the daemon keeps buffering — nothing is lost.

---

## 0. Prerequisites (all OS)

1. **Claude Code installed and working** (`claude --version`). If not, set that up first.
2. **Node.js v18+** (`node --version`). Claude Code needs it, so it's almost always there.
   The gateway and bridge are prebuilt node bundles — **no bun, no npm install**.
3. **A MAX bot token**: the user opens the **MAX** app, finds **@MasterBot** (MAX's
   bot-creating bot, the analog of Telegram's BotFather), runs `/newbot`, sets a name +
   username, and gets a token. Have them also restrict who can use the bot if MasterBot
   offers it.
4. Pick paths (defaults; override only if needed):
   - `REPO` = where this repo is cloned (keep it; the daemon runs from here).
   - `STATE` = `~/.claude/channels/max-claude5` (config + message spool live here).

```bash
git clone https://github.com/atomachinskiy/max-gateway "$HOME/max-gateway"   # REPO
```

---

## 1. Pair the bot (capture the owner, write config) — all OS

Run the pairing wizard. It asks the user to open the bot in MAX, captures their
user_id + chat_id, and writes `$STATE/gateway.env` (token + owner + allowlist, chmod 600).

```bash
MAX_BOT_TOKEN="<token-from-masterbot>" \
MAX_STATE_DIR="$HOME/.claude/channels/max-claude5" \
node "$HOME/max-gateway/gateway/dist/gateway.js" pair
```

Tell the user: **open MAX, find your bot, press «Старт» (or send any message).** The
wizard prints `[pair] OK — user_id=… chat_id=…` and the bot replies "✅ Спарено". If it
times out (5 min), re-run. After this, the token lives ONLY in `$STATE/gateway.env`.

---

## 2. Run the daemon under a supervisor (always-on)

The daemon = `node $REPO/gateway/dist/gateway.js` with `MAX_STATE_DIR` set; it reads the
rest from `$STATE/gateway.env`. Set it to start on login and restart on crash.

### macOS — launchd
Write `~/Library/LaunchAgents/com.max-gateway.plist` (replace `REPLACE_HOME` with the
absolute `$HOME`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.max-gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>REPLACE_HOME/max-gateway/gateway/dist/gateway.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>MAX_STATE_DIR</key><string>REPLACE_HOME/.claude/channels/max-claude5</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>REPLACE_HOME/.claude/channels/max-claude5/daemon.log</string>
</dict></plist>
```
```bash
launchctl unload ~/Library/LaunchAgents/com.max-gateway.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/com.max-gateway.plist
```
Verify: `launchctl list | grep max-gateway` shows it; the log has `registered N bot commands`.
If `node` isn't on launchd's PATH, use the absolute node path (`which node`) instead of `/usr/bin/env node`.

### Windows — Scheduled Task
```powershell
$node = (Get-Command node).Source
$gw   = "$HOME\max-gateway\gateway\dist\gateway.js"
$env:MAX_STATE_DIR = "$HOME\.claude\channels\max-claude5"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$gw`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "max-gateway" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force
Start-ScheduledTask -TaskName max-gateway
```
The task must pass `MAX_STATE_DIR`. If env vars don't carry into the task, point it at a
tiny `.cmd` wrapper that does `set MAX_STATE_DIR=... & node "%gw%"`.

### Linux — systemd --user
Use `systemd/max-gateway.service` (it's a `%h` template). For the source-on-bun variant
adjust `ExecStart` as the comment says.
```bash
cp $REPO/systemd/max-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now max-gateway
loginctl enable-linger "$USER"   # so it survives logout / starts at boot
```

---

## 3. Let Claude Code load the bridge plugin

Claude Code gates channel plugins behind an allowlist. Prefer the managed-settings way
(clean, no prompt).

### 3a. Register the local plugin (all OS)
```bash
claude plugin marketplace add "$HOME/max-gateway/bridge"
claude plugin install max@max-local
claude plugin enable  max@max-local
```

### 3b. Allowlist via managed-settings (admin/sudo) — preferred
Write this JSON to the OS managed-settings path (loads with no dev prompt):
```json
{ "channelsEnabled": true,
  "allowedChannelPlugins": [ { "marketplace": "max-local", "plugin": "max" } ] }
```
Paths (need admin/sudo):
- **macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
- **Windows**: `C:\ProgramData\ClaudeCode\managed-settings.json`
- **Linux**: `/etc/claude-code/managed-settings.json`

If you can't get admin, skip 3b and use the dev-flag launcher in 3c.

### 3c. Launcher
Create a command the user runs to start their bridged session (keep the window open):
- If 3b succeeded: `claude --channels plugin:max@max-local`
- If no admin: `claude --dangerously-load-development-channels plugin:max@max-local`
  (Claude Code asks for consent ONCE per project, then remembers).

macOS/Linux — add a `claude-max` alias to the shell rc. Windows — a `claude-max.cmd` on
PATH. Tell the user: **run `claude-max` whenever you want to be reachable from MAX, and
keep that window open.**

---

## 4. Verify end-to-end

1. Daemon up: supervisor shows it running; `$STATE/gateway.status.json` updates; log has
   `authed as bot @…` and `registered N bot commands`.
2. User runs `claude-max` (a Claude Code session with the bridge).
3. From MAX, the user messages the bot → it appears in the Claude Code session, and
   Claude's reply arrives back in MAX. The bot shows "typing…" and marks the message seen.
4. In MAX send `/menu` — a control panel appears (handled by the daemon).

If inbound doesn't reach the session: the allowlist isn't satisfied (revisit 3b/3c) or
the bridge plugin isn't enabled (`claude plugin list`).

---

## 5. Uninstall

- Stop + remove the supervisor entry (launchctl unload / `Unregister-ScheduledTask -TaskName max-gateway` / `systemctl --user disable --now max-gateway`).
- `claude plugin disable max@max-local`; remove the managed-settings file (or its channel key).
- Remove `$STATE` (contains the token) and the repo clone.

---

## Notes for the installing AI

- The gateway and bridge are **prebuilt node bundles** in `gateway/dist/` and
  `bridge/dist/` — no build step on the client. (To rebuild after editing source you'd
  need bun: `bash scripts/build.sh`.)
- All runtime config is `$STATE/gateway.env` (written by `pair`). To add another allowed
  chat later, append its id to `MAX_ALLOWED_CHATS` (comma-separated) and restart the daemon.
- MAX ≠ Telegram: bots have **no emoji reactions** (the bot acknowledges via "typing…"/
  "seen"), and replies default to **plain text** (no Telegram MarkdownV2 escaping). The
  bridge tells the session this automatically.
- The session-control panel (`/restart`, `/model`, `/screen`, terminal-dialog relay)
  needs the daemon to manage the Claude session in **tmux** — that's a server/headless
  setup, not this bridge deployment. Here `/menu`/`/status`/`/ping` still work
  (daemon-handled); `/restart`/`/model`/`/screen` are no-ops without a managed tmux session.
- Base host is `https://botapi.max.ru`. The official client's default `platform-api2.max.ru`
  is unreachable from some data-center IPs — override with `MAX_API_BASE` only if needed.
