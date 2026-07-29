# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that integrates xAI's Grok 4.5 AI model with Codex and other MCP-compatible applications. The server provides tools for chat completion, live search, and function calling capabilities.

## Development Commands

### Build and Development
- `npm run build` - Compile TypeScript to JavaScript in `dist/` directory
- `npm run dev` - Run the server in development mode with tsx
- `npm start` - Start the compiled server from `dist/index.js`
- `npm run clean` - Remove the `dist/` directory

### Testing
- `npm test` - Run all tests using Vitest
- `npm run test:watch` - Run tests in watch mode
- `npm run coverage` - Generate test coverage report

### Environment Setup
- Copy `.env.example` to `.env` and configure:
  - `XAI_API_KEY` - Required xAI API key (starts with `xai-`)
  - `SHARED_SECRET` - Required shared secret used for MCP auth
  - `XAI_BASE_URL` - API base URL (defaults to `https://api.x.ai/v1`)
  - `GROK_MODEL` - Model to use (defaults to `grok-4.5`)

## Architecture

### Core Components

**Main Server (`src/index.ts`)**: MCP server implementation using `@modelcontextprotocol/sdk`. Handles tool registration and request routing with comprehensive error handling, authentication, metrics collection, and input sanitization.

**Grok Client (`src/grok-client.ts`)**: HTTP client for xAI Grok API with features:
- LRU caching (5-minute TTL)
- Rate limiting (2 concurrent requests, 500ms intervals)
- Connection pooling with keep-alive
- Fallback search simulation when live search unavailable

**Type Definitions (`src/types.ts`)**: TypeScript interfaces for Grok API requests/responses, including chat completion, search, and configuration types.

**Error Handling (`src/errors.ts`)**: Custom error hierarchy with `AppError`, `ValidationError`, `AuthError`, and `ExternalServiceError` classes.

### Available MCP Tools

1. **grok_ask** - Ask Grok questions with optional context, system prompts, and live search (supports modern image understanding/search + X search flags)
2. **grok_chat** - Multi-turn conversations using chat completion API (now supports include_search + modern flags for context injection)
3. **grok_search** - Live web (and optional X) search using modern Responses API `web_search`/`x_search` tools, with image support and legacy `search_parameters` compat
4. **grok_x_search** - Dedicated X/Twitter search via Responses API x_search tool
5. **grok_models** - List available Grok models
6. **grok_test_connection** - Verify API connectivity
7. **grok_health** - Check server health and metrics

### Key Features

- **Authentication**: Shared secret validation with timing-safe comparison
- **Input Sanitization**: Recursive sanitization of user inputs
- **Monitoring**: Prometheus metrics for latency, request counts, and errors
- **Caching**: LRU cache for API responses to reduce costs
- **Rate Limiting**: Bottleneck library prevents API abuse
- **Graceful Degradation**: Search simulation when live search unavailable

### Dependencies

- **Runtime**: `@modelcontextprotocol/sdk`, `axios`, `dotenv`, `pino`
- **Performance**: `lru-cache`, `bottleneck`, `agentkeepalive`
- **Monitoring**: `prom-client`, `opossum`
- **Validation**: `zod`
- **Testing**: `vitest`, `@vitest/coverage-v8`

## Testing Strategy

The codebase uses Vitest for testing with coverage reporting. Test files include:
- Unit tests for error classes
- Integration tests for the Grok client
- Authentication/sanitization tests
- Server integration tests

Run tests before deploying to ensure API integration and error handling work correctly.
