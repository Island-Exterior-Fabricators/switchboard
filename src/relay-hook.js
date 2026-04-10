#!/usr/bin/env node
/**
 * relay-hook.js — Switchboard Stop hook
 *
 * Checks the Switchboard inbox for this agent and injects pending messages
 * as a systemMessage on the next turn.
 *
 * Set RELAY_AGENT_ID before starting Claude Code:
 *   export RELAY_AGENT_ID=alpha   (Linux/macOS)
 *   set RELAY_AGENT_ID=alpha      (Windows)
 */

import fs from "fs";
import path from "path";
import os from "os";

const RELAY_DIR = path.join(os.homedir(), ".switchboard");
const MSG_FILE  = path.join(RELAY_DIR, "messages.json");
const LOCK_FILE = path.join(RELAY_DIR, "messages.lock");

const agentId = process.env.RELAY_AGENT_ID;

if (!agentId) process.exit(0);

function waitForLock(timeout = 2000) {
  const start = Date.now();
  while (fs.existsSync(LOCK_FILE)) {
    if (Date.now() - start > timeout) break;
    const t = Date.now(); while (Date.now() - t < 10) {}
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function read() {
  try {
    if (!fs.existsSync(MSG_FILE)) return {};
    return JSON.parse(fs.readFileSync(MSG_FILE, "utf8"));
  } catch { return {}; }
}

function write(data) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2));
}

let messages = [];

waitForLock();
try {
  const data = read();
  messages = data[agentId] ?? [];
  if (messages.length > 0) {
    data[agentId] = [];
    write(data);
  }
} finally {
  releaseLock();
}

if (messages.length === 0) process.exit(0);

const formatted = messages.map(m => {
  const thread = m.thread ? ` [${m.thread}]` : "";
  return `From ${m.from}${thread}:\n${m.message}`;
}).join("\n\n---\n\n");

const output = {
  systemMessage: [
    `SWITCHBOARD MESSAGE for agent "${agentId}":`,
    ``,
    formatted,
    ``,
    `INSTRUCTIONS: You are agent "${agentId}". Read the message above carefully.`,
    `Reply using send_message({ from: "${agentId}", to: "<sender>", message: "..." }).`,
    `Keep your reply concise and focused. Do not generate filler content.`
  ].join("\n")
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
