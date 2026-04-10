#!/usr/bin/env bash
set -euo pipefail

# Switchboard installer — copies source to ~/.claude/switchboard/ and registers MCP servers

INSTALL_DIR="$HOME/.claude/switchboard"
DATA_DIR="$HOME/.switchboard"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing Switchboard to $INSTALL_DIR..."

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR"

# Copy source files
cp "$SCRIPT_DIR/src/relay-mcp.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/src/relay-hook.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/src/switchboard-channel.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"

# Copy test files
mkdir -p "$INSTALL_DIR/test"
cp "$SCRIPT_DIR/test/"*.js "$INSTALL_DIR/test/"

# Install npm dependencies
cd "$INSTALL_DIR"
npm install --production

# Register MCP servers (user-level)
claude mcp add switchboard node "$INSTALL_DIR/relay-mcp.js" -s user 2>/dev/null || echo "  switchboard already registered (or claude CLI not found)"
claude mcp add switchboard-channel node "$INSTALL_DIR/switchboard-channel.js" -s user 2>/dev/null || echo "  switchboard-channel already registered (or claude CLI not found)"

echo ""
echo "Installation complete."
echo ""
echo "Verify: claude mcp list"
echo ""
echo "Start an agent:"
echo "  export RELAY_AGENT_ID=<name>"
echo "  claude --dangerously-load-development-channels server:switchboard-channel"
