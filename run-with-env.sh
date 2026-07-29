#!/bin/zsh

# Wrapper script to run Grok 4.5 MCP server with proper environment loading
# This ensures the X_AI_API_KEY from .zshrc is properly loaded

# Source the user's .zshrc to get XAI_API_KEY/SHARED_SECRET if present
source ~/.zshrc

# Export API key for the Grok server
if [ -n "$XAI_API_KEY" ]; then
  export XAI_API_KEY="${XAI_API_KEY}"
elif [ -n "$X_AI_API_KEY" ]; then
  export XAI_API_KEY="${X_AI_API_KEY}"
fi

# Ensure we are in the script's directory for relative .env etc.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load SHARED_SECRET from .env if not already set
if [ -z "$SHARED_SECRET" ] && [ -f ".env" ]; then
  ENV_SHARED=$(grep -E '^SHARED_SECRET=' .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  if [ -n "$ENV_SHARED" ]; then
    export SHARED_SECRET="$ENV_SHARED"
  fi
fi

if [ -z "$XAI_API_KEY" ]; then
  echo "ERROR: XAI_API_KEY not found. Set it in your shell or .env." >&2
  exit 1
fi

if [ -z "$SHARED_SECRET" ]; then
  echo "ERROR: SHARED_SECRET not found. Set it in your shell or .env." >&2
  exit 1
fi

# Set other environment variables
export XAI_BASE_URL="https://api.x.ai/v1"
export GROK_MODEL="grok-4.5"
export GROK_TEMPERATURE="0.7"
export GROK_MAX_TOKENS="4000"

# Run the MCP server
exec node "$SCRIPT_DIR/dist/index.js"
