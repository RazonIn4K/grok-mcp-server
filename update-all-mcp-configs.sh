#!/bin/sh
# Update MCP configurations for all clients
# Supports: Claude Code, Cursor, Claude Desktop, Codex, Gemini CLI, Windsurf, etc.

set -e

echo "🔧 Updating MCP configurations for Grok 4.5 server..."
echo ""

# Compute PROJECT_DIR relative to this script (portable)
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$PROJECT_DIR/start-grok-mcp.sh"

# Ensure launcher exists and is executable
if [ ! -f "$LAUNCHER" ]; then
    echo "❌ Launcher script not found: $LAUNCHER"
    exit 1
fi
chmod +x "$LAUNCHER"

# Correct tool names for alwaysAllow
TOOLS='["grok_ask", "grok_chat", "grok_search", "grok_models", "grok_test_connection", "grok_health"]'

backup_config() {
    local file="$1"
    if [ -f "$file" ]; then
        cp "$file" "${file}.backup.$(date +%Y%m%d_%H%M%S)"
        echo "  💾 Backed up: $file"
    fi
}

# Function to update or add grok config using Python (more reliable JSON handling)
update_config() {
    local config_file="$1"
    local config_dir=$(dirname "$config_file")

    # Create directory if needed
    mkdir -p "$config_dir"

    # Create or update using Python for reliable JSON handling
    python3 << EOF
import json
import os

config_file = "$config_file"
launcher = "$LAUNCHER"

# Default MCP config structure
default_config = {"mcpServers": {}}

# Load existing config or create new
if os.path.exists(config_file):
    try:
        with open(config_file, 'r') as f:
            config = json.load(f)
    except:
        config = default_config
else:
    config = default_config

# Ensure mcpServers exists
if "mcpServers" not in config:
    config["mcpServers"] = {}

# Update grok server config (using "grok" key to match common usage).
# Merge with any existing entry to preserve client-specific fields like
# working_directory, start_on_launch, env.PATH, transport, etc.
existing_grok = config["mcpServers"].get("grok", {}) if "grok" in config["mcpServers"] else {}
config["mcpServers"]["grok"] = {
    **existing_grok,
    "command": launcher,
    "args": [],
    "alwaysAllow": [
        "grok_ask",
        "grok_chat",
        "grok_search",
        "grok_models",
        "grok_test_connection",
        "grok_health"
    ]
}
# Ensure env is a dict (don't wipe a pre-existing one unless empty)
if "env" not in config["mcpServers"]["grok"] or not config["mcpServers"]["grok"].get("env"):
    config["mcpServers"]["grok"]["env"] = existing_grok.get("env", {})

# If a working_directory was present (or we want to ensure consistency), normalize it
if "working_directory" in config["mcpServers"]["grok"]:
    wd = config["mcpServers"]["grok"]["working_directory"]
    if "MCP-Servers/grok-4-mcp-server" in wd or not wd:
        config["mcpServers"]["grok"]["working_directory"] = "$PROJECT_DIR"

# Write updated config
with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')

print(f"  ✅ Updated: {config_file}")
EOF
}

echo "📁 Updating Claude Code config..."
backup_config "$HOME/.config/claude-code/mcp.json"
update_config "$HOME/.config/claude-code/mcp.json"

echo ""
echo "📁 Updating Cursor config..."
backup_config "$HOME/.cursor/mcp.json"
update_config "$HOME/.cursor/mcp.json"

echo ""
echo "📁 Updating Claude Desktop config..."
backup_config "$HOME/.claude/claude_desktop_config.json"
update_config "$HOME/.claude/claude_desktop_config.json"

# Also update the actual macOS Claude Desktop location (Library/Application Support)
if [[ "$OSTYPE" == darwin* ]]; then
  CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  if [ -f "$CLAUDE_DESKTOP_CONFIG" ] || [ -d "$(dirname "$CLAUDE_DESKTOP_CONFIG")" ]; then
    echo "📁 Updating macOS Claude Desktop config (Library)..."
    backup_config "$CLAUDE_DESKTOP_CONFIG"
    update_config "$CLAUDE_DESKTOP_CONFIG"
  fi
fi

echo ""
echo "📁 Updating global Claude config..."
backup_config "$HOME/.claude.json"
update_config "$HOME/.claude.json"

echo ""
echo "📁 Checking for VS Code MCP config..."
VSCODE_MCP="$HOME/.vscode/mcp.json"
if [ -d "$HOME/.vscode" ]; then
    backup_config "$VSCODE_MCP"
    update_config "$VSCODE_MCP"
fi

echo ""
echo "📁 Checking for Windsurf config..."
WINDSURF_MCP="$HOME/.codeium/windsurf/mcp_config.json"
if [ -d "$HOME/.codeium/windsurf" ]; then
    backup_config "$WINDSURF_MCP"
    update_config "$WINDSURF_MCP"
fi

echo ""
echo "📁 Checking for Gemini CLI config..."
GEMINI_MCP="$HOME/.config/gemini/mcp.json"
if [ -f "$GEMINI_MCP" ] || [ -d "$(dirname "$GEMINI_MCP")" ]; then
    backup_config "$GEMINI_MCP"
    update_config "$GEMINI_MCP"
fi

echo ""
echo "📁 Checking for WarpAI config..."
WARPAI_MCP="$HOME/.config/warpai/mcp_config.json"
if [ -f "$WARPAI_MCP" ] || [ -d "$(dirname "$WARPAI_MCP")" ]; then
    backup_config "$WARPAI_MCP"
    update_config "$WARPAI_MCP"
fi

echo ""
echo "📁 Checking for generic MCP config..."
GENERIC_MCP="$HOME/.config/mcp/config.json"
if [ -f "$GENERIC_MCP" ] || [ -d "$(dirname "$GENERIC_MCP")" ]; then
    backup_config "$GENERIC_MCP"
    update_config "$GENERIC_MCP"
fi

echo ""
echo "📁 Checking for Zed editor config..."
ZED_MCP="$HOME/.config/zed/settings.json"
if [ -f "$ZED_MCP" ]; then
    # Zed uses context_servers.grok structure; the generic updater may not perfectly match but we at least back it up
    backup_config "$ZED_MCP"
    # For Zed we do a lightweight in-place fix for the command if present
    python3 -c "
import json, sys
p = '$ZED_MCP'
with open(p) as f: d = json.load(f)
changed = False
cs = d.get('context_servers', {})
if 'grok' in cs and isinstance(cs['grok'], dict):
    if 'command' in cs['grok'] and 'MCP-Servers/grok-4-mcp-server' in cs['grok']['command']:
        cs['grok']['command'] = '$LAUNCHER'
        changed = True
if changed:
    with open(p, 'w') as f: json.dump(d, f, indent=2)
    print('  ✅ Updated Zed context_servers.grok command')
else:
    print('  (Zed grok entry not present or already current)')
" || true
fi

# Claude-3p / other Claude variants in Library
if [[ "$OSTYPE" == darwin* ]]; then
  for variant in "Claude-3p" "Claude"; do
    VARIANT_CONFIG="$HOME/Library/Application Support/$variant/claude_desktop_config.json"
    if [ -f "$VARIANT_CONFIG" ]; then
      echo "📁 Checking $variant desktop config..."
      backup_config "$VARIANT_CONFIG"
      update_config "$VARIANT_CONFIG"
    fi
  done
fi

echo ""
echo "=========================================="
echo "✅ All MCP configurations updated!"
echo ""
echo "🎯 Next Steps:"
echo "   1. Set your XAI API key and SHARED_SECRET (if not already done):"
echo "      Option A - Doppler:"
echo "        doppler secrets set XAI_API_KEY 'xai-your-key' --project local-mac-work --config dev"
echo "        doppler secrets set SHARED_SECRET 'your-shared-secret' --project local-mac-work --config dev"
echo ""
echo "      Option B - Environment variable (add to ~/.zshrc or ~/.bashrc):"
echo "        export XAI_API_KEY='xai-your-key'"
echo "        export SHARED_SECRET='your-shared-secret'"
echo ""
echo "      Option C - .env file:"
echo "        echo 'XAI_API_KEY=xai-your-key' > $PROJECT_DIR/.env"
echo "        echo 'SHARED_SECRET=your-shared-secret' >> $PROJECT_DIR/.env"
echo ""
echo "   2. Restart your IDE/coding agent to load the new config"
echo ""
echo "   3. Test the connection with grok_test_connection tool"
echo ""
echo "📋 Available tools:"
echo "   - grok_ask       : Ask questions with optional context"
echo "   - grok_chat      : Multi-turn conversations"
echo "   - grok_search    : Live web search"
echo "   - grok_models    : List available models"
echo "   - grok_test_connection : Verify API connectivity"
echo "   - grok_health    : Server health check"
