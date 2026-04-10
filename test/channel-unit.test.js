/**
 * channel-unit.test.js
 *
 * Unit tests for switchboard-channel.js pure logic, exercised through
 * channel-helpers.js so the MCP connection / top-level await in the main
 * file does not interfere.
 *
 * Run with:
 *   node --test test/channel-unit.test.js
 * from /home/d-tuned/.claude/switchboard/
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  getMessageCount,
  getNewMessages,
  shouldNotify,
  buildNotificationPayload,
  isPidAlive,
  readSessions,
  checkSessionClaim,
  buildStaleFlushRecord,
} from './channel-helpers.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create a temporary directory and return its path + the messages.json path. */
function makeTempDir() {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'))
  const msgFile = path.join(dir, 'messages.json')
  return { dir, msgFile }
}

/** Write an object to messages.json as JSON. */
function writeMessages(msgFile, data) {
  fs.writeFileSync(msgFile, JSON.stringify(data, null, 2))
}

/** Remove a temp directory and all its contents. */
function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── getMessageCount ────────────────────────────────────────────────────────────

describe('getMessageCount', () => {
  let dir, msgFile

  beforeEach(() => {
    ({ dir, msgFile } = makeTempDir())
  })

  afterEach(() => {
    cleanDir(dir)
  })

  it('returns correct count when file exists and agent has messages', () => {
    writeMessages(msgFile, {
      alpha: [
        { from: 'beta', message: 'hello' },
        { from: 'gamma', message: 'world' },
      ]
    })
    const count = getMessageCount(msgFile, 'alpha')
    assert.equal(count, 2)
  })

  it('returns 0 when file exists but agent has no messages (empty array)', () => {
    writeMessages(msgFile, { alpha: [] })
    const count = getMessageCount(msgFile, 'alpha')
    assert.equal(count, 0)
  })

  it('returns 0 when file exists but agent key is absent', () => {
    writeMessages(msgFile, { beta: [{ from: 'alpha', message: 'ping' }] })
    const count = getMessageCount(msgFile, 'alpha')
    assert.equal(count, 0)
  })

  it('returns 0 when messages.json does not exist', () => {
    // msgFile was never written
    const count = getMessageCount(msgFile, 'alpha')
    assert.equal(count, 0)
  })

  it('returns 0 when messages.json contains invalid JSON', () => {
    fs.writeFileSync(msgFile, '{ not valid json <<<')
    const count = getMessageCount(msgFile, 'alpha')
    assert.equal(count, 0)
  })

  it('returns count for the correct agent when multiple agents are present', () => {
    writeMessages(msgFile, {
      alpha: [{ from: 'beta', message: 'msg1' }, { from: 'beta', message: 'msg2' }],
      beta:  [{ from: 'alpha', message: 'reply' }],
    })
    assert.equal(getMessageCount(msgFile, 'alpha'), 2)
    assert.equal(getMessageCount(msgFile, 'beta'), 1)
  })
})

// ── getNewMessages ─────────────────────────────────────────────────────────────

describe('getNewMessages', () => {
  let dir, msgFile

  beforeEach(() => {
    ({ dir, msgFile } = makeTempDir())
  })

  afterEach(() => {
    cleanDir(dir)
  })

  it('returns the message array when file exists and agent has messages', () => {
    const msgs = [
      { from: 'beta', message: 'hello' },
      { from: 'gamma', message: 'world' },
    ]
    writeMessages(msgFile, { alpha: msgs })
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, msgs)
  })

  it('returns [] when file exists but agent has no messages (empty array)', () => {
    writeMessages(msgFile, { alpha: [] })
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, [])
  })

  it('returns [] when file exists but agent key is absent', () => {
    writeMessages(msgFile, { beta: [{ from: 'alpha', message: 'ping' }] })
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, [])
  })

  it('returns [] when messages.json does not exist', () => {
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, [])
  })

  it('returns [] when messages.json contains invalid JSON', () => {
    fs.writeFileSync(msgFile, '}}broken{{')
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, [])
  })

  it('returns only the requesting agent messages, not other agents', () => {
    const alphaMsg = [{ from: 'beta', message: 'for alpha' }]
    writeMessages(msgFile, {
      alpha: alphaMsg,
      beta:  [{ from: 'alpha', message: 'for beta' }],
    })
    const result = getNewMessages(msgFile, 'alpha')
    assert.deepEqual(result, alphaMsg)
  })
})

// ── Notification trigger logic (count comparison) ──────────────────────────────

describe('shouldNotify (count comparison logic)', () => {
  it('returns true when count is greater than lastKnownCount (new message arrived)', () => {
    assert.equal(shouldNotify(3, 2), true)
  })

  it('returns true when count goes from 0 to 1 (first message ever)', () => {
    assert.equal(shouldNotify(1, 0), true)
  })

  it('returns false when count equals lastKnownCount (no new messages)', () => {
    assert.equal(shouldNotify(2, 2), false)
  })

  it('returns false when count is less than lastKnownCount (messages were cleared)', () => {
    assert.equal(shouldNotify(0, 3), false)
  })

  it('returns false when count drops to 0 after having messages (inbox cleared)', () => {
    // This is the "reset counter" branch — count <= lastKnownCount
    assert.equal(shouldNotify(0, 5), false)
  })

  it('returns false when both count and lastKnownCount are 0', () => {
    assert.equal(shouldNotify(0, 0), false)
  })
})

// ── Notification content format ────────────────────────────────────────────────

describe('buildNotificationPayload (notification content format)', () => {
  it('uses the correct MCP method name', () => {
    const msg     = { from: 'beta', message: 'hello', thread: null }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.method, 'notifications/claude/channel')
  })

  it('content string follows "New message from {from}: {preview}" format', () => {
    const msg     = { from: 'beta', message: 'hello world', thread: null }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.content, 'New message from beta: hello world')
  })

  it('message is NOT truncated when it is exactly 200 characters', () => {
    const exactly200 = 'a'.repeat(200)
    const msg        = { from: 'beta', message: exactly200 }
    const payload    = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.content, `New message from beta: ${exactly200}`)
    assert.equal(payload.params.content.endsWith('...'), false)
  })

  it('message is truncated to 200 chars with "..." suffix when longer than 200', () => {
    const longMsg = 'x'.repeat(250)
    const msg     = { from: 'beta', message: longMsg }
    const payload = buildNotificationPayload(msg, 1)
    const expected = `New message from beta: ${'x'.repeat(200)}...`
    assert.equal(payload.params.content, expected)
  })

  it('message is NOT truncated and no "..." when shorter than 200 characters', () => {
    const shortMsg = 'short message'
    const msg      = { from: 'beta', message: shortMsg }
    const payload  = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.content.endsWith('...'), false)
    assert.ok(payload.params.content.includes(shortMsg))
  })

  it('meta.from matches the sender', () => {
    const msg     = { from: 'gamma', message: 'hi', thread: null }
    const payload = buildNotificationPayload(msg, 2)
    assert.equal(payload.params.meta.from, 'gamma')
  })

  it('meta.thread defaults to "none" when thread is undefined', () => {
    const msg     = { from: 'beta', message: 'hi' }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.meta.thread, 'none')
  })

  it('meta.thread defaults to "none" when thread is null', () => {
    const msg     = { from: 'beta', message: 'hi', thread: null }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.meta.thread, 'none')
  })

  it('meta.thread uses the provided thread label when present', () => {
    const msg     = { from: 'beta', message: 'hi', thread: 'review-pr-42' }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.meta.thread, 'review-pr-42')
  })

  it('meta.pending is a string representation of the count', () => {
    const msg     = { from: 'beta', message: 'hi', thread: null }
    const payload = buildNotificationPayload(msg, 5)
    assert.equal(typeof payload.params.meta.pending, 'string')
    assert.equal(payload.params.meta.pending, '5')
  })

  it('meta.pending reflects single message count as "1"', () => {
    const msg     = { from: 'beta', message: 'hi' }
    const payload = buildNotificationPayload(msg, 1)
    assert.equal(payload.params.meta.pending, '1')
  })

  it('payload contains params.content, params.meta.from, params.meta.thread, params.meta.pending', () => {
    const msg     = { from: 'alpha', message: 'test', thread: 'work' }
    const payload = buildNotificationPayload(msg, 3)
    assert.ok('content' in payload.params, 'params.content missing')
    assert.ok('from' in payload.params.meta, 'params.meta.from missing')
    assert.ok('thread' in payload.params.meta, 'params.meta.thread missing')
    assert.ok('pending' in payload.params.meta, 'params.meta.pending missing')
  })
})

// ── isPidAlive ─────────────────────────────────────────────────────────────────

describe('isPidAlive', () => {
  it('returns true for the current process PID', () => {
    assert.equal(isPidAlive(process.pid), true)
  })

  it('returns false for a definitely-dead PID', () => {
    // 99999999 is far above the Linux PID_MAX_LIMIT and will never be alive
    assert.equal(isPidAlive(99999999), false)
  })
})

// ── readSessions ───────────────────────────────────────────────────────────────

describe('readSessions', () => {
  let dir, sessionsFile

  beforeEach(() => {
    ({ dir, msgFile: sessionsFile } = makeTempDir())
    sessionsFile = path.join(dir, 'sessions.json')
  })

  afterEach(() => {
    cleanDir(dir)
  })

  it('returns {} when sessions file does not exist', () => {
    // sessionsFile was never written
    assert.deepEqual(readSessions(sessionsFile), {})
  })

  it('returns {} when sessions file contains invalid JSON', () => {
    fs.writeFileSync(sessionsFile, '{ not valid json <<<')
    assert.deepEqual(readSessions(sessionsFile), {})
  })

  it('returns parsed object when file is valid JSON', () => {
    const data = { alpha: { pid: 1234, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp' } }
    fs.writeFileSync(sessionsFile, JSON.stringify(data))
    assert.deepEqual(readSessions(sessionsFile), data)
  })

  it('returns correct session entry when multiple agents are registered', () => {
    const data = {
      alpha: { pid: 1111, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp/a' },
      beta:  { pid: 2222, startedAt: '2026-04-10T01:00:00.000Z', cwd: '/tmp/b' },
    }
    fs.writeFileSync(sessionsFile, JSON.stringify(data))
    const result = readSessions(sessionsFile)
    assert.deepEqual(result.alpha, data.alpha)
    assert.deepEqual(result.beta, data.beta)
  })
})

// ── checkSessionClaim ──────────────────────────────────────────────────────────

describe('checkSessionClaim', () => {
  let dir, sessionsFile

  beforeEach(() => {
    ({ dir, msgFile: sessionsFile } = makeTempDir())
    sessionsFile = path.join(dir, 'sessions.json')
  })

  afterEach(() => {
    cleanDir(dir)
  })

  it('returns "available" when agent has no entry in sessions', () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ beta: { pid: 1234, startedAt: '', cwd: '' } }))
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.equal(result.status, 'available')
  })

  it('returns "available" when sessions file does not exist', () => {
    // sessionsFile never written — readSessions returns {}
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.equal(result.status, 'available')
  })

  it('returns "stale" when agent entry exists but PID is dead', () => {
    const claim = { pid: 99999999, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp' }
    fs.writeFileSync(sessionsFile, JSON.stringify({ alpha: claim }))
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.equal(result.status, 'stale')
  })

  it('returns "claimed" when agent entry exists and PID is alive', () => {
    const claim = { pid: process.pid, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp' }
    fs.writeFileSync(sessionsFile, JSON.stringify({ alpha: claim }))
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.equal(result.status, 'claimed')
  })

  it('includes the claim object in a stale result', () => {
    const claim = { pid: 99999999, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp' }
    fs.writeFileSync(sessionsFile, JSON.stringify({ alpha: claim }))
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.deepEqual(result.claim, claim)
  })

  it('includes the claim object in a claimed result', () => {
    const claim = { pid: process.pid, startedAt: '2026-04-10T00:00:00.000Z', cwd: '/tmp' }
    fs.writeFileSync(sessionsFile, JSON.stringify({ alpha: claim }))
    const result = checkSessionClaim(sessionsFile, 'alpha')
    assert.deepEqual(result.claim, claim)
  })
})

// ── buildStaleFlushRecord ──────────────────────────────────────────────────────

describe('buildStaleFlushRecord', () => {
  const flushedAt = '2026-04-10T12:00:00.000Z'
  const msg = {
    from:      'beta',
    to:        'alpha',
    thread:    'pr-review',
    message:   'please look at this',
    timestamp: '2026-04-10T11:00:00.000Z',
    id:        'msg-abc-123',
  }

  it('returns correct structure with all required fields', () => {
    const record = buildStaleFlushRecord('alpha', msg, flushedAt)
    const requiredFields = [
      'type', 'timestamp', 'agent',
      'original_from', 'original_to', 'original_thread',
      'original_message', 'original_timestamp', 'original_id',
      'flushed_at', 'reason',
    ]
    for (const field of requiredFields) {
      assert.ok(field in record, `Missing field: ${field}`)
    }
  })

  it('has both timestamp and flushed_at set to flushedAt', () => {
    const record = buildStaleFlushRecord('alpha', msg, flushedAt)
    assert.equal(record.timestamp, flushedAt)
    assert.equal(record.flushed_at, flushedAt)
  })

  it('preserves original message fields (from, to, thread, message, timestamp, id)', () => {
    const record = buildStaleFlushRecord('alpha', msg, flushedAt)
    assert.equal(record.original_from,      msg.from)
    assert.equal(record.original_to,        msg.to)
    assert.equal(record.original_thread,    msg.thread)
    assert.equal(record.original_message,   msg.message)
    assert.equal(record.original_timestamp, msg.timestamp)
    assert.equal(record.original_id,        msg.id)
  })

  it('sets type to "stale_flush" and reason to "session_start"', () => {
    const record = buildStaleFlushRecord('alpha', msg, flushedAt)
    assert.equal(record.type,   'stale_flush')
    assert.equal(record.reason, 'session_start')
  })

  it('original_thread defaults to null when original message thread is undefined', () => {
    const msgNoThread = { ...msg, thread: undefined }
    const record = buildStaleFlushRecord('alpha', msgNoThread, flushedAt)
    assert.equal(record.original_thread, null)
  })

  it('original_thread defaults to null when original message thread is null', () => {
    const msgNullThread = { ...msg, thread: null }
    const record = buildStaleFlushRecord('alpha', msgNullThread, flushedAt)
    assert.equal(record.original_thread, null)
  })
})

// ── No RELAY_AGENT_ID edge case ────────────────────────────────────────────────

describe('no RELAY_AGENT_ID edge case', () => {
  it('getMessageCount returns 0 when called with undefined agentId (null/undefined key)', () => {
    // Simulates accessing data[undefined] which evaluates to undefined ?? []
    const { dir, msgFile } = makeTempDir()
    writeMessages(msgFile, { alpha: [{ from: 'beta', message: 'hi' }] })
    const count = getMessageCount(msgFile, undefined)
    assert.equal(count, 0)
    cleanDir(dir)
  })

  it('getNewMessages returns [] when called with undefined agentId', () => {
    const { dir, msgFile } = makeTempDir()
    writeMessages(msgFile, { alpha: [{ from: 'beta', message: 'hi' }] })
    const result = getNewMessages(msgFile, undefined)
    assert.deepEqual(result, [])
    cleanDir(dir)
  })
})
