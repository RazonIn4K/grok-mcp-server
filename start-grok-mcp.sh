#!/bin/sh
# Universal Grok MCP Server Launcher
# Works with bash, zsh, sh, and any POSIX-compliant shell
# Compatible with all MCP clients: Claude Code, Cursor, Codex, Gemini CLI, etc.
#
# Priority order for secrets:
#   1. Environment variables (from MCP client config)
#   2. Local .env file
#   3. Local .envrc file
#   4. Doppler (local-mac-work/dev project)
#   5. Shell config (~/.zshrc)
#
# Local sources are checked before network-backed Doppler so MCP startup is
# deterministic when the repository already has its credentials configured.

set -e

# Prevent any output to stdout (reserved for JSON-RPC)
exec 3>&1 1>&2

# Change to project directory (portable - script can be invoked from anywhere)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Doppler project/config settings
DOPPLER_PROJECT="${DOPPLER_PROJECT:-local-mac-work}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-dev}"

# Try multiple sources for XAI_API_KEY in order of preference:

# 1. Already set in environment (from MCP client config)
if [ -n "$XAI_API_KEY" ]; then
    : # Already set, use it

# 2. Check for X_AI_API_KEY variant (some configs use this)
elif [ -n "$X_AI_API_KEY" ]; then
    export XAI_API_KEY="$X_AI_API_KEY"

# 3. Try .env file in project directory
elif [ -f ".env" ]; then
    ENV_KEY=$(grep -E '^XAI_API_KEY=' .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$ENV_KEY" ]; then
        export XAI_API_KEY="$ENV_KEY"
    fi
fi

# 4. Try .envrc file
if [ -z "$XAI_API_KEY" ] && [ -f ".envrc" ]; then
    ENVRC_KEY=$(grep -E '^[[:space:]]*(export[[:space:]]+)?XAI_API_KEY=' .envrc 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$ENVRC_KEY" ]; then
        export XAI_API_KEY="$ENVRC_KEY"
    fi
fi

# 5. Try Doppler when no local source is available
if [ -z "$XAI_API_KEY" ] && command -v doppler >/dev/null 2>&1; then
    DOPPLER_KEY=$(doppler secrets get XAI_API_KEY --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || true)
    if [ -n "$DOPPLER_KEY" ] && echo "$DOPPLER_KEY" | grep -q '^xai-'; then
        export XAI_API_KEY="$DOPPLER_KEY"
        # Also get SHARED_SECRET from Doppler
        DOPPLER_SECRET=$(doppler secrets get SHARED_SECRET --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || true)
        if [ -n "$DOPPLER_SECRET" ]; then
            export SHARED_SECRET="$DOPPLER_SECRET"
        fi
    fi
fi

# 6. Try to read an exported key from zsh config
if [ -z "$XAI_API_KEY" ] && [ -f "$HOME/.zshrc" ]; then
    # Extract just the API key export lines without running the full zshrc
    X_AI_KEY=$(grep -E '^export X_AI_API_KEY=' "$HOME/.zshrc" 2>/dev/null | tail -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ')
    XAI_KEY=$(grep -E '^export XAI_API_KEY=' "$HOME/.zshrc" 2>/dev/null | tail -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ')

    if [ -n "$XAI_KEY" ]; then
        export XAI_API_KEY="$XAI_KEY"
    elif [ -n "$X_AI_KEY" ]; then
        export XAI_API_KEY="$X_AI_KEY"
    fi
fi

# Validate API key
if [ -z "$XAI_API_KEY" ]; then
    echo "ERROR: XAI_API_KEY not found. Please set it via one of these methods:" >&2
    echo "" >&2
    echo "  1. Add to ~/.zshrc:" >&2
    echo "     export XAI_API_KEY='xai-your-key-here'" >&2
    echo "     # OR" >&2
    echo "     export X_AI_API_KEY='xai-your-key-here'" >&2
    echo "" >&2
    echo "  2. Create .env file in project directory:" >&2
    echo "     echo 'XAI_API_KEY=xai-your-key-here' > .env" >&2
    echo "     (run from the grok-4-mcp-server directory)" >&2
    echo "" >&2
    echo "  3. Set in MCP client config env section" >&2
    echo "" >&2
    echo "  4. Use Doppler:" >&2
    echo "     doppler secrets set XAI_API_KEY 'xai-your-key' --project local-mac-work --config dev" >&2
    exit 1
fi

# Check for placeholder values
if echo "$XAI_API_KEY" | grep -qiE 'your.*key|placeholder|example|xxxx'; then
    echo "ERROR: XAI_API_KEY appears to be a placeholder value." >&2
    echo "Please set a real xAI API key." >&2
    exit 1
fi

# Validate key format (should start with xai-)
if ! echo "$XAI_API_KEY" | grep -q '^xai-'; then
    echo "WARNING: XAI_API_KEY doesn't start with 'xai-'. This may not be a valid xAI key." >&2
fi

# Resolve SHARED_SECRET locally first for deterministic startup
if [ -z "$SHARED_SECRET" ] && [ -f ".env" ]; then
    ENV_SHARED=$(grep -E '^SHARED_SECRET=' .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$ENV_SHARED" ]; then
        export SHARED_SECRET="$ENV_SHARED"
    fi
fi

if [ -z "$SHARED_SECRET" ] && [ -f ".envrc" ]; then
    ENVRC_SHARED=$(grep -E '^[[:space:]]*(export[[:space:]]+)?SHARED_SECRET=' .envrc 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$ENVRC_SHARED" ]; then
        export SHARED_SECRET="$ENVRC_SHARED"
    fi
fi

# Fall back to network-backed Doppler
if [ -z "$SHARED_SECRET" ] && command -v doppler >/dev/null 2>&1; then
    DOPPLER_SECRET=$(doppler secrets get SHARED_SECRET --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || true)
    if [ -n "$DOPPLER_SECRET" ]; then
        export SHARED_SECRET="$DOPPLER_SECRET"
    fi
fi

if [ -z "$SHARED_SECRET" ]; then
    echo "ERROR: SHARED_SECRET not found. Set it via one of these methods:" >&2
    echo "" >&2
    echo "  1. Doppler (recommended):" >&2
    echo "     doppler secrets set SHARED_SECRET 'your-secret' --project $DOPPLER_PROJECT --config $DOPPLER_CONFIG" >&2
    echo "" >&2
    echo "  2. Environment variable or .env file" >&2
    exit 1
fi

# Optional model/API settings are resolved by the server from the environment,
# then .env, then compiled defaults. Do not mask .env overrides here.
export LOG_LEVEL="${LOG_LEVEL:-info}"
export NODE_ENV="${NODE_ENV:-production}"

# Suppress dotenv output
export DOTENV_CONFIG_QUIET=true

# Restore stdout for the server (JSON-RPC channel)
exec 1>&3 3>&-

# Start the MCP server
exec node dist/index.js
