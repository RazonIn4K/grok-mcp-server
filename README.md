# Grok 4 MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with access to Grok 4's capabilities including chat completions, live search, and model management.

## Features

- **Chat Completions**: Interact with Grok 4 for conversational AI tasks
- **Live Search**: Real-time web search with structured results
- **Multi-Model Support**: Supports grok-4-1-fast-reasoning, grok-4-1-fast-non-reasoning, and grok-code-fast-1
- **Rate Limiting**: Built-in request throttling and circuit breaker patterns
- **Caching**: Intelligent response caching for improved performance
- **Metrics**: Prometheus metrics for monitoring and observability
- **Security**: Input validation, sanitization, and secure configuration

## Supported Models

| Model | Context Window | TPM | RPM | Input Price | Output Price | Use Case |
|-------|---------------:|----:|----:|------------:|-------------:|----------|
| grok-4-1-fast-reasoning | 2,000,000 | 4M | 480 | $0.20/M tokens | $0.50/M tokens | General reasoning tasks |
| grok-4-1-fast-non-reasoning | 2,000,000 | 4M | 480 | $0.20/M tokens | $0.50/M tokens | Fast, direct responses |
| grok-code-fast-1 | N/A | N/A | N/A | N/A | N/A | Code generation and analysis |

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
export GROK_MODEL="grok-4-1-fast-reasoning"  # or grok-4-1-fast-non-reasoning, grok-code-fast-1
export GROK_BASE_URL="https://api.x.ai/v1"  # Optional, defaults provided
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

- `grok_ask`: Ask Grok a question with optional context and search
- `grok_chat`: Multi-turn conversations with Grok
- `grok_search`: Live web search functionality
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
        "XAI_API_KEY": "your-key-here"
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
| `GROK_MODEL` | `grok-4-1-fast-reasoning` | Default model to use |
| `GROK_BASE_URL` | `https://api.x.ai/v1` | API endpoint URL |
| `GROK_TEMPERATURE` | `0.7` | Response creativity (0.0-1.0) |
| `GROK_MAX_TOKENS` | `4000` | Maximum response tokens |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `NODE_ENV` | `production` | Environment mode |

### Advanced Configuration

The server includes built-in resilience features:

- **Rate Limiting**: 2 concurrent requests, 500ms minimum interval
- **Circuit Breaker**: Automatic failure handling with fallback
- **Caching**: 5-minute TTL LRU cache for responses
- **Connection Pooling**: HTTP agent with keep-alive connections

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
2. **"Connection timeout"**: Check network connectivity and API endpoint URL
3. **"Rate limit exceeded"**: Implement client-side rate limiting or increase intervals
4. **"Model not available"**: Verify the model name is correct and supported

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
- MCP protocol implementation
- Multi-model support
- Comprehensive error handling and monitoring

---

*Built with ❤️ for the AI community*