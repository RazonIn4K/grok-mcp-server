#!/bin/bash

# Update MCP configuration for Claude Code with direnv support
# This script configures Claude Code to use the Grok 4 MCP server with your shell environment

echo "🔧 Updating Claude Code MCP configuration for Grok 4 with direnv..."

MCP_CONFIG_DIR="$HOME/.config/claude-code"
MCP_CONFIG_FILE="$MCP_CONFIG_DIR/mcp.json"

# Create config directory if it doesn't exist
mkdir -p "$MCP_CONFIG_DIR"

# Check if config file exists and has content
if [ -f "$MCP_CONFIG_FILE" ] && [ -s "$MCP_CONFIG_FILE" ]; then
    echo "📋 Existing MCP configuration found"
    # Create backup
    cp "$MCP_CONFIG_FILE" "$MCP_CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    echo "💾 Backup created"
fi

# Create MCP configuration that uses direnv
cat > "$MCP_CONFIG_FILE" << 'EOL'
{
  "mcpServers": {
    "grok-4": {
      "command": "bash",
      "args": ["-c", "cd /Users/davidortiz/MCP-Servers/grok-4-mcp-server && direnv exec . node dist/index.js"],
      "env": {}
    }
  }
}
EOL

echo "✅ Updated Claude Code MCP configuration: $MCP_CONFIG_FILE"
echo ""
echo "📝 Configuration Details:"
echo "   - Uses direnv to load environment from .envrc"
echo "   - Automatically picks up X_AI_API_KEY from your shell"
echo "   - No hardcoded API keys in configuration"
echo ""
echo "🎯 Next Steps:"
echo "   1. Restart Claude Code to load the new configuration"
echo "   2. Test with: grok_test_connection tool"
echo "   3. Start using: grok_ask, grok_search, grok_chat"
echo ""
echo "✅ Done! Your xAI API key from .zshrc will be used automatically via direnv"