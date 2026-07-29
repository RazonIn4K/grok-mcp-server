#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { GrokClient } from "./grok-client.js";
import { GrokConfig } from "./types.js";
import pino from "pino";
import {
  AppError,
  ValidationError,
  AuthError,
  ExternalServiceError,
} from "./errors.js";
import { z } from "zod";
import crypto from "crypto";
import client from "prom-client";

// Manual environment loading to avoid dotenv stdout pollution
function loadEnvironment() {
  // Suppress dotenv output globally
  if (!process.env.DOTENV_CONFIG_QUIET) {
    process.env.DOTENV_CONFIG_QUIET = "true";
  }

  try {
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            const value = valueParts.join("=").replace(/^["']|["']$/g, "");
            // Only set if not already defined (don't override existing env vars)
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      }
    }
  } catch (error) {
    // Silent fail - env file is optional
  }
}

loadEnvironment();

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            destination: 2, // stderr instead of stdout
          },
        }
      : {
          // In production (e.g. MCP stdio mode), write structured logs to stderr
          // to avoid polluting the JSON-RPC stdout protocol channel
          target: "pino/file",
          options: {
            destination: 2,
          },
        },
});

const requiredEnvVars = ["XAI_API_KEY", "SHARED_SECRET"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Error: ${envVar} environment variable is required`);
    process.exit(1);
  }
}

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

// Initialize Grok configuration
const rawBaseUrl =
  process.env.XAI_BASE_URL ||
  process.env.GROK_BASE_URL ||
  "https://api.x.ai/v1";
const baseUrl = normalizeBaseUrl(rawBaseUrl);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

const grokConfig: GrokConfig = {
  apiKey: process.env.XAI_API_KEY!,
  baseUrl,
  model: process.env.GROK_MODEL || "grok-4.5",
  temperature: parseFloat(process.env.GROK_TEMPERATURE || "0.7"),
  maxTokens: parseInt(process.env.GROK_MAX_TOKENS || "4000"),
  perplexityApiKey: process.env.PERPLEXITY_API_KEY,
  perplexityModel: process.env.PERPLEXITY_MODEL || "sonar-reasoning-pro",
  timeoutMs: parsePositiveInt(process.env.GROK_TIMEOUT_MS, 60000),
  searchTimeoutMs: parsePositiveInt(process.env.GROK_SEARCH_TIMEOUT_MS, 120000),
  retries: parsePositiveInt(process.env.GROK_RETRIES, 2),
  retryDelayMs: parsePositiveInt(process.env.GROK_RETRY_DELAY_MS, 1000),
  maxConcurrent: parsePositiveInt(process.env.GROK_MAX_CONCURRENT, 2),
  minTimeMs: parsePositiveInt(process.env.GROK_MIN_TIME_MS, 500),
};

const grokClient = new GrokClient(grokConfig);

const server = new Server(
  {
    name: process.env.MCP_SERVER_NAME || "grok-mcp-server",
    version: process.env.MCP_SERVER_VERSION || "2.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "grok_ask",
        description:
          "Ask Grok 4.5 a question with optional context and system prompt. Supports web search (with modern image understanding/search and X search options via enable_* / include_x_search flags).",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask Grok 4.5",
            },
            context: {
              type: "string",
              description: "Optional context to provide with the question",
            },
            system_prompt: {
              type: "string",
              description: "Optional system prompt to guide Grok's behavior",
            },
            temperature: {
              type: "number",
              description: "Temperature for response generation (0.0 to 1.0)",
              minimum: 0,
              maximum: 1,
            },
            max_tokens: {
              type: "number",
              description: "Maximum tokens in the response",
              minimum: 1,
              maximum: 8000,
            },
            include_search: {
              type: "boolean",
              description:
                "Include web search results for current information (use the modern search options below for image search / X search etc.)",
            },
            // Modern search options (used when include_search is true or these are set)
            enable_image_understanding: {
              type: "boolean",
              description: "When searching, enable image analysis during browsing",
            },
            enable_image_search: {
              type: "boolean",
              description: "When searching, enable image results (may embed images)",
            },
            include_x_search: {
              type: "boolean",
              description: "When searching, also include X/Twitter search results",
            },
            model: {
              type: "string",
              description: "Grok model to use (e.g., grok-4.5)",
            },
            reasoning_effort: {
              type: "string",
              enum: ["none", "low", "medium", "high"],
              description: "Reasoning effort for Grok chat responses",
            },
          },
          required: ["question"],
        },
      },
      {
        name: "grok_chat",
        description:
          "Have a multi-turn conversation with Grok 4.5 using the chat completion API. Supports optional web/X search context injection via include_search and modern flags.",
        inputSchema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Array of messages in the conversation",
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    enum: ["system", "user", "assistant"],
                    description: "Role of the message sender",
                  },
                  content: {
                    type: "string",
                    description: "Content of the message",
                  },
                },
                required: ["role", "content"],
              },
            },
            model: {
              type: "string",
              description: "Grok model to use (defaults to grok-4.5)",
            },
            reasoning_effort: {
              type: "string",
              enum: ["none", "low", "medium", "high"],
              description: "Reasoning effort for Grok chat responses",
            },
            temperature: {
              type: "number",
              description: "Temperature for response generation (0.0 to 1.0)",
              minimum: 0,
              maximum: 1,
            },
            max_tokens: {
              type: "number",
              description: "Maximum tokens in the response",
              minimum: 1,
              maximum: 8000,
            },
            // Search options for injecting context (searches on the last user message)
            include_search: {
              type: "boolean",
              description: "Inject recent web search results as context",
            },
            enable_image_understanding: {
              type: "boolean",
              description: "Enable image analysis in search context",
            },
            enable_image_search: {
              type: "boolean",
              description: "Enable image results in search context",
            },
            include_x_search: {
              type: "boolean",
              description: "Include X search in the injected context",
            },
          },
          required: ["messages"],
        },
      },
      {
        name: "grok_search",
        description:
          "Perform real-time web (and optionally X) search using Grok's Responses API built-in web_search / x_search tools. Supports modern options like image understanding/search and legacy search_parameters for compatibility.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to execute",
            },
            max_results: {
              type: "number",
              description: "Maximum number of search results to return",
              minimum: 1,
              maximum: 20,
            },
            include_news: {
              type: "boolean",
              description: "Include news articles in search results",
            },
            time_filter: {
              type: "string",
              enum: ["day", "week", "month", "year", "all"],
              description: "Filter results by time period",
            },
            // Modern options (recommended, map to Responses API web_search tool params)
            enable_image_understanding: {
              type: "boolean",
              description:
                "Enable Grok to analyze images found while browsing search results (Responses API feature)",
            },
            enable_image_search: {
              type: "boolean",
              description:
                "Enable image search results (images may be embedded in responses as Markdown)",
            },
            include_x_search: {
              type: "boolean",
              description:
                "Also perform X (Twitter) search using the x_search tool alongside web search",
            },
            // Legacy search_parameters (still supported for backward compatibility but deprecated in favor of top-level modern options + sources in search_parameters if needed)
            search_parameters: {
              type: "object",
              description:
                "Legacy search parameters (deprecated; prefer the new top-level fields above). Supports mode, sources, dates, etc. for compatibility.",
              properties: {
                mode: { type: "string", enum: ["auto", "on", "off"] },
                max_search_results: { type: "number" },
                from_date: { type: "string" },
                to_date: { type: "string" },
                return_citations: { type: "boolean" },
                sources: { type: "array" },
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "grok_models",
        description: "List available Grok models",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "grok_x_search",
        description:
          "Perform X (Twitter) search using Grok's x_search tool via Responses API. Returns recent posts, users, etc. with citations. Can be combined with web via grok_search's include_x_search.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "X search query",
            },
            max_results: {
              type: "number",
              description: "Max results",
              minimum: 1,
              maximum: 20,
            },
            // Can pass legacy style too, but focused on X
          },
          required: ["query"],
        },
      },
      {
        name: "grok_test_connection",
        description: "Test the connection to Grok API to verify setup",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "grok_health",
        description: "Check the health of the MCP server and its dependencies",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// List available prompts (empty for now)
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [],
  };
});

// List available resources (empty for now)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [],
  };
});

// Sanitize utility (basic example)
function sanitize(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/[<>"'`]/g, "");
  } else if (Array.isArray(obj)) {
    return obj.map(sanitize);
  } else if (obj && typeof obj === "object") {
    const clean: Record<string, any> = {};
    for (const k of Object.keys(obj)) {
      if (k.startsWith("$") || k.includes("__proto__")) continue;
      clean[k] = sanitize(obj[k]);
    }
    return clean;
  }
  return obj;
}

// Deprecated model tracking
const DEPRECATED_MODELS = new Set([
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-4-0709",
  "grok-code-fast-1",
  "grok-3",
  "grok-imagine-image-pro",
]);

const DEPRECATED_MODEL_REPLACEMENTS: Record<string, string> = {
  "grok-4-1-fast-reasoning": "grok-4.3",
  "grok-4-1-fast-non-reasoning": "grok-4.3",
  "grok-4-fast-reasoning": "grok-4.3",
  "grok-4-fast-non-reasoning": "grok-4.3",
  "grok-4-0709": "grok-4.3",
  "grok-code-fast-1": "grok-build-0.1",
  "grok-3": "grok-4.3",
  "grok-imagine-image-pro": "grok-imagine-image-quality",
};

function warnIfDeprecated(model: string | undefined): void {
  if (model && DEPRECATED_MODELS.has(model)) {
    logger.warn(
      { deprecatedModel: model, replacement: DEPRECATED_MODEL_REPLACEMENTS[model] },
      `Model "${model}" is deprecated and will be removed on May 15 2026. ` +
      `Use "${DEPRECATED_MODEL_REPLACEMENTS[model]}" instead.`,
    );
  }
}

// Prometheus metrics
const latencyHistogram = new client.Histogram({
  name: "grok_mcp_request_latency_seconds",
  help: "Request latency in seconds",
  labelNames: ["tool"],
});
const requestCounter = new client.Counter({
  name: "grok_mcp_requests_total",
  help: "Total number of tool requests",
  labelNames: ["tool"],
});
const errorCounter = new client.Counter({
  name: "grok_mcp_errors_total",
  help: "Total number of errors",
  labelNames: ["tool"],
});

// Safe wrappers for GrokClient methods with error handling
async function safeAsk(
  question: string,
  context?: string,
  systemPrompt?: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    includeSearch?: boolean;
    // modern search options
    enable_image_understanding?: boolean;
    enable_image_search?: boolean;
    include_x_search?: boolean;
    reasoningEffort?: "none" | "low" | "medium" | "high";
    model?: string;
  },
) {
  try {
    return await grokClient.ask(question, context, systemPrompt, options);
  } catch (err: any) {
    logger.error({ err }, "safeAsk error");
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message ? `Grok ask failed: ${err.message}` : "Grok ask failed",
      502,
      { cause: err },
    );
  }
}

async function safeChat(args: any) {
  try {
    return await grokClient.chatCompletion(args);
  } catch (err: any) {
    logger.error({ err }, "safeChat error");
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message ? `Grok chat failed: ${err.message}` : "Grok chat failed",
      502,
      { cause: err },
    );
  }
}

async function safeSearch(args: any) {
  try {
    return await grokClient.liveSearch(args);
  } catch (err: any) {
    logger.error({ err }, "safeSearch error");
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message
        ? `Grok search failed: ${err.message}`
        : "Grok search failed",
      502,
      { cause: err },
    );
  }
}

function handleError(error: any) {
  let message = "Internal server error";
  if (
    error instanceof ValidationError ||
    error instanceof AuthError ||
    error instanceof ExternalServiceError
  ) {
    message = error.message;
  } else if (error?.message) {
    message = error.message;
  }
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`,
      },
    ],
  };
}

// Extract the CallToolRequestSchema handler logic into a function
async function handleToolCall(request: any) {
  const name = request.params?.name ?? "unknown";
  const end = latencyHistogram.startTimer({ tool: name });
  requestCounter.inc({ tool: name });
  try {
    // Note: Authentication is handled at startup by requiring SHARED_SECRET env var.
    // MCP protocol doesn't pass auth tokens with tool calls - the server runs in a
    // trusted context started by the client with proper environment variables.
    const { arguments: args } = request.params;
    const safeArgs = sanitize(args);

    const serializedArgs = JSON.stringify(safeArgs || {});
    if (serializedArgs.length > 20000) {
      throw new ValidationError(
        "Request too large; please reduce payload size",
      );
    }

    switch (name) {
      case "grok_ask": {
        const grokAskSchema = z.object({
          question: z.string().min(1, "Question is required"),
          context: z.string().optional(),
          system_prompt: z.string().optional(),
          temperature: z.number().min(0).max(1).optional(),
          max_tokens: z.number().min(1).max(8000).optional(),
          include_search: z.boolean().optional(),
          // modern search flags (imply/include search)
          enable_image_understanding: z.boolean().optional(),
          enable_image_search: z.boolean().optional(),
          include_x_search: z.boolean().optional(),
          model: z.string().optional(),
          reasoning_effort: z
            .union([
              z.literal("none"),
              z.literal("low"),
              z.literal("medium"),
              z.literal("high"),
            ])
            .optional(),
        });
        const parsed = grokAskSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError("Invalid input for grok_ask", {
            issues: parsed.error.issues,
          });
        }
        warnIfDeprecated(parsed.data.model);
        const {
          question,
          context,
          system_prompt,
          temperature,
          max_tokens,
          include_search,
          enable_image_understanding,
          enable_image_search,
          include_x_search,
          model,
          reasoning_effort,
        } = parsed.data;
        const coercedMaxTokens =
          max_tokens !== undefined ? Math.floor(max_tokens) : undefined;
        const response = await safeAsk(question, context, system_prompt, {
          temperature,
          maxTokens: coercedMaxTokens,
          includeSearch: include_search,
          enable_image_understanding,
          enable_image_search,
          include_x_search,
          model,
          reasoningEffort: reasoning_effort,
        });
        end();
        return {
          content: [
            {
              type: "text",
              text: response,
            },
          ],
        };
      }
      case "grok_chat": {
        const grokChatSchema = z.object({
          messages: z.array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            }),
          ),
          model: z.string().optional(),
          reasoning_effort: z
            .union([
              z.literal("none"),
              z.literal("low"),
              z.literal("medium"),
              z.literal("high"),
            ])
            .optional(),
          temperature: z.number().min(0).max(1).optional(),
          max_tokens: z.number().min(1).max(8000).optional(),
          // Search injection options
          include_search: z.boolean().optional(),
          enable_image_understanding: z.boolean().optional(),
          enable_image_search: z.boolean().optional(),
          include_x_search: z.boolean().optional(),
        });
        const parsed = grokChatSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError("Invalid input for grok_chat", {
            issues: parsed.error.issues,
          });
        }
        warnIfDeprecated(parsed.data.model);
        const {
          messages,
          model,
          reasoning_effort,
          temperature,
          max_tokens,
          include_search,
          enable_image_understanding,
          enable_image_search,
          include_x_search,
        } = parsed.data;
        const coercedMaxTokens =
          max_tokens !== undefined ? Math.floor(max_tokens) : undefined;

        let chatMessages = [...messages];
        const shouldSearch =
          include_search ||
          enable_image_understanding ||
          enable_image_search ||
          include_x_search;
        if (shouldSearch) {
          // Find the last user message to search on
          const lastUserMsg = [...messages]
            .reverse()
            .find((m) => m.role === "user");
          const searchQuery = lastUserMsg?.content || "";
          if (searchQuery) {
            try {
              const searchResults = await safeSearch({
                query: searchQuery,
                max_results: 5,
                enable_image_understanding,
                enable_image_search,
                include_x_search,
              });
              if (searchResults.results.length > 0) {
                const searchContext = searchResults.results
                  .map(
                    (r: any, i: number) =>
                      `${i + 1}. [${r.title}](${r.url})\n${r.snippet}${
                        r.published_date ? ` (Published: ${r.published_date})` : ""
                      }`,
                  )
                  .join("\n\n");
                chatMessages = [
                  ...chatMessages,
                  {
                    role: "system" as const,
                    content: `Recent search results for context (use links for citations):\n\n${searchContext}`,
                  },
                ];
              }
            } catch (searchErr) {
              logger.warn(
                { err: searchErr },
                "Search injection failed for grok_chat, proceeding without",
              );
            }
          }
        }

        const response = await safeChat({
          messages: chatMessages,
          model,
          reasoning_effort,
          temperature,
          max_tokens: coercedMaxTokens,
        });
        const assistantMessage =
          response.choices[0]?.message?.content || "No response generated";
        end();
        return {
          content: [
            {
              type: "text",
              text: assistantMessage,
            },
          ],
        };
      }
      case "grok_search": {
        const grokSearchSourceSchema = z.object({
          type: z.enum(["web", "x", "news", "rss"]),
          max_results: z.number().int().positive().optional(),
          country: z.string().optional(),
          excluded_websites: z.array(z.string()).max(5).optional(),
          allowed_websites: z.array(z.string()).max(5).optional(),
        });
        const grokSearchParametersSchema = z.object({
          mode: z
            .union([z.literal("auto"), z.literal("on"), z.literal("off")])
            .optional(),
          sources: z.array(grokSearchSourceSchema).optional(),
          return_citations: z.boolean().optional(),
          max_search_results: z.number().int().positive().optional(),
          from_date: z.string().optional(),
          to_date: z.string().optional(),
        });
        const grokSearchSchema = z.object({
          query: z.string(),
          max_results: z.number().int().optional(), // ensure integer
          include_news: z.boolean().optional(),
          time_filter: z
            .enum(["day", "week", "month", "year", "all"])
            .optional(),
          // modern
          enable_image_understanding: z.boolean().optional(),
          enable_image_search: z.boolean().optional(),
          include_x_search: z.boolean().optional(),
          // legacy
          search_parameters: grokSearchParametersSchema.optional(),
        });
        // Coerce max_results to integer if needed
        if (safeArgs.max_results) {
          safeArgs.max_results = Math.floor(Number(safeArgs.max_results));
        }
        const parsed = grokSearchSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError("Invalid input for grok_search", {
            issues: parsed.error.issues,
          });
        }
        const {
          query,
          max_results,
          include_news,
          time_filter,
          search_parameters,
          enable_image_understanding,
          enable_image_search,
          include_x_search,
        } = parsed.data;

        if (search_parameters) {
          logger.warn(
            { query },
            "Using deprecated 'search_parameters' in grok_search. Prefer the new top-level options: enable_image_understanding, enable_image_search, include_x_search (and max_results etc). Legacy support will remain for now.",
          );
        }
        const searchResults = await safeSearch({
          query,
          max_results,
          include_news,
          time_filter,
          search_parameters,
          enable_image_understanding,
          enable_image_search,
          include_x_search,
        });
        const formattedResults = searchResults.results
          .map(
            (result, index) =>
              `${index + 1}. [${result.title}](${result.url})\n${result.snippet}${result.published_date ? `\nPublished: ${result.published_date}` : ""}`,
          )
          .join("\n\n");

        // Build a clean sources list for citations
        const sourcesList = searchResults.results
          .map((r, i) => `${i + 1}. [${r.title}](${r.url})`)
          .join("\n");

        const outputText = `Search Results for "${query}" (${searchResults.total_results} results found in ${searchResults.search_time}s):\n\n${formattedResults}\n\nSources:\n${sourcesList || "No direct sources returned."}`;

        end();
        return {
          content: [
            {
              type: "text",
              text: outputText,
            },
          ],
        };
      }
      case "grok_x_search": {
        // Dedicated X search - forces include_x_search
        const xSearchSchema = z.object({
          query: z.string(),
          max_results: z.number().int().optional(),
        });
        const parsedX = xSearchSchema.safeParse(safeArgs);
        if (!parsedX.success) {
          throw new ValidationError("Invalid input for grok_x_search", {
            issues: parsedX.error.issues,
          });
        }
        const { query: xQuery, max_results: xMax } = parsedX.data;
        const xSearchResults = await safeSearch({
          query: xQuery,
          max_results: xMax,
          include_x_search: true,
          search_web: false,
        });
        const xFormatted = xSearchResults.results
          .map(
            (result: any, index: number) =>
              `${index + 1}. [${result.title}](${result.url})\n${result.snippet}${
                result.published_date ? `\nPublished: ${result.published_date}` : ""
              }`,
          )
          .join("\n\n");
        const xSources = xSearchResults.results
          .map((r: any, i: number) => `${i + 1}. [${r.title}](${r.url})`)
          .join("\n");
        end();
        return {
          content: [
            {
              type: "text",
              text: `X Search Results for "${xQuery}" (${xSearchResults.total_results} results in ${xSearchResults.search_time}s):\n\n${xFormatted}\n\nSources:\n${xSources || "No sources."}`,
            },
          ],
        };
      }
      case "grok_health": {
        let metricsText: string;
        try {
          metricsText = await client.register.metrics();
        } catch (metricsError) {
          metricsText = `Error collecting metrics: ${(metricsError as Error).message}`;
        }
        end();
        return {
          content: [
            { type: "text", text: "OK: Grok MCP Server healthy" },
            { type: "text", text: metricsText },
          ],
        };
      }
      case "grok_models": {
        const models = await grokClient.getModels();
        end();
        return {
          content: [
            {
              type: "text",
              text: `Available Grok models:\n${models.map((model) => `- ${model}`).join("\n")}`,
            },
          ],
        };
      }
      case "grok_test_connection": {
        const isConnected = await grokClient.testConnection();
        end();
        return {
          content: [
            {
              type: "text",
              text: isConnected
                ? "✅ Grok API connection successful! Ready to use Grok 4.5."
                : "❌ Grok API connection failed. Please check your API key and configuration.",
            },
          ],
        };
      }
      default:
        end();
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown tool: ${name}`,
            },
          ],
        };
    }
  } catch (error) {
    errorCounter.inc({ tool: name });
    end();
    return handleError(error);
  }
}

// Use handleToolCall in the server's setRequestHandler
server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("🎯 Grok 4.5 MCP Server running and ready!");
}

// Start the server only if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  });
}

// Export for testing
export { server, handleToolCall, grokClient };
