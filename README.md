# Switchboard

A multi-agent communication relay for Claude Code instances. Enables multiple Claude Code sessions to message each other, coordinate work, and share access to named resources.

## Architecture

Three components work together:

| Component | File | Role |
|-----------|------|------|
| Relay MCP server | `relay-mcp.js` | Provides tools: send/read messages, broadcast, locks, history |
| Stop hook | `relay-hook.js` | Injects pending messages at turn boundaries (fallback delivery) |
| Channel server | `switchboard-channel.js` | Pushes notifications to idle sessions in real time |

**Data directory:** `~/.switchboard/` (Linux/macOS) or `%USERPROFILE%\.switchboard\` (Windows)

The data directory is configurable via the `SWITCHBOARD_DATA_DIR` environment variable. Set this on both the relay MCP server and the channel server when the default path is not suitable — for example, when bridging the Windows/WSL filesystem boundary. See the WSL + Windows section under Setup for details.

The stop hook fires when a session ends a turn. If a session is completely idle, no turns end and messages pile up undelivered. The channel server solves this: it watches `messages.json` and pushes a notification into the idle session the moment a message arrives, waking it up without operator intervention.

## Project Structure

```
switchboard/
  src/
    relay-mcp.js             — relay MCP server
    relay-hook.js            — stop hook
    switchboard-channel.js   — channel server
  test/
    channel-helpers.js       — test helpers
    channel-unit.test.js     — unit tests
    channel-integration.test.js — integration tests
  install.sh                 — installer for Linux/macOS
  install.ps1                — installer for Windows
  package.json
```

## Deployment

The installer copies source files from the repo into your Claude config directory, installs npm dependencies, and registers both MCP servers.

**Install directory:** `~/.claude/switchboard/` (Linux/macOS) or `%USERPROFILE%\.claude\switchboard\` (Windows)

The repo and install directory are separate. Source files live in `src/` in the repo; after installation they are flat in the install directory (e.g., `~/.claude/switchboard/relay-mcp.js`). To update, re-run the installer.

## Setup

**Prerequisites:** Node.js 18+, Claude Code v2.1.80+

### Installation

**Linux/macOS:**
```bash
bash install.sh
```

**Windows (PowerShell):**
```powershell
.\install.ps1
```

The installer:
1. Creates `~/.claude/switchboard/` and `~/.switchboard/`
2. Copies all source and test files
3. Runs `npm install --production` in the install directory
4. Registers both MCP servers at user scope via `claude mcp add`

### Manual Setup (without installer)

If you prefer to set up manually:

**1. Copy files to the install directory:**

**Linux/macOS:**
```bash
mkdir -p ~/.claude/switchboard ~/.switchboard
cp src/*.js ~/.claude/switchboard/
cp package.json ~/.claude/switchboard/
mkdir -p ~/.claude/switchboard/test
cp test/*.js ~/.claude/switchboard/test/
cd ~/.claude/switchboard && npm install --production
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude\switchboard" -Force | Out-Null
New-Item -ItemType Directory -Path "$env:USERPROFILE\.switchboard" -Force | Out-Null
Copy-Item "src\*.js" -Destination "$env:USERPROFILE\.claude\switchboard\" -Force
Copy-Item "package.json" -Destination "$env:USERPROFILE\.claude\switchboard\" -Force
New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude\switchboard\test" -Force | Out-Null
Copy-Item "test\*.js" -Destination "$env:USERPROFILE\.claude\switchboard\test\" -Force
Push-Location "$env:USERPROFILE\.claude\switchboard"; npm install --production; Pop-Location
```

**2. Register the relay MCP server (user-level, available in all projects):**

**Linux/macOS:**
```bash
claude mcp add switchboard node ~/.claude/switchboard/relay-mcp.js -s user
```

**Windows (PowerShell):**
```powershell
claude mcp add switchboard node "$env:USERPROFILE\.claude\switchboard\relay-mcp.js" -s user
```

**3. Register the channel server:**

**Linux/macOS:**
```bash
claude mcp add switchboard-channel node ~/.claude/switchboard/switchboard-channel.js -s user
```

**Windows (PowerShell):**
```powershell
claude mcp add switchboard-channel node "$env:USERPROFILE\.claude\switchboard\switchboard-channel.js" -s user
```

**4. Configure the stop hook** in `~/.claude/settings.json` (Linux/macOS) or `%USERPROFILE%\.claude\settings.json` (Windows):

**Linux/macOS:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/switchboard/relay-hook.js"
          }
        ]
      }
    ]
  }
}
```

**Windows:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node %USERPROFILE%\\.claude\\switchboard\\relay-hook.js"
          }
        ]
      }
    ]
  }
}
```

**5. Verify registration:**

**Linux/macOS:**
```bash
claude mcp list
# should show both: switchboard, switchboard-channel
```

**Windows (PowerShell):**
```powershell
claude mcp list
# should show both: switchboard, switchboard-channel
```

### WSL + Windows

Claude Desktop runs on Windows. If your Claude Code sessions run in WSL, two processes must share the same `messages.json` across different filesystems. The default `~/.switchboard` path resolves differently in each environment and must be configured explicitly on both sides.

**Step 1 — Configure the relay MCP server in Claude Desktop (Windows side).**

When registering the MCP server, set `SWITCHBOARD_DATA_DIR` to the WSL Linux home path using Windows UNC notation:

```
\\wsl$\<distro>\home\<user>\.switchboard
```

Replace `<distro>` with your WSL distribution name (e.g., `Ubuntu`) and `<user>` with your Linux username. This tells the relay server to write `messages.json` directly into the WSL filesystem.

**Step 2 — Set `SWITCHBOARD_DATA_DIR` in WSL sessions.**

In any WSL Claude Code session that uses the Switchboard, set the environment variable before launching:

```bash
export SWITCHBOARD_DATA_DIR=/home/<user>/.switchboard
export RELAY_AGENT_ID=<agent-name>
claude
```

Or add `SWITCHBOARD_DATA_DIR` to your `.bashrc` / `.zshrc` so it is always set.

**Warning: do NOT use `/mnt/c/` paths for `SWITCHBOARD_DATA_DIR` in WSL.**

The relay uses polling for cross-filesystem portability, but `/mnt/c/` paths use DrvFs which does not reliably surface file modification events and can cause the relay to read stale data. The `\\wsl$\` + `/home/<user>/` path pair routes all I/O through the native Linux ext4 filesystem, which is reliable.

## Agent Naming

Agent names are set via the `RELAY_AGENT_ID` environment variable. This is the most important configuration decision when running multi-agent sessions.

**Names are freeform.** "alpha" and "beta" appear in examples but are not special. Use names that reflect the role:

```
researcher       frontend         code-reviewer
market-data      db-migrator      test-runner
```

**Names must be unique across active sessions.** The session registry (`~/.switchboard/sessions.json`) enforces this. If you start a session with a name already claimed by a running process, you will get a clear error with the conflicting PID and working directory:

```
Error: "researcher" is already claimed by PID 12345 (started 2026-04-10T... in /home/user/projects/ml). 
Pick a different name or stop the other session.
```

**Name lifecycle:**
- When a session ends cleanly (SIGTERM/SIGINT), its name is released automatically
- If a session crashes, the stale claim is detected and overwritten on the next startup with the same name
- Agent names are not tied to repos or projects — if you reuse "researcher" in a different context, any leftover messages from the old context are automatically flushed to `history.jsonl` before the new session starts. The inbox begins fresh.

## Starting Agents

**Relay only** (stop hook delivers messages at turn boundaries):

**Linux/macOS:**
```bash
export RELAY_AGENT_ID=researcher
claude
```

**Windows (PowerShell):**
```powershell
$env:RELAY_AGENT_ID = "researcher"
claude
```

**With channel** (push notifications to idle sessions):

**Linux/macOS:**
```bash
export RELAY_AGENT_ID=researcher
claude --dangerously-load-development-channels server:switchboard-channel
```

**Windows (PowerShell):**
```powershell
$env:RELAY_AGENT_ID = "researcher"
claude --dangerously-load-development-channels server:switchboard-channel
```

The `--dangerously-load-development-channels` flag is required during the Claude Code Channels research preview. This is expected behavior and is safe for internal use.

`server:switchboard-channel` refers to the name of the registered MCP server entry. The server must be registered (see Setup above) before using this flag.

### Shell Helper: `relay`

For convenience, add a `relay` helper to your shell profile so you can launch agents with a single command.

**Linux/macOS** (add to `~/.bashrc` or `~/.zshrc`):
```bash
relay() {
  if [ -z "$1" ]; then
    echo "Usage: relay <agent-name> [claude args...]"
    return 1
  fi
  local name="$1"; shift
  RELAY_AGENT_ID="$name" claude --dangerously-load-development-channels server:switchboard-channel "$@"
}
```

**Windows (PowerShell)** (add to `$PROFILE`):
```powershell
function relay {
  param([string]$Name, [Parameter(ValueFromRemainingArguments)]$Args)
  if (-not $Name) { Write-Host "Usage: relay <agent-name> [claude args...]"; return }
  $env:RELAY_AGENT_ID = $Name
  claude --dangerously-load-development-channels server:switchboard-channel @Args
}
```

Usage after adding the helper:
```
relay researcher
relay code-reviewer --some-claude-flag
```

## CLAUDE.md Configuration

Each project using multi-agent coordination should define agent identity in its `CLAUDE.md`. This tells the agent who it is and how to behave when relay events arrive.

Example template (replace `<name>` with the actual agent name):

```markdown
## Agent Identity
Your agent name is **<name>**. You are part of the Switchboard multi-agent relay.

When a `<channel source="switchboard-channel">` notification arrives, IMMEDIATELY
call `read_messages({ agent_id: "<name>" })` and respond to the message using
`send_message`.

Before touching any shared database, file, or migration, call `acquire_lock` first
and `release_lock` when done.

Keep responses concise and focused. Do not generate filler content.
```

## Communication Tools

All tools are provided by the relay MCP server (`switchboard` in your MCP config).

### send_message

Send a direct message to a named agent.

```
send_message({
  from:    "researcher",
  to:      "code-reviewer",
  message: "Review complete. PR is ready.",
  thread:  "pr-47"          // optional
})
```

### read_messages

Retrieve and clear your inbox. Also registers you as a known agent for broadcasts.

```
read_messages({
  agent_id: "researcher",
  thread:   "pr-47",    // optional — filter to one thread
  keep:     false       // optional — if true, messages stay in inbox
})
```

### broadcast

Send a message to all registered agents except yourself. Agents must have called `read_messages` at least once to appear in the registry.

```
broadcast({
  from:    "orchestrator",
  message: "All agents: migration starting in 60 seconds.",
  thread:  "deploy-v3"   // optional
})
```

### wait_for_message

Block until a reply arrives. Use for synchronous coordination where you need an answer before continuing.

```
wait_for_message({
  agent_id:        "researcher",
  timeout_seconds: 120    // optional, default: 120
})
```

Polls every 2 seconds. Returns the messages or a timeout notice.

### relay_status

See pending message counts and all currently held locks.

```
relay_status()
```

### list_sessions

List all registered agent sessions with their working directory, PID, and status (ACTIVE or STALE).

```
list_sessions()
```

Example output:
```
lorekeeper-fabric        ACTIVE   started 12m ago
  cwd: /home/user/projects/island-dev-knowledge
  pid: 4821

lore-architect           STALE    started 2h ago
  cwd: /home/user/projects/other-project
  pid: 3100 (no longer alive)
```

STALE sessions are those whose PID no longer exists. They are automatically cleaned up when a new session starts with the same agent name.

### clear_relay

Wipe messages from the relay. Omit `agent_id` to clear all inboxes.

```
clear_relay({ agent_id: "researcher" })   // one inbox
clear_relay({})                            // all inboxes
```

## Locking and Shared Resources

Use named locks to coordinate exclusive access to shared databases, files, migrations, or any resource only one agent should touch at a time.

### acquire_lock

```
acquire_lock({
  resource:    "users_table",
  holder:      "db-migrator",
  ttl_seconds: 300            // optional, default: 300 — auto-releases if forgotten
})
```

Returns success or tells you who holds it and how long they have left. Expired locks (past their TTL) are automatically released on the next acquisition attempt.

### release_lock

```
release_lock({
  resource: "users_table",
  holder:   "db-migrator"    // must match who acquired it
})
```

### list_locks

Shows all locks and their current state:

```
list_locks()
// 🔒 users_table — held by db-migrator (14s / 300s TTL)
// 🔓 schema.sql — free
```

**Always acquire before touching shared resources. Always release when done.** The TTL prevents permanent deadlocks if a session crashes while holding a lock.

## History and Audit Trail

`history.jsonl` is the permanent record of all relay activity. Every message sent, every broadcast, every lock acquisition and release is appended here.

**Event types:**

| Type | Description |
|------|-------------|
| `message` | Direct message sent between two agents |
| `broadcast` | Message sent to all registered agents |
| `lock_acquired` | Named lock claimed by an agent |
| `lock_released` | Named lock released by an agent |
| `stale_flush` | Messages cleared from inbox on session start (preserves full original content) |

`stale_flush` events record the complete original message when an inbox is flushed at session startup. No message content is lost — it moves from the live inbox to the permanent log.

**Monthly rotation:** The active file is always `history.jsonl`. At the first write of a new month, it is automatically renamed to `history-YYYY-MM.jsonl`. Both the relay server and channel server perform this rotation.

### read_history

Query the history log from within a session:

```
read_history({
  limit:       50,            // most recent N entries, default: 50
  filter:      "researcher",  // filter by agent name or resource name
  type:        "message",     // filter by event type
  month:       "2026-03",     // read an archived month (omit for current)
  list_months: true           // list all available history files
})
```

The history is designed for ingestion into vector stores and RAG systems. It records not just message content but the decisions and reasoning agents exchanged — valuable for project archaeology and organizational memory.

## Data Files Reference

All data lives in `~/.switchboard/` (Linux/macOS) or `%USERPROFILE%\.switchboard\` (Windows):

| File | Content | Persistence |
|------|---------|-------------|
| `messages.json` | Live inbox per agent | Ephemeral — cleared on read |
| `locks.json` | Named lock state | Updated on acquire/release |
| `sessions.json` | Active agent claims (pid, startedAt, cwd) | Updated on start/stop |
| `history.jsonl` | Current month event log | Permanent |
| `history-YYYY-MM.jsonl` | Archived months | Permanent |

`messages.lock` is a file-level mutex in the same directory. It is created and deleted rapidly during write operations. If a process crashes mid-write, the lock file may persist; it auto-expires after the 2-second timeout on the next operation.

## Running Tests

Tests can be run from either the install directory or the project repo.

**From the install directory:**

**Linux/macOS:**
```bash
cd ~/.claude/switchboard && node --test test/channel-unit.test.js
cd ~/.claude/switchboard && node --test test/channel-integration.test.js
cd ~/.claude/switchboard && node --test test/channel-unit.test.js test/channel-integration.test.js
```

**Windows (PowerShell):**
```powershell
Push-Location "$env:USERPROFILE\.claude\switchboard"
node --test test/channel-unit.test.js
node --test test/channel-integration.test.js
node --test test/channel-unit.test.js test/channel-integration.test.js
Pop-Location
```

**From the project repo** (after `npm install` with dev dependencies):

**Linux/macOS:**
```bash
node --test test/channel-unit.test.js
node --test test/channel-integration.test.js
node --test test/channel-unit.test.js test/channel-integration.test.js
```

**Windows (PowerShell):**
```powershell
node --test test\channel-unit.test.js
node --test test\channel-integration.test.js
node --test test\channel-unit.test.js test\channel-integration.test.js
```

Unit tests (pure logic, fast). Integration tests spawn real server processes and take approximately 8 seconds.

Tests use Node's built-in `node:test` runner — no additional test framework required. Integration tests use unique agent IDs (`integration-test-<timestamp>`) and clean up after themselves.

## Troubleshooting

**Check MCP server status** from inside a Claude Code session:
```
/mcp
```

Or from the terminal:

**Linux/macOS:**
```bash
claude mcp list
```

**Windows (PowerShell):**
```powershell
claude mcp list
```

**Verify your agent ID is set:**

**Linux/macOS:**
```bash
echo $RELAY_AGENT_ID
```

**Windows (PowerShell):**
```powershell
echo $env:RELAY_AGENT_ID
```

**Check session debug logs:**

**Linux/macOS:**
```bash
ls ~/.claude/debug/
cat ~/.claude/debug/<session-id>.txt
```

**Windows (PowerShell):**
```powershell
Get-ChildItem "$env:USERPROFILE\.claude\debug\"
Get-Content "$env:USERPROFILE\.claude\debug\<session-id>.txt"
```

**Session collision** — the error message includes the conflicting PID and working directory. Either choose a different name or stop that session first.

**Stale lock file** — if `~/.switchboard/messages.lock` persists after a crash, it will be ignored after the 2-second timeout on the next file operation. You can also delete it manually.

**Agent not receiving broadcasts** — the agent must have called `read_messages` at least once to appear in the registry. A session that has only ever used `send_message` will not receive broadcasts.

**Channel not waking idle agent** — verify:
1. The session was started with `--dangerously-load-development-channels server:switchboard-channel`
2. `RELAY_AGENT_ID` is set in the environment that launched `claude`
3. The `switchboard-channel` MCP server is registered (`claude mcp list`)
4. The session is authenticated via claude.ai (API key auth is not supported for Channels)

### Windows-Specific Notes

- **Antivirus interference**: Windows Defender or other antivirus may briefly lock `.json` files during scans, causing intermittent `EBUSY` errors. The relay retries after a 2-second timeout. If persistent, exclude `~/.switchboard/` from real-time scanning.
- **Session cleanup**: On Windows, the SIGTERM signal may not fire before process termination. A `process.on('exit')` backup handler is registered, but if the process is force-killed, stale session entries may persist in `sessions.json`. These are automatically cleaned up on the next startup with the same agent name.
- **File watching**: The channel server accepts both `'change'` and `'rename'` events from `fs.watch()` to handle platform differences. On Windows, content modifications may emit `'rename'` events instead of `'change'`.
