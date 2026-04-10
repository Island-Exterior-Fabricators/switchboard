# Switchboard installer — copies source to ~/.claude/switchboard/ and registers MCP servers

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:USERPROFILE ".claude\switchboard"
$DataDir = Join-Path $env:USERPROFILE ".switchboard"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installing Switchboard to $InstallDir..."

# Create directories
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# Copy source files
Copy-Item "$ScriptDir\src\relay-mcp.js" -Destination $InstallDir -Force
Copy-Item "$ScriptDir\src\relay-hook.js" -Destination $InstallDir -Force
Copy-Item "$ScriptDir\src\switchboard-channel.js" -Destination $InstallDir -Force
Copy-Item "$ScriptDir\package.json" -Destination $InstallDir -Force

# Copy test files
$TestDir = Join-Path $InstallDir "test"
New-Item -ItemType Directory -Path $TestDir -Force | Out-Null
Copy-Item "$ScriptDir\test\*.js" -Destination $TestDir -Force

# Install npm dependencies
Push-Location $InstallDir
try {
    npm install --production
} finally {
    Pop-Location
}

# Register MCP servers (user-level)
try { claude mcp add switchboard node "$InstallDir\relay-mcp.js" -s user } catch { Write-Host "  switchboard: skipped (already registered or claude not found)" }
try { claude mcp add switchboard-channel node "$InstallDir\switchboard-channel.js" -s user } catch { Write-Host "  switchboard-channel: skipped (already registered or claude not found)" }

Write-Host ""
Write-Host "Installation complete."
Write-Host ""
Write-Host "Verify: claude mcp list"
Write-Host ""
Write-Host "Start an agent:"
Write-Host '  $env:RELAY_AGENT_ID = "<name>"'
Write-Host '  claude --dangerously-load-development-channels server:switchboard-channel'
