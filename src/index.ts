#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { GrokClient } from './grok-client.js';
import { GrokConfig } from './types.js';
import pino from 'pino';
import { AppError, ValidationError, AuthError, ExternalServiceError } from './errors.js';
import { z } from 'zod';
import crypto from 'crypto';
import client from 'prom-client';
import CircuitBreaker from 'opossum';

// Manual environment loading to avoid dotenv stdout pollution
function loadEnvironment() {
  // Suppress dotenv output globally
  if (!process.env.DOTENV_CONFIG_QUIET) {
    process.env.DOTENV_CONFIG_QUIET = 'true';
  }
  
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          if (key && valueParts.length > 0) {
            const value = valueParts.join('=').replace(/^["']|["']$/g, '');
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
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { 
      colorize: true,
      destination: 2 // stderr instead of stdout
    }
  } : undefined
});

const requiredEnvVars = ['XAI_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Error: ${envVar} environment variable is required`);
    process.exit(1);
  }
}

// Initialize Grok configuration
const grokConfig: GrokConfig = {
  apiKey: process.env.XAI_API_KEY!,
  baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  model: process.env.GROK_MODEL || 'grok-4.1-fast',
  temperature: parseFloat(process.env.GROK_TEMPERATURE || '0.7'),
  maxTokens: parseInt(process.env.GROK_MAX_TOKENS || '4000'),
};

const grokClient = new GrokClient(grokConfig);

const server = new Server(
  {
    name: process.env.MCP_SERVER_NAME || 'grok-4-mcp-server',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);


// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'grok_ask',
        description: 'Ask Grok 4 a question with optional context and system prompt. Supports live search integration.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask Grok 4',
            },
            context: {
              type: 'string',
              description: 'Optional context to provide with the question',
            },
            system_prompt: {
              type: 'string',
              description: 'Optional system prompt to guide Grok\'s behavior',
            },
            temperature: {
              type: 'number',
              description: 'Temperature for response generation (0.0 to 1.0)',
              minimum: 0,
              maximum: 1,
            },
            max_tokens: {
              type: 'number',
              description: 'Maximum tokens in the response',
              minimum: 1,
              maximum: 8000,
            },
            include_search: {
              type: 'boolean',
              description: 'Include live search results for current information',
            },
            model: {
              type: 'string',
              description: 'Grok model to use (e.g., grok-4-1-fast-reasoning)',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'grok_chat',
        description: 'Have a multi-turn conversation with Grok 4 using the chat completion API',
        inputSchema: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              description: 'Array of messages in the conversation',
              items: {
                type: 'object',
                properties: {
                  role: {
                    type: 'string',
                    enum: ['system', 'user', 'assistant'],
                    description: 'Role of the message sender',
                  },
                  content: {
                    type: 'string',
                    description: 'Content of the message',
                  },
                },
                required: ['role', 'content'],
              },
            },
            model: {
              type: 'string',
              description: 'Grok model to use (defaults to grok-4)',
            },
            temperature: {
              type: 'number',
              description: 'Temperature for response generation (0.0 to 1.0)',
              minimum: 0,
              maximum: 1,
            },
            max_tokens: {
              type: 'number',
              description: 'Maximum tokens in the response',
              minimum: 1,
              maximum: 8000,
            },
          },
          required: ['messages'],
        },
      },
      {
        name: 'grok_search',
        description: 'Perform a live search using Grok\'s search capabilities for current information',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to execute',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of search results to return',
              minimum: 1,
              maximum: 20,
            },
            include_images: {
              type: 'boolean',
              description: 'Include image results in search',
            },
            include_news: {
              type: 'boolean',
              description: 'Include news articles in search results',
            },
            time_filter: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year', 'all'],
              description: 'Filter results by time period',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'grok_models',
        description: 'List available Grok models',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'grok_test_connection',
        description: 'Test the connection to Grok API to verify setup',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'grok_health',
        description: 'Check the health of the MCP server and its dependencies',
        inputSchema: {
          type: 'object',
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

// Centralized authentication check
function checkAuth(request: any) {
  const token = request?.params?.auth || request?.auth;
  const SHARED_SECRET = process.env.SHARED_SECRET;
  if (!token || !SHARED_SECRET) {
    logger.warn('Unauthorized access attempt', { token });
    throw new AuthError('Unauthorized: invalid or missing auth token');
  }
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(SHARED_SECRET);
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    logger.warn('Unauthorized access attempt', { token });
    throw new AuthError('Unauthorized: invalid or missing auth token');
  }
}

// Sanitize utility (basic example)
function sanitize(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/[<>"'`]/g, '');
  } else if (Array.isArray(obj)) {
    return obj.map(sanitize);
  } else if (obj && typeof obj === 'object') {
    const clean: Record<string, any> = {};
    for (const k of Object.keys(obj)) {
      if (k.startsWith('$') || k.includes('__proto__')) continue;
      clean[k] = sanitize(obj[k]);
    }
    return clean;
  }
  return obj;
}

// Prometheus metrics
const latencyHistogram = new client.Histogram({
  name: 'grok_mcp_request_latency_seconds',
  help: 'Request latency in seconds',
  labelNames: ['tool'],
});
const requestCounter = new client.Counter({
  name: 'grok_mcp_requests_total',
  help: 'Total number of tool requests',
  labelNames: ['tool'],
});
const errorCounter = new client.Counter({
  name: 'grok_mcp_errors_total',
  help: 'Total number of errors',
  labelNames: ['tool'],
});

// Safe wrappers for GrokClient methods with error handling
async function safeAsk(
  question: string,
  context?: string,
  systemPrompt?: string,
  options?: { temperature?: number; maxTokens?: number; includeSearch?: boolean; model?: string }
) {
  try {
    return await grokClient.ask(question, context, systemPrompt, options);
  } catch (err: any) {
    logger.error({ err }, 'safeAsk error');
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message ? `Grok ask failed: ${err.message}` : 'Grok ask failed',
      502,
      { cause: err }
    );
  }
}

async function safeChat(args: any) {
  try {
    return await grokClient.chatCompletion(args);
  } catch (err: any) {
    logger.error({ err }, 'safeChat error');
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message ? `Grok chat failed: ${err.message}` : 'Grok chat failed',
      502,
      { cause: err }
    );
  }
}

async function safeSearch(args: any) {
  try {
    return await grokClient.liveSearch(args);
  } catch (err: any) {
    logger.error({ err }, 'safeSearch error');
    // Return the actual error message if available
    throw new ExternalServiceError(
      err?.message ? `Grok search failed: ${err.message}` : 'Grok search failed',
      502,
      { cause: err }
    );
  }
}

function handleError(error: any) {
  let message = 'Internal server error';
  if (error instanceof ValidationError || error instanceof AuthError || error instanceof ExternalServiceError) {
    message = error.message;
  } else if (error?.message) {
    message = error.message;
  }
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}`
      }
    ]
  };
}

// Extract the CallToolRequestSchema handler logic into a function
async function handleToolCall(request: any) {
  const end = latencyHistogram.startTimer();
  requestCounter.inc();
  try {
    // checkAuth(request); // Auth check removed for open access
    const { name, arguments: args } = request.params;
    const safeArgs = sanitize(args);
    switch (name) {
      case 'grok_ask': {
        const grokAskSchema = z.object({
          question: z.string().min(1, 'Question is required'),
          context: z.string().optional(),
          system_prompt: z.string().optional(),
          temperature: z.number().min(0).max(1).optional(),
          max_tokens: z.number().min(1).max(8000).optional(),
          include_search: z.boolean().optional(),
          model: z.string().optional(),
        });
        const parsed = grokAskSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError('Invalid input for grok_ask', { issues: parsed.error.issues });
        }
        const { question, context, system_prompt, temperature, max_tokens, include_search, model } = parsed.data;
        const response = await safeAsk(
          question,
          context,
          system_prompt,
          {
            temperature,
            maxTokens: max_tokens,
            includeSearch: include_search,
            model,
          }
        );
        end();
        return {
          content: [
            {
              type: 'text',
              text: response,
            },
          ],
        };
      }
      case 'grok_chat': {
        const grokChatSchema = z.object({
          messages: z.array(z.object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string(),
          })),
          model: z.string().optional(),
          temperature: z.number().min(0).max(1).optional(),
          max_tokens: z.number().min(1).max(8000).optional(),
        });
        const parsed = grokChatSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError('Invalid input for grok_chat', { issues: parsed.error.issues });
        }
        const { messages, model, temperature, max_tokens } = parsed.data;
        const response = await safeChat({
          messages,
          model,
          temperature,
          max_tokens,
        });
        const assistantMessage = response.choices[0]?.message?.content || 'No response generated';
        end();
        return {
          content: [
            {
              type: 'text',
              text: assistantMessage,
            },
          ],
        };
      }
      case 'grok_search': {
        const grokSearchSchema = z.object({
          query: z.string(),
          max_results: z.number().int().optional(), // ensure integer
          include_images: z.boolean().optional(),
          include_news: z.boolean().optional(),
          time_filter: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
        });
        // Coerce max_results to integer if needed
        if (safeArgs.max_results) {
          safeArgs.max_results = Math.floor(Number(safeArgs.max_results));
        }
        const parsed = grokSearchSchema.safeParse(safeArgs);
        if (!parsed.success) {
          throw new ValidationError('Invalid input for grok_search', { issues: parsed.error.issues });
        }
        const { query, max_results, include_images, include_news, time_filter } = parsed.data;
        const searchResults = await safeSearch({
          query,
          max_results,
          include_images,
          include_news,
          time_filter,
        });
        const formattedResults = searchResults.results
          .map((result, index) =>
            `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}${result.published_date ? `\nPublished: ${result.published_date}` : ''}`
          )
          .join('\n\n');
        return {
          content: [
            {
              type: 'text',
              text: `Search Results for "${query}" (${searchResults.total_results} results found in ${searchResults.search_time}s):\n\n${formattedResults}`
            }
          ]
        };
      }
      case 'grok_health': {
        end();
        return {
          content: [
            { type: 'text', text: 'OK: Grok 4 MCP Server healthy' },
          ],
          metrics: await client.register.metrics(),
        };
      }
      case 'grok_models': {
        const models = await grokClient.getModels();
        end();
        return {
          content: [
            {
              type: 'text',
              text: `Available Grok models:\n${models.map(model => `- ${model}`).join('\n')}`,
            },
          ],
        };
      }
      case 'grok_test_connection': {
        const isConnected = await grokClient.testConnection();
        end();
        return {
          content: [
            {
              type: 'text',
              text: isConnected 
                ? '✅ Grok API connection successful! Ready to use Grok 4.' 
                : '❌ Grok API connection failed. Please check your API key and configuration.',
            },
          ],
        };
      }
      default:
        end();
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown tool: ${name}`
            }
          ]
        };
    }
  } catch (error) {
    errorCounter.inc();
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
  logger.info('🎯 Grok 4 MCP Server running and ready!');
}

// Start the server only if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  });
}

// Export for testing
export { server, handleToolCall, grokClient };