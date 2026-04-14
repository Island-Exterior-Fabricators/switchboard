# Switchboard Playbook

A guide to naming agents, managing relay stores, and routing messages correctly
across environments.

---

## The Core Concept

A Switchboard **store** is a directory of JSON files (`messages.json`,
`sessions.json`, `locks.json`, `history.jsonl`). Any agent pointing at the same
directory is on the same relay. Agents pointing at different directories cannot
see each other's messages.

**One rule**: If two agents need to talk, they must point at the same store.

---

## Naming Agents

Agent names are set with `RELAY_AGENT_ID` before starting Claude Code.

### Convention

Use role-based names, not interface names:

```
lore-architect        — planning / cross-system coordination
lorekeeper-fabric     — owns Layer 2 / The Fabric SDK
lorekeeper-bom        — owns BOM domain
lorekeeper-materials  — owns Materials domain
lore-sentinel         — The Sentinel cron agent
lore-archivist        — The Archivist exit interview agent
major-tom             — personal orchestration agent
switchboard-architect — the person who built Switchboard
```

**Never** name agents after the interface they run in (`claude-desktop`,
`dev-knowledge`). The name should describe what the agent *does*, not where
it runs.

### Starting an Agent

```bash
export RELAY_AGENT_ID="lorekeeper-fabric"
export SWITCHBOARD_DATA_DIR="/mnt/c/Users/dclarke/.switchboard"
claude
```

Set `SWITCHBOARD_DATA_DIR` permanently in the MCP server env config in
`~/.claude.json` so the agent never falls back to the wrong local store.

---

## Managing Stores

### How Stores Work

A store is just a directory. The default is `~/.switchboard` on whichever
machine the agent runs on. If two agents run on different machines or
different OS environments (Windows + WSL), they each get their own
`~/.switchboard` unless `SWITCHBOARD_DATA_DIR` is explicitly shared.

### The Three-Store Problem

On a Windows + WSL setup, three stores can exist accidentally:

| Store | Path | Status |
|---|---|---|
| Windows store | `C:\Users\username\.switchboard` | Claude Desktop default |
| WSL store | `/home/username/.switchboard` | WSL default (the trap) |
| Shared store | `/path/to/shared/.switchboard` | Intentional shared hub |

**The WSL local store is a trap.** Always set `SWITCHBOARD_DATA_DIR` in WSL.

### Store Routing

Agents on different stores cannot see each other. Check which store you are on:

```
relay_status
```

If the registered agents differ from what you expect, you are on the wrong store.

---

## Tracking Sessions

Switchboard logs session state to `sessions.json` whenever an agent starts:

```json
{
  "lorekeeper-fabric": {
    "pid": 12345,
    "startedAt": "2026-04-14T01:00:00.000Z",
    "cwd": "/home/dclarke/projects/island-dev-knowledge"
  }
}
```

The `cwd` field is the agent's working context. An agent in
`/projects/island-dev-knowledge` is working on The Fabric SDK. An agent in
`/projects/sonic-store` is doing research. Same agent name, completely different
work. The cwd is the session's identity.

Use `list_sessions` to see all active and stale sessions with their working
directories.

---

## Common Problems

### "No messages" when messages were sent

**Cause**: Wrong store. `SWITCHBOARD_DATA_DIR` not set.

**Fix**: Set `SWITCHBOARD_DATA_DIR` in `~/.claude.json` MCP server env config.

### Messages disappear on restart

**Cause**: Stale flush on session start. Old messages are archived to
`history.jsonl` and inbox is cleared. This is intentional.

**Fix**: Re-send after restart. Or read `history.jsonl` directly.

### Agent name collision

**Cause**: Stale `sessions.json` entry or live session with same name.

**Fix**: Switchboard auto-clears stale entries (dead PID) on next startup.

---

## Quick Reference

```bash
# Start agent (WSL pointing at Windows store)
export SWITCHBOARD_DATA_DIR="/mnt/c/Users/username/.switchboard"
export RELAY_AGENT_ID="my-agent-name"
claude

# Check who is on the relay + active sessions
relay_status
list_sessions

# Check inbox
/relay
read_messages({ agent_id: "my-agent-name" })

# Send a message
send_message({ from: "my-agent-name", to: "recipient", message: "..." })
```

---

*Last updated: 2026-04-14.*
