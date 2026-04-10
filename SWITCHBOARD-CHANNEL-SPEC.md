# Switchboard Channel — Implementation Spec
## Handoff Package for Claude Code on ml-research

---

## Context and Background

Switchboard is a working MCP relay server that lets multiple Claude Code instances
communicate with each other. It is installed at:

  ~/.claude/switchboard/

Files:
  relay-mcp.js       — MCP server with send_message, read_messages, broadcast,
                       acquire_lock, release_lock, list_locks, read_history tools
  relay-hook.js      — Stop hook that delivers messages on next turn
  package.json       — name: "switchboard", version: "2.0.0"

Data lives at:
  ~/.switchboard/
    messages.json    — live inbox per agent
    locks.json       — named lock state
    history.jsonl    — current month event log
    history-YYYY-MM.jsonl — monthly archives

The relay is registered as a global MCP server:
  claude mcp list    # should show "switchboard"

Each agent session is started with:
  export RELAY_AGENT_ID=alpha && claude   # or beta, gamma, etc.

---

## The Problem Being Solved

The Stop hook (relay-hook.js) only fires when an agent ENDS a turn. If an agent is
idle — sitting waiting for work — no turns end, so the hook never fires, and messages
from other agents pile up undelivered. The human operator has to manually tell the
idle agent to check its inbox. This defeats the purpose of the relay.

---

## The Solution: Claude Code Channels

Claude Code v2.1.80+ has a Channels feature (research preview). A Channel is an MCP
server that declares the `claude/channel` capability and can PUSH notifications into
a running Claude Code session at any time — even when the agent is completely idle.

This solves the problem: when beta writes a message for alpha, the channel server
detects it immediately and pushes a notification into alpha's live session, waking
it up.

Reference documentation: https://code.claude.com/docs/en/channels-reference

---

## What Needs to Be Built

One new file: ~/.claude/switchboard/switchboard-channel.js

This is a second MCP server (separate from relay-mcp.js) that:

1. Declares the claude/channel capability so Claude Code registers it as a channel
2. Watches ~/.switchboard/messages.json using fs.watch for file changes
3. When the file changes, reads it and checks if there are new messages for the
   agent identified by the RELAY_AGENT_ID environment variable
4. If messages exist, pushes a notifications/claude/channel notification with the
   message content — this wakes up the idle agent immediately
5. Does NOT clear the messages — relay-mcp.js read_messages tool handles that
   (the channel is notification-only, not a replacement for the MCP tools)

---

## Channel Server Implementation

The channel server must follow the MCP SDK pattern. Here is the exact structure
based on the official Channels reference documentation:

```javascript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

const RELAY_DIR = path.join(os.homedir(), '.switchboard')
const MSG_FILE  = path.join(RELAY_DIR, 'messages.json')
const agentId   = process.env.RELAY_AGENT_ID

if (!agentId) {
  process.stderr.write('RELAY_AGENT_ID not set — channel will not watch inbox\n')
  // Still connect so Claude Code doesn't error, just do nothing
}

const mcp = new Server(
  { name: 'switchboard-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} }
    },
    instructions: [
      `You are agent "${agentId}" on the Switchboard relay.`,
      `When a <channel source="switchboard-channel"> event arrives, it means`,
      `another agent has sent you a message.`,
      `Immediately call read_messages({ agent_id: "${agentId}" }) to retrieve`,
      `the full message, then respond using send_message.`,
      `Keep responses concise and focused. Do not generate filler content.`
    ].join(' ')
  }
)

await mcp.connect(new StdioServerTransport())

// Only watch if we have an agent ID
if (agentId) {
  let lastKnownCount = getMessageCount()

  function getMessageCount() {
    try {
      if (!fs.existsSync(MSG_FILE)) return 0
      const data = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
      return (data[agentId] ?? []).length
    } catch { return 0 }
  }

  function getNewMessages() {
    try {
      if (!fs.existsSync(MSG_FILE)) return []
      const data = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
      return data[agentId] ?? []
    } catch { return [] }
  }

  // Watch for file changes
  fs.watch(MSG_FILE, { persistent: true }, async (event) => {
    if (event !== 'change') return
    
    // Small debounce to let the write complete
    await new Promise(r => setTimeout(r, 100))
    
    const messages = getNewMessages()
    const count = messages.length
    
    if (count > lastKnownCount) {
      lastKnownCount = count
      const newest = messages[messages.length - 1]
      
      // Push notification into the Claude Code session
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `New message from ${newest.from}: ${newest.message.slice(0, 200)}${newest.message.length > 200 ? '...' : ''}`,
          meta: {
            from: newest.from,
            thread: newest.thread ?? 'none',
            pending: String(count)
          }
        }
      })
    } else {
      // Messages were cleared (read) — reset counter
      lastKnownCount = count
    }
  })

  // If messages.json doesn't exist yet, watch the directory for its creation
  if (!fs.existsSync(MSG_FILE)) {
    fs.watch(RELAY_DIR, { persistent: true }, async (event, filename) => {
      if (filename === 'messages.json' && fs.existsSync(MSG_FILE)) {
        // File was created — set up the file watcher now
        // (the outer watch will handle it next time)
        lastKnownCount = getMessageCount()
      }
    })
  }
}
```

---

## How to Start with the Channel

The channel is loaded alongside Claude Code using the --channels flag with the
development bypass (required during research preview for custom channels):

  export RELAY_AGENT_ID=alpha
  claude --dangerously-load-development-channels server:switchboard-channel

Note: "server:switchboard-channel" is the name of the MCP server entry in the
config. The MCP server must be registered. See Registration section below.

---

## Registration

The channel server needs to be registered in ~/.claude.json (user-level MCP config)
so Claude Code can find it. Add it alongside the existing switchboard entry:

Current ~/.claude.json likely has:
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/home/d-tuned/.claude/switchboard/relay-mcp.js"]
    }
  }
}

Add the channel entry:
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/home/d-tuned/.claude/switchboard/relay-mcp.js"]
    },
    "switchboard-channel": {
      "command": "node",
      "args": ["/home/d-tuned/.claude/switchboard/switchboard-channel.js"]
    }
  }
}

Register via CLI:
  claude mcp add switchboard-channel node \
    /home/d-tuned/.claude/switchboard/switchboard-channel.js -s user

---

## What Changes for Existing Setup

1. relay-mcp.js         — NO CHANGES. All existing tools stay identical.
2. relay-hook.js        — KEEP as fallback for active sessions. The channel
                          handles idle; the hook handles the turn-boundary case.
3. ~/.claude/settings.json — NO CHANGES to hooks config.
4. package.json         — NO CHANGES. @modelcontextprotocol/sdk already installed.
5. ~/.switchboard/      — NO CHANGES. Same data files.

Only addition: switchboard-channel.js

---

## Updated Start Command for Each Agent

Old:
  export RELAY_AGENT_ID=alpha && claude

New:
  export RELAY_AGENT_ID=alpha && claude --dangerously-load-development-channels server:switchboard-channel

The --dangerously-load-development-channels flag is required during the research
preview for custom (non-allowlisted) channels. This is expected and safe for
internal use.

---

## Updated CLAUDE.md Entry for Each Agent

Add this to the CLAUDE.md in each project these agents work in:

### Alpha
```
## Agent Identity
Your agent name is **alpha**. You are part of the Switchboard multi-agent relay.
Other agents: **beta** (and any others with RELAY_AGENT_ID set).

When a <channel source="switchboard-channel"> notification arrives, IMMEDIATELY
call read_messages({ agent_id: "alpha" }) and respond to the message.

Before touching any shared database resource, call acquire_lock first and
release_lock when done.

Keep responses concise. Do not generate filler content.
```

### Beta
```
## Agent Identity  
Your agent name is **beta**. You are part of the Switchboard multi-agent relay.
Other agents: **alpha** (and any others with RELAY_AGENT_ID set).

When a <channel source="switchboard-channel"> notification arrives, IMMEDIATELY
call read_messages({ agent_id: "beta" }) and respond to the message.

Before touching any shared database resource, call acquire_lock first and
release_lock when done.

Keep responses concise. Do not generate filler content.
```

---

## Testing Plan

1. Copy switchboard-channel.js to ~/.claude/switchboard/
2. Register it: claude mcp add switchboard-channel node ~/.claude/switchboard/switchboard-channel.js -s user
3. Start alpha: export RELAY_AGENT_ID=alpha && claude --dangerously-load-development-channels server:switchboard-channel
4. Let alpha go idle (give it nothing to do)
5. From a second terminal, start beta: export RELAY_AGENT_ID=beta && claude --dangerously-load-development-channels server:switchboard-channel
6. Have beta send a message: send_message({ from: "beta", to: "alpha", message: "Test push notification" })
7. Verify alpha wakes up and responds WITHOUT you manually prompting it

If alpha receives the notification, the channel is working. If not, check:
  - ~/.claude/debug/<session-id>.txt for errors
  - Run /mcp inside the session to check server status
  - Verify RELAY_AGENT_ID is set in the environment

---

## Known Constraints

- Research preview: --dangerously-load-development-channels is required. This is
  expected. Anthropic will add an allowlist process later.
- Session must be open: If Claude Code is closed, the channel is not running and
  cannot receive pushes. Messages queue in messages.json and are delivered via
  the Stop hook when the session resumes.
- claude.ai login required: API key auth is not supported for Channels.
  The user authenticates via claude.ai which is already the case.

---

## Questions Back to Claude Desktop (this conversation)

If anything is unclear or the implementation hits unexpected behavior, report back
to this Claude Desktop session (Agentic Memory project, Switchboard conversation).
The mental model and research context lives here.

---

## Summary of Files After Implementation

~/.claude/switchboard/
  relay-mcp.js              — unchanged, all relay tools
  relay-hook.js             — unchanged, fallback Stop hook  
  switchboard-channel.js    — NEW, push notification channel
  package.json              — unchanged

~/.switchboard/
  messages.json             — unchanged
  locks.json                — unchanged
  history.jsonl             — unchanged
