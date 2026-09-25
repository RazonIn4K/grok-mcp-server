# Grok MCP Server

An MCP server for xAI Grok chat, web search, and X search. Version 2.3.0 defaults both chat and search to **`grok-4.7`**, the latest public API flagship verified September 25, 2026. Explicit model overrides remain supported.

## Models and API compatibility

- `grok_ask` and `grok_chat` use Chat Completions with `low`, `medium`, `high`, or `xhigh` reasoning on Grok 4.7. The compatibility value `none` is omitted for models that cannot disable reasoning.
- `grok_search` and `grok_x_search` use the Responses API with built-in `web_search` / `x_search`. Search uses low reasoning to keep latency bounded.
- Search extracts final answer text and source citations; encrypted reasoning and tool payloads are excluded from displayed summaries.
- `grok_models` discovers models accessible to the configured API key. If discovery fails, it returns a static fallback catalog; this list alone is not proof of connectivity. Use `grok_test_connection` for a live inference probe.
- Image search and image understanding during web browsing are supported. Media generation and voice models can appear in the catalog, but this server does not expose image/video generation or voice tools.
- Grok 4.7 Fast is not available on the public xAI API. We use the documented `grok-4.7` slug, not an inferred alias.

Sources: [Grok 4.7 guide](https://docs.x.ai/developers/grok-4-7), [model catalog](https://docs.x.ai/developers/models), [release notes](https://docs.x.ai/developers/release-notes).

## Setup

Use Node.js **22.12+ on the 22.x line, or 24+** (Node 24 recommended), npm, and an xAI API key.

```sh
git clone https://github.com/RazonIn4K/grok-mcp-server.git
cd grok-mcp-server
npm ci
cp .env.example .env
# Edit .env with XAI_API_KEY and SHARED_SECRET.
npm run build
./start-grok-mcp.sh
```

The universal launcher works from any directory. It resolves credentials from the environment, `.env`, `.envrc`, Doppler, or supported shell export lines. Optional settings resolve from the environment, then `.env`, then server defaults. Existing model overrides must be updated or removed when upgrading. `run-with-env.sh` delegates to the same launcher.

### MCP client configuration

Use the absolute path to your checkout:

```json
{
  "mcpServers": {
    "grok": {
      "command": "/absolute/path/to/grok-mcp-server/start-grok-mcp.sh"
    }
  }
}
```

The launcher loads local credentials; do not put real API keys in committed client configuration. Set the client's tool timeout above 90 seconds (120 seconds recommended). Reconnect an existing MCP client after rebuilding so it loads the new server code and tool descriptions.

## Tools

| Tool | Purpose |
|------|---------|
| `grok_ask` | One question with optional context, system prompt, model, reasoning, and search |
| `grok_chat` | Multi-turn conversation with optional current search context |
| `grok_search` | Web search with citations; optional X, image search, and image understanding |
| `grok_x_search` | X-only search with cited posts |
| `grok_models` | Discover available model IDs |
| `grok_test_connection` | Uncached inference probe, bounded to 15 seconds |
| `grok_health` | Local process configuration, budgets, queue counts, and Prometheus metrics |

For ask/chat, setting `enable_image_search`, `enable_image_understanding`, or `include_x_search` also enables search context. `grok_search` accepts legacy `search_parameters` as compatibility inputs translated to Responses API tools/prompts; it does not call the retired legacy search endpoint.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `XAI_API_KEY` | Required | xAI API key |
| `SHARED_SECRET` | Required | Startup configuration requirement; not per-call stdio authentication |
| `GROK_MODEL` | `grok-4.7` | Ask/chat model |
| `GROK_SEARCH_MODEL` | `grok-4.7` | Web/X search model |
| `XAI_BASE_URL` | `https://api.x.ai/v1` | API endpoint; `GROK_BASE_URL` is also accepted |
| `GROK_TEMPERATURE` | `0.7` | Chat temperature |
| `GROK_MAX_TOKENS` | `4000` | Chat output token budget |
| `GROK_TIMEOUT_MS` | `45000` | Chat attempt timeout |
| `GROK_ASK_OVERALL_TIMEOUT_MS` | `90000` | Overall ask/chat budget, including search |
| `GROK_SEARCH_TIMEOUT_MS` | `45000` | Search attempt timeout |
| `GROK_SEARCH_OVERALL_TIMEOUT_MS` | `90000` | Overall search/fallback budget |
| `GROK_RETRIES` | `1` | Transient chat retries |
| `GROK_SEARCH_RETRIES` | `0` | Transient search retries |
| `GROK_RETRY_DELAY_MS` | `1000` | Initial retry delay |
| `GROK_MAX_CONCURRENT` | `2` | xAI concurrency limit |
| `GROK_MIN_TIME_MS` | `500` | Minimum interval between requests |
| `PERPLEXITY_API_KEY` | Unset | Optional fallback for web search only |
| `PERPLEXITY_MODEL` | `sonar-reasoning-pro` | Optional fallback model |
| `LOG_LEVEL` | `info` | Log verbosity |
| `NODE_ENV` | `production` in launcher | Log formatting |

Attempt timeouts are capped at 45 seconds, overall budgets at 90 seconds, and retries at one. Search-enabled answers reserve time for generation. Search failures return an explicit `DEGRADED` retry link; a successful X search with no matches returns zero results. Degraded links are not injected into answers as factual sources.

Responses use an LRU cache with a five-minute TTL; degraded responses have a shorter TTL. Connection probes bypass the cache. Logs go to stderr because stdout is reserved for MCP JSON-RPC.

## Development and verification

```sh
npm run build             # TypeScript compilation
npm test                  # Source unit/integration/property tests
npm run test:watch
npm run coverage
npm audit
sh -n start-grok-mcp.sh run-with-env.sh
```

The live smoke test exercises the actual MCP transport and makes paid xAI requests using local credentials. It fails on MCP errors, degraded search, missing citations, wrong model defaults, or invalid-input handling failures. It never prints credentials.

```sh
node test-api.mjs          # All seven tools, image search, search-enabled chat
node test-api.mjs --quick  # Discovery, health, models, inference, ask/chat, validation
# Optional existing HTTP gateway:
node test-api.mjs --url http://127.0.0.1:3002/mcp --quick
```

Set `EXPECTED_GROK_MODEL` and `EXPECTED_GROK_SEARCH_MODEL` when intentionally validating other configured defaults. The server itself uses stdio; an HTTP gateway is a separate service.

## Security and troubleshooting

The MCP client starts this server in a trusted local context. `SHARED_SECRET` is required at startup; the stdio protocol does not authenticate each tool call with it. Any HTTP gateway must enforce its own access controls. API credentials and common credential fields are redacted from error logs and tool errors. User prompt text is preserved, including code syntax and quoted search phrases; input shape is validated with Zod.

- **Wrong model after updating:** inspect `grok_health`, update environment overrides, rebuild, and reconnect the specific client. Running workers retain the code/configuration they started with.
- **Connection failure:** use `grok_test_connection`; local health and a fallback model list do not prove live inference works.
- **Timeout/degraded search:** check provider/network status and the client's tool timeout. Increasing configured timeouts does not bypass server caps.
- **Metrics:** `grok_health` returns request latency, request totals, and error totals. There is no built-in HTTP `/metrics` or `/health` endpoint.

## Changelog

### 2.3.0

- Default chat/search to Grok 4.7, update reasoning compatibility and search response parsing.
- Preserve source citations, correctly surface tool errors, and keep production logging off stdout.
- Preserve code/quoted prompt text and redact quoted credentials in errors.
- Bound queue waits and search-enabled chat generation within request budgets.
- Update MCP/runtime dependencies and patched test tooling; require a supported Node runtime.
- Add repeatable live MCP verification and correct launcher/environment documentation.

## License and support

MIT License. Report issues in [GitHub Issues](https://github.com/RazonIn4K/grok-mcp-server/issues).
