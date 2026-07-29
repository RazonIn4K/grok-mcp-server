# Doppler Setup Guide for Grok 4.5 MCP Server

Doppler is the **recommended** way to manage secrets for the Grok MCP server. It keeps your API keys secure and out of config files.

## Current Configuration
- **Project**: `local-mac-work`
- **Config**: `dev`

## Quick Start

### 1. Verify Doppler is Installed

```bash
doppler --version
# Should show v3.x.x
```

If not installed:
```bash
brew install dopplerhq/cli/doppler
doppler login
```

### 2. Check Your Secrets

The required secrets should already be set in your `local-mac-work` project:

```bash
doppler secrets --project local-mac-work --config dev | grep -E '(XAI_API_KEY|SHARED_SECRET)'
```

Expected output:
```
│ SHARED_SECRET       │ your-shared-secret-here │
│ XAI_API_KEY         │ xai-your-api-key-here │
```

### 3. Add/Update Secrets (if needed)

```bash
# Add XAI API Key (REQUIRED)
doppler secrets set XAI_API_KEY "xai-your-api-key-here" --project local-mac-work --config dev

# Add Shared Secret (REQUIRED)
# Generate a secure secret: openssl rand -base64 32
doppler secrets set SHARED_SECRET "your-shared-secret" --project local-mac-work --config dev
```

### 4. Run the MCP Server

The launcher script automatically detects and uses Doppler:

```bash
./start-grok-mcp.sh
```

Or run directly with Doppler:

```bash
doppler run -- node dist/index.js
```

## How It Works

1. **`.doppler.yaml`** - Configures the project/config defaults
2. **`start-grok-mcp.sh`** - Auto-detects Doppler and fetches secrets
3. **`.envrc`** - Also supports Doppler for direnv users
4. **No secrets on disk** - Keys are fetched at runtime

### Priority Order for Secrets

The scripts resolve secrets in this order:
1. Environment variables (from MCP client config)
2. **Doppler** (local-mac-work/dev)
3. Shell config (~/.zshrc)
4. .env file
5. .envrc file

## MCP Client Configuration

For Claude Code, Cursor, or other MCP clients, use the launcher script:

```json
{
  "mcpServers": {
    "grok-4": {
      "command": "/full/path/to/your/grok-4-mcp-server/start-grok-mcp.sh",
      "args": [],
      "env": {}
    }
  }
}
```

The launcher handles Doppler integration automatically.

## Troubleshooting

**"Error: Project not found"**
```bash
doppler projects
```

**"Forbidden: Access denied"**
```bash
doppler login
```

**"Secrets not found"**
```bash
# List all secrets
doppler secrets --project local-mac-work --config dev

# Verify specific secret
doppler secrets get XAI_API_KEY --project local-mac-work --config dev --plain
```

**Override Doppler project/config**
```bash
DOPPLER_PROJECT=my-project DOPPLER_CONFIG=production ./start-grok-mcp.sh
```

## Alternative Configurations

### Different Doppler Config

To use a different config (e.g., `dev_personal`):

```bash
export DOPPLER_CONFIG=dev_personal
./start-grok-mcp.sh
```

Or update `.doppler.yaml`:
```yaml
setup:
  project: local-mac-work
  config: dev_personal
```

### Direct Doppler Run (without launcher)

```bash
doppler run --project local-mac-work --config dev -- node dist/index.js
```

## Security Notes

- Secrets are fetched at runtime, never stored in config files
- The shared secret provides authentication for MCP tool calls
- Doppler audit logs track secret access
