/**
 * channel-integration.test.js
 *
 * End-to-end integration test for switchboard-channel.js.
 *
 * Acceptance criteria verified:
 * 1. Server starts and completes MCP initialize handshake
 * 2. Server pushes notifications/claude/channel when a new message arrives
 * 3. Notification content and meta fields are correct
 * 4. Server does NOT push a notification when messages are cleared (count drops)
 * 5. Stale inbox is flushed on startup and preserved in history
 * 6. Session collision detected when name is claimed by live PID
 * 7. Session claim is released on clean exit
 *
 * Strategy: spawn the child process against the real ~/.switchboard/ directory
 * using a unique agent ID (integration-test-<timestamp>) that won't clash with
 * real agent inboxes. Write/clear/restore messages.json around each assertion
 * and clean up the test agent key when done.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// ── paths ─────────────────────────────────────────────────────────────────────

const __dirname      = path.dirname(fileURLToPath(import.meta.url))
const CHANNEL_JS     = path.join(__dirname, '..', 'switchboard-channel.js')
const RELAY_DIR      = path.join(os.homedir(), '.switchboard')
const MSG_FILE       = path.join(RELAY_DIR, 'messages.json')
const SESSIONS_FILE  = path.join(RELAY_DIR, 'sessions.json')
const HISTORY_FILE   = path.join(RELAY_DIR, 'history.jsonl')

// Unique agent ID that won't collide with real inboxes
const AGENT_ID = `integration-test-${Date.now()}`

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function makeInitialize(id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' }
    }
  }) + '\n'
}

function makeInitialized() {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  }) + '\n'
}

// ── stdout reader — collects newline-delimited JSON messages ──────────────────

function createLineReader(readable) {
  let buf = ''
  const queue = []
  const waiters = []

  readable.on('data', chunk => {
    buf += chunk.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() // keep the incomplete trailing piece
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed
      try { parsed = JSON.parse(trimmed) } catch { continue }
      if (waiters.length > 0) {
        waiters.shift()(parsed)
      } else {
        queue.push(parsed)
      }
    }
  })

  /**
   * Returns the next parsed JSON-RPC message from stdout,
   * timing out after `ms` milliseconds.
   */
  function nextMessage(ms = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error(`Timed out waiting for next message after ${ms}ms`))
      }, ms)

      function waiter(msg) {
        clearTimeout(timer)
        resolve(msg)
      }

      if (queue.length > 0) {
        clearTimeout(timer)
        resolve(queue.shift())
      } else {
        waiters.push(waiter)
      }
    })
  }

  return { nextMessage }
}

// ── messages.json helpers ─────────────────────────────────────────────────────

function readMsgFile() {
  try {
    if (!fs.existsSync(MSG_FILE)) return {}
    return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'))
  } catch { return {} }
}

function writeMsgFile(data) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2))
}

function addTestMessage(agentId, msg) {
  const data = readMsgFile()
  if (!data[agentId]) data[agentId] = []
  data[agentId].push(msg)
  writeMsgFile(data)
}

function clearTestAgent(agentId) {
  const data = readMsgFile()
  data[agentId] = []
  writeMsgFile(data)
}

function removeTestAgent(agentId) {
  const data = readMsgFile()
  delete data[agentId]
  writeMsgFile(data)
}

// ── sessions.json helpers ─────────────────────────────────────────────────────

function readSessionsFile() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return {}
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
  } catch { return {} }
}

function writeSessionsFile(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
}

function removeTestSession(agentId) {
  const data = readSessionsFile()
  delete data[agentId]
  writeSessionsFile(data)
}

// ── test fixture: spawn + handshake ──────────────────────────────────────────

async function spawnAndHandshake() {
  const child = spawn('node', [CHANNEL_JS], {
    env: { ...process.env, RELAY_AGENT_ID: AGENT_ID },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const reader = createLineReader(child.stdout)

  // Send initialize
  child.stdin.write(makeInitialize())

  // Expect initialize response
  const initResponse = await reader.nextMessage(5000)
  assert.equal(initResponse.jsonrpc, '2.0', 'initialize response must be JSON-RPC 2.0')
  assert.ok(initResponse.result, 'initialize response must have a result')
  assert.ok(
    initResponse.result.capabilities,
    'initialize result must have capabilities'
  )

  // Confirm we see the claude/channel experimental capability
  assert.ok(
    initResponse.result.capabilities?.experimental?.['claude/channel'] !== undefined,
    'Server must advertise claude/channel experimental capability'
  )

  // Send initialized notification (completes handshake)
  child.stdin.write(makeInitialized())

  return { child, reader }
}

// ── Test 1: MCP handshake succeeds ────────────────────────────────────────────

test('MCP initialize handshake completes and server advertises claude/channel capability', {
  timeout: 15000
}, async () => {
  // Ensure the test agent slot starts empty
  clearTestAgent(AGENT_ID)

  let child
  try {
    const fixture = await spawnAndHandshake()
    child = fixture.child
    // If we reach here the handshake succeeded; capability assertion is inside spawnAndHandshake
  } finally {
    if (child) child.kill('SIGTERM')
    removeTestAgent(AGENT_ID)
  }
})

// ── Test 2: Notification fires when a new message arrives ────────────────────

test('pushes notifications/claude/channel notification when new message arrives', {
  timeout: 15000
}, async () => {
  clearTestAgent(AGENT_ID)

  const { child, reader } = await spawnAndHandshake()

  // Allow the file watcher to establish (it registers immediately after connect)
  await new Promise(r => setTimeout(r, 300))

  const testMsg = {
    id: 'test-1',
    from: 'beta',
    to: AGENT_ID,
    thread: null,
    message: 'Hello from integration test',
    timestamp: '2026-04-10T00:00:00.000Z',
    read: false
  }

  try {
    // Write the message — this triggers fs.watch 'change' event
    addTestMessage(AGENT_ID, testMsg)

    // Wait for the channel notification (up to 3s, server has 100ms debounce)
    const notification = await reader.nextMessage(3000)

    // Verify it is the expected notification
    assert.equal(notification.jsonrpc, '2.0', 'Notification must be JSON-RPC 2.0')
    assert.equal(
      notification.method,
      'notifications/claude/channel',
      'Method must be notifications/claude/channel'
    )
    assert.ok(notification.params, 'Notification must have params')
    assert.ok(
      typeof notification.params.content === 'string',
      'params.content must be a string'
    )
    assert.ok(
      notification.params.content.includes('beta'),
      'content must include the sender name'
    )
    assert.ok(
      notification.params.content.includes('Hello from integration test'),
      'content must include the message text'
    )

    // Verify meta fields
    const meta = notification.params.meta
    assert.ok(meta, 'params.meta must be present')
    assert.equal(meta.from, 'beta', 'meta.from must be the sender')
    assert.equal(meta.thread, 'none', 'meta.thread must be "none" when thread is null')
    assert.equal(meta.pending, '1', 'meta.pending must reflect message count as string')
  } finally {
    child.kill('SIGTERM')
    removeTestAgent(AGENT_ID)
  }
})

// ── Test 3: No notification when messages are cleared ────────────────────────

test('does NOT push a notification when messages are cleared (count drops)', {
  timeout: 15000
}, async () => {
  // Pre-load the agent inbox with one message so lastKnownCount starts at 1
  const preExistingMsg = {
    id: 'pre-1',
    from: 'alpha',
    to: AGENT_ID,
    thread: null,
    message: 'Pre-existing message',
    timestamp: '2026-04-10T00:00:00.000Z',
    read: false
  }
  const data = readMsgFile()
  data[AGENT_ID] = [preExistingMsg]
  writeMsgFile(data)

  const { child, reader } = await spawnAndHandshake()

  // Allow the file watcher to establish; lastKnownCount reads 1 at startup
  await new Promise(r => setTimeout(r, 300))

  let unexpectedNotification = null

  // Capture any notifications that arrive in the next 2 seconds
  const capturePromise = new Promise(resolve => {
    const deadline = setTimeout(() => resolve(null), 2000)
    reader.nextMessage(2000)
      .then(msg => {
        clearTimeout(deadline)
        resolve(msg)
      })
      .catch(() => {
        // timeout — no message arrived, which is what we want
        resolve(null)
      })
  })

  try {
    // Clear the agent's inbox — count drops from 1 → 0
    clearTestAgent(AGENT_ID)

    unexpectedNotification = await capturePromise

    assert.equal(
      unexpectedNotification,
      null,
      'No notification should be pushed when messages are cleared'
    )
  } finally {
    child.kill('SIGTERM')
    removeTestAgent(AGENT_ID)
  }
})

// ── Test 4: Stale inbox is flushed on startup and preserved in history ────────

test('stale inbox is flushed on startup and preserved in history.jsonl', {
  timeout: 15000
}, async () => {
  const AGENT_ID_4 = `integration-test-${Date.now()}-stale`

  // Step 1: Write a stale message into the agent's inbox before startup
  const staleMsg = {
    id:        'stale-msg-1',
    from:      'gamma',
    to:        AGENT_ID_4,
    thread:    null,
    message:   'This message was never read',
    timestamp: '2026-01-01T00:00:00.000Z',
    read:      false
  }
  const msgData = readMsgFile()
  msgData[AGENT_ID_4] = [staleMsg]
  writeMsgFile(msgData)

  // Step 2: Record the current line count in history.jsonl before startup
  const historyBefore = fs.existsSync(HISTORY_FILE)
    ? fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
    : []
  const lineCountBefore = historyBefore.length

  // Step 3 & 4: Spawn the server and complete the MCP handshake — but use
  // this test's agent ID, not the shared AGENT_ID
  const child = spawn('node', [CHANNEL_JS], {
    env: { ...process.env, RELAY_AGENT_ID: AGENT_ID_4 },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const reader = createLineReader(child.stdout)
  child.stdin.write(makeInitialize())
  const initResponse = await reader.nextMessage(5000)
  assert.ok(initResponse.result, 'initialize response must have a result')
  child.stdin.write(makeInitialized())

  try {
    // Step 5: Wait for startup flush to complete
    await new Promise(r => setTimeout(r, 500))

    // Step 6: Verify messages.json inbox for our agent is now empty
    const msgAfter = readMsgFile()
    const inboxAfter = msgAfter[AGENT_ID_4]
    assert.ok(
      inboxAfter === undefined || inboxAfter.length === 0,
      'inbox must be empty after startup flush'
    )

    // Step 7: Verify history.jsonl has a new stale_flush line for our agent
    const historyAfter = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
    assert.ok(
      historyAfter.length > lineCountBefore,
      'history.jsonl must have gained at least one new line'
    )

    const newLines = historyAfter.slice(lineCountBefore)
    const flushRecord = newLines
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .find(rec => rec && rec.type === 'stale_flush' && rec.agent === AGENT_ID_4)

    assert.ok(
      flushRecord,
      'history.jsonl must contain a stale_flush record for our agent ID'
    )

    // Step 8: Verify the stale_flush record preserves original message fields
    assert.equal(flushRecord.original_message, staleMsg.message, 'original_message must be preserved')
    assert.equal(flushRecord.original_from,    staleMsg.from,    'original_from must be preserved')
    assert.equal(flushRecord.original_id,      staleMsg.id,      'original_id must be preserved')

    // Step 9: Verify the record has both timestamp and flushed_at fields
    assert.ok(
      typeof flushRecord.timestamp  === 'string' && flushRecord.timestamp.length > 0,
      'stale_flush record must have a timestamp field'
    )
    assert.ok(
      typeof flushRecord.flushed_at === 'string' && flushRecord.flushed_at.length > 0,
      'stale_flush record must have a flushed_at field'
    )
  } finally {
    // Step 10: Kill child and clean up
    child.kill('SIGTERM')
    removeTestAgent(AGENT_ID_4)
    removeTestSession(AGENT_ID_4)
  }
})

// ── Test 5: Session collision detected when name is claimed by live PID ───────

test('server exits with code 1 and emits collision error when agent name is claimed by live PID', {
  timeout: 15000
}, async () => {
  const AGENT_ID_5 = `integration-test-${Date.now()}-collision`

  // Step 1: Write a fake session entry claiming our own PID (which IS alive)
  const sessions = readSessionsFile()
  sessions[AGENT_ID_5] = {
    pid:       process.pid,
    startedAt: new Date().toISOString(),
    cwd:       process.cwd()
  }
  writeSessionsFile(sessions)

  let child
  try {
    // Step 2: Spawn the server — it should detect the collision and exit
    child = spawn('node', [CHANNEL_JS], {
      env: { ...process.env, RELAY_AGENT_ID: AGENT_ID_5 },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderrOutput = ''
    child.stderr.on('data', chunk => { stderrOutput += chunk.toString('utf8') })

    // Step 3: Wait for the child to exit
    const exitCode = await new Promise(resolve => {
      child.on('exit', code => resolve(code))
    })

    // Verify the server exited with code 1
    assert.equal(exitCode, 1, 'server must exit with code 1 on session collision')

    // Step 4: Verify stderr contains the collision error mentioning our PID
    assert.ok(
      stderrOutput.includes(String(process.pid)),
      `stderr must mention the colliding PID (${process.pid}); got: ${stderrOutput}`
    )
    assert.ok(
      stderrOutput.toLowerCase().includes('already claimed') ||
      stderrOutput.toLowerCase().includes('error'),
      `stderr must contain a collision/error message; got: ${stderrOutput}`
    )
  } finally {
    // Step 5: Clean up the fake session entry
    if (child && !child.killed) child.kill('SIGTERM')
    removeTestSession(AGENT_ID_5)
    removeTestAgent(AGENT_ID_5)
  }
})

// ── Test 6: Session claim is released on clean exit ───────────────────────────

test('session claim is written on startup and removed from sessions.json on SIGTERM', {
  timeout: 15000
}, async () => {
  const AGENT_ID_6 = `integration-test-${Date.now()}-session`

  // Ensure no leftover session entry for this agent
  removeTestSession(AGENT_ID_6)
  removeTestAgent(AGENT_ID_6)

  // Step 1 & 2: Spawn and complete MCP handshake
  const child = spawn('node', [CHANNEL_JS], {
    env: { ...process.env, RELAY_AGENT_ID: AGENT_ID_6 },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const reader = createLineReader(child.stdout)
  child.stdin.write(makeInitialize())
  const initResponse = await reader.nextMessage(5000)
  assert.ok(initResponse.result, 'initialize response must have a result')
  child.stdin.write(makeInitialized())

  try {
    // Step 3: Wait for watchers and session claim to settle
    await new Promise(r => setTimeout(r, 300))

    // Step 4: Verify sessions.json contains our agent ID with the child's PID
    const sessionsBefore = readSessionsFile()
    assert.ok(
      sessionsBefore[AGENT_ID_6],
      'sessions.json must contain our agent ID after startup'
    )
    assert.equal(
      sessionsBefore[AGENT_ID_6].pid,
      child.pid,
      'session entry must record the child process PID'
    )

    // Step 5: Send SIGTERM to trigger the clean exit handler
    child.kill('SIGTERM')

    // Step 6: Wait for the child to exit
    await new Promise(resolve => {
      child.on('exit', resolve)
    })

    // Step 7: Verify sessions.json no longer contains our agent ID
    const sessionsAfter = readSessionsFile()
    assert.ok(
      !sessionsAfter[AGENT_ID_6],
      'sessions.json must not contain our agent ID after clean exit'
    )
  } finally {
    // Step 8: Clean up
    if (!child.killed) child.kill('SIGTERM')
    removeTestAgent(AGENT_ID_6)
    removeTestSession(AGENT_ID_6)
  }
})
