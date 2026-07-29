# Grok 4.5 MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with access to Grok 4.5 capabilities including chat completions, web search (via Responses API), and model management.

## Features

- **Chat Completions**: Interact with Grok 4.5 for conversational AI tasks
- **Web Search**: Real-time web (and X) search with Responses API `web_search` / `x_search` tools, modern options (image understanding/search), plus legacy `search_parameters` compatibility for the `grok_search` tool
- **Multi-Model Support**: Defaults to Grok 4.5 and supports Grok 4.3/grok-latest legacy aliases, Grok Build 0.1, and Grok Imagine/Voice APIs
- **Rate Limiting**: Built-in request throttling and circuit breaker patterns
- **Caching**: Intelligent response caching for improved performance
- **Metrics**: Prometheus metrics for monitoring and observability
- **Security**: Input validation, sanitization, and secure configuration

## Supported Models

| Model | Context Window | Tier 0 TPM | Tier 0 RPS | Input Price | Output Price | Use Case |
|-------|---------------:|-----------:|-----------:|------------:|-------------:|----------|
| grok-4.5 | 500,000 | 50M | 150 | $2.00/M | $6.00/M | Default for code, chat, reasoning, and tool use |
| grok-4.5-latest | 500,000 | 50M | 150 | $2.00/M | $6.00/M | Latest Grok 4.5 alias |
| grok-4.3 | 1,000,000 | 10M | 37 | $1.25/M | $2.50/M | Legacy redirect target for retired text slugs |
| grok-latest | 1,000,000 | 10M | 37 | $1.25/M | $2.50/M | Legacy alias for Grok 4.3 |
| grok-4.20 | 1,000,000 | 10M | 37 | N/A | N/A | Legacy reasoning and general chat |
| grok-build-0.1 | 256K | 10M | 37 | $1.00/M | $2.00/M | Code generation and agentic workflows |
| grok-imagine-image | N/A | N/A | N/A | N/A | N/A | Image generation |
| grok-voice-think-fast-1.0 | N/A | N/A | N/A | N/A | N/A | Voice workflows |

## Installation

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- xAI API key

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd grok-4-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .envrc
```

Edit `.envrc` with your configuration:
```bash
export XAI_API_KEY="your-xai-api-key-here"
export SHARED_SECRET="your-shared-secret-here"
export GROK_MODEL="grok-4.5"
export GROK_BASE_URL="https://api.x.ai/v1"  # Optional; accepts https://api.x.ai and appends /v1 (XAI_BASE_URL also accepted)
export GROK_TEMPERATURE="0.7"              # Optional, 0.0-1.0
export GROK_MAX_TOKENS="4000"              # Optional
export MCP_SERVER_NAME="grok-4-mcp-server" # Optional
export MCP_SERVER_VERSION="1.0.0"          # Optional
```

4. Load environment variables:
```bash
direnv allow  # If using direnv
# or
source .envrc
```

5. Build the project:
```bash
npm run build
```

## Usage

### Direct Execution

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### MCP Integration

The server implements the Model Context Protocol and can be integrated with any MCP-compatible client. It exposes the following tools:

- `grok_ask`: Ask Grok a question with optional context and web search context
- `grok_chat`: Multi-turn conversations with Grok
- `grok_search`: Web (and optional X) search powered by Responses API `web_search`/`x_search` tools, with image understanding/search support and legacy compat
- `grok_x_search`: Dedicated X/Twitter search via the x_search tool
- `grok_ask` / `grok_chat`: Support `include_search` + modern flags for injecting search context (with images/X)
- `grok_models`: List available Grok models
- `grok_test_connection`: Test API connectivity
- `grok_health`: Server health check and metrics

### Example MCP Client Configuration

```json
{
  "mcpServers": {
    "grok": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "XAI_API_KEY": "your-key-here",
        "SHARED_SECRET": "your-shared-secret-here"
      }
    }
  }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | *Required* | Your xAI API key |
| `SHARED_SECRET` | *Required* | Shared secret used to authenticate MCP requests |
| `GROK_MODEL` | `grok-4.5` | Default model to use |
| `GROK_BASE_URL` | `https://api.x.ai/v1` | API endpoint URL (accepts `https://api.x.ai` and appends `/v1`; `XAI_BASE_URL` also accepted) |
| `GROK_TEMPERATURE` | `0.7` | Response creativity (0.0-1.0) |
| `GROK_MAX_TOKENS` | `4000` | Maximum response tokens |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `NODE_ENV` | `production` | Environment mode |
| `GROK_TIMEOUT_MS` | `60000` | Request timeout for chat completions (milliseconds) |
| `GROK_SEARCH_TIMEOUT_MS` | `120000` | Request timeout for live search / Responses API calls (milliseconds) |
| `GROK_RETRIES` | `2` | Number of retries for transient failures (network errors, 5xx, 429) |
| `GROK_RETRY_DELAY_MS` | `1000` | Base delay between retries; doubles with each attempt (milliseconds) |
| `GROK_MAX_CONCURRENT` | `2` | Maximum concurrent requests to the xAI API |
| `GROK_MIN_TIME_MS` | `500` | Minimum interval between requests to the xAI API (milliseconds) |

### Advanced Configuration

The server includes built-in resilience features:

- **Configurable Timeouts**: Separate timeouts for chat and search/Responses API calls.
- **Retries with Backoff**: Transient failures (network errors, 5xx, 429) are retried up to `GROK_RETRIES` times with exponential backoff.
- **Rate Limiting**: Configurable concurrency and minimum interval (`GROK_MAX_CONCURRENT`, `GROK_MIN_TIME_MS`).
- **Caching**: 5-minute TTL LRU cache for responses.
- **Connection Pooling**: HTTP agent with keep-alive connections.

## Development

### Testing

```bash
npm test
npm run test:watch
```

### Linting

```bash
npm run lint
npm run lint:fix
```

### Type Checking

```bash
npm run type-check
```

### Building

```bash
npm run build
npm run clean
```

## Security Considerations

- **API Key Protection**: Never commit API keys to version control
- **Input Validation**: All inputs are validated and sanitized
- **Rate Limiting**: Prevents abuse and ensures fair usage
- **Error Handling**: Sensitive information is not exposed in error messages
- **Logging**: Configurable log levels prevent sensitive data leakage

## Monitoring

The server exposes Prometheus metrics at `/metrics` (when health endpoint is called):

- Request latency histograms
- Request counters by tool
- Error counters
- Cache hit/miss ratios

## Troubleshooting

### Common Issues

1. **"API key not found"**: Ensure `XAI_API_KEY` is set in your environment
2. **"Connection timeout" / request timeouts**: Increase `GROK_TIMEOUT_MS` (default 60s) for long reasoning requests and `GROK_SEARCH_TIMEOUT_MS` (default 120s) for live search. Also check network connectivity and the API endpoint URL.
3. **"Rate limit exceeded"**: Implement client-side rate limiting or increase intervals
4. **"Model not available"**: Verify the model name is correct and supported; retired slugs now alias to current models

### Debug Mode

Enable verbose logging:
```bash
export LOG_LEVEL=debug
export NODE_ENV=development
```

### Health Check

Test server connectivity:
```bash
curl -X POST localhost:3000/health
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

### Development Guidelines

- Follow TypeScript best practices
- Add comprehensive tests
- Update documentation for API changes
- Use conventional commit messages
- Ensure compatibility with Node.js >= 18

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- Issues: [GitHub Issues](https://github.com/your-repo/issues)
- Documentation: [Full Docs](https://docs.example.com)
- Community: [Discord/Slack]

## Changelog

### v1.0.0
- Initial release with Grok 4 support
- Updated default model to Grok 4.5
- MCP protocol implementation
- Multi-model support
- Comprehensive error handling and monitoring

---

*Built with ❤️ for the AI community*
