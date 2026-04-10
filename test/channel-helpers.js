/**
 * channel-helpers.js
 *
 * Pure logic extracted from switchboard-channel.js for isolated unit testing.
 * These functions mirror the exact logic in the main file without the MCP
 * connection or file-watching side effects.
 */

import fs from 'fs'

// ── Session registry helpers ───────────────────────────────────────────────────

/**
 * Returns true if a process with the given PID is alive, false otherwise.
 * Mirrors isPidAlive() in switchboard-channel.js.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Reads and parses sessions.json from the given path.
 * Returns {} on any error (file missing, invalid JSON).
 * Mirrors readSessions() in switchboard-channel.js but with a parameterised path.
 *
 * @param {string} sessionsFile - Absolute path to sessions.json
 * @returns {object}
 */
export function readSessions(sessionsFile) {
  try {
    if (!fs.existsSync(sessionsFile)) return {}
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  } catch { return {} }
}

/**
 * Checks whether agentId is available, stale, or actively claimed.
 * Mirrors the session-check block in the startup section of switchboard-channel.js.
 *
 * Returns one of:
 *   { status: 'available' }
 *   { status: 'stale',   claim: { pid, startedAt, cwd } }
 *   { status: 'claimed', claim: { pid, startedAt, cwd } }
 *
 * @param {string} sessionsFile - Absolute path to sessions.json
 * @param {string} agentId
 * @returns {{ status: string, claim?: object }}
 */
export function checkSessionClaim(sessionsFile, agentId) {
  const sessions = readSessions(sessionsFile)
  const claim = sessions[agentId]
  if (!claim) return { status: 'available' }
  if (isPidAlive(claim.pid)) return { status: 'claimed', claim }
  return { status: 'stale', claim }
}

// ── Stale flush helpers ────────────────────────────────────────────────────────

/**
 * Builds a stale_flush history record for a single message.
 * Mirrors the record literal constructed inside flushStaleMessages() in
 * switchboard-channel.js.
 *
 * Both `timestamp` and `flushed_at` are set to flushedAt so that the history
 * rotation logic (which reads entry.timestamp) works correctly.
 *
 * @param {string} agentId   - Receiving agent name
 * @param {object} msg       - Original message object
 * @param {string} flushedAt - ISO timestamp of the flush operation
 * @returns {object}
 */
export function buildStaleFlushRecord(agentId, msg, flushedAt) {
  return {
    type:               'stale_flush',
    timestamp:          flushedAt,
    agent:              agentId,
    original_from:      msg.from,
    original_to:        msg.to,
    original_thread:    msg.thread ?? null,
    original_message:   msg.message,
    original_timestamp: msg.timestamp,
    original_id:        msg.id,
    flushed_at:         flushedAt,
    reason:             'session_start'
  }
}

/**
 * Returns the number of pending messages for agentId in the given messages file.
 * Returns 0 on any error (file missing, invalid JSON, missing key).
 *
 * @param {string} msgFile  - Absolute path to messages.json
 * @param {string} agentId  - Agent key to look up
 * @returns {number}
 */
export function getMessageCount(msgFile, agentId) {
  try {
    if (!fs.existsSync(msgFile)) return 0
    const data = JSON.parse(fs.readFileSync(msgFile, 'utf8'))
    return (data[agentId] ?? []).length
  } catch {
    return 0
  }
}

/**
 * Returns the array of pending messages for agentId in the given messages file.
 * Returns [] on any error (file missing, invalid JSON, missing key).
 *
 * @param {string} msgFile  - Absolute path to messages.json
 * @param {string} agentId  - Agent key to look up
 * @returns {Array}
 */
export function getNewMessages(msgFile, agentId) {
  try {
    if (!fs.existsSync(msgFile)) return []
    const data = JSON.parse(fs.readFileSync(msgFile, 'utf8'))
    return data[agentId] ?? []
  } catch {
    return []
  }
}

/**
 * Determines whether a notification should be sent based on message counts.
 * Mirrors the `if (count > lastKnownCount)` branch in switchboard-channel.js.
 *
 * @param {number} count          - Current message count from file
 * @param {number} lastKnownCount - Previously stored count
 * @returns {boolean}
 */
export function shouldNotify(count, lastKnownCount) {
  return count > lastKnownCount
}

/**
 * Builds the MCP notification payload for a new message.
 * Mirrors the exact notification params constructed in switchboard-channel.js.
 *
 * @param {object} newest - The newest message object
 * @param {string} newest.from    - Sender agent name
 * @param {string} newest.message - Message body
 * @param {string} [newest.thread] - Optional thread label
 * @param {number} count - Total pending message count
 * @returns {{ method: string, params: { content: string, meta: object } }}
 */
export function buildNotificationPayload(newest, count) {
  const preview = newest.message.slice(0, 200)
  const suffix  = newest.message.length > 200 ? '...' : ''
  return {
    method: 'notifications/claude/channel',
    params: {
      content: `New message from ${newest.from}: ${preview}${suffix}`,
      meta: {
        from:    newest.from,
        thread:  newest.thread ?? 'none',
        pending: String(count),
      }
    }
  }
}
