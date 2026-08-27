# Architecture

This repository's system map is an [Archify](https://tt-a1i.github.io/archify/) specification.

- Spec: `docs/archify/grok-mcp-architecture.json`
- Type: architecture (showcase)
- Captured: 2026-08-27

## Summary

grok-mcp-server is an MCP server that integrates xAI's Grok API with MCP clients like Cursor and Claude Code via stdio JSON-RPC. It exposes tools including grok_ask, grok_chat, grok_search, grok_x_search, grok_models, grok_test_connection, and grok_health. Authentication requires SHARED_SECRET at startup and XAI_API_KEY for upstream calls to api.x.ai/v1, with the default model being grok-4.5. When PERPLEXITY_API_KEY is configured, search requests can optionally fall back to Perplexity sonar-* models.

## Regenerate the interactive HTML

Do not commit the generated HTML (~700KB).

```bash
npx -y skills add tt-a1i/archify --skill archify --agent cursor --global --copy --yes
node bin/archify.mjs deliver architecture docs/archify/grok-mcp-architecture.json /tmp/grok-mcp.html --quality showcase
```
