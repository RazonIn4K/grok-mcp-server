#!/bin/zsh

# Wrapper script to run Grok 4 MCP server with proper environment loading
# This ensures the X_AI_API_KEY from .zshrc is properly loaded

# Source the user's .zshrc to get X_AI_API_KEY
source ~/.zshrc

# Export it as XAI_API_KEY for the Grok server
export XAI_API_KEY="${X_AI_API_KEY}"

# Set other environment variables
export XAI_BASE_URL="https://api.x.ai/v1"
export GROK_MODEL="grok-4-1-fast-reasoning"
export GROK_TEMPERATURE="0.7"
export GROK_MAX_TOKENS="4000"

# Run the MCP server
exec node /Users/davidortiz/MCP-Servers/grok-4-mcp-server/dist/index.js