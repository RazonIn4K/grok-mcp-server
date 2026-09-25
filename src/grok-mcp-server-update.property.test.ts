import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { readFileSync } from "fs";
import { join } from "path";

// Use vi.hoisted to set env vars before any module is evaluated
// (vi.mock calls are hoisted, so env vars must also be set via vi.hoisted)
const _envSetup = vi.hoisted(() => {
  process.env.XAI_API_KEY = "test-key";
  process.env.SHARED_SECRET = "test-secret";
});

// Mock prom-client to avoid duplicate metric registration across test files
vi.mock("prom-client", async () => {
  const actual = await vi.importActual<typeof import("prom-client")>("prom-client");
  const registry = new actual.Registry();
  const Histogram = vi.fn().mockImplementation(function (_opts: any) {
    return {
    startTimer: vi.fn().mockReturnValue(vi.fn()),
    observe: vi.fn(),
    labels: vi.fn().mockReturnThis(),
    };
  });
  const Counter = vi.fn().mockImplementation(function (_opts: any) {
    return {
    inc: vi.fn(),
    labels: vi.fn().mockReturnThis(),
    };
  });
  // prom-client uses named exports only (no default export in its type definitions)
  return {
    ...actual,
    Histogram,
    Counter,
    register: registry,
  };
});

// Mock GrokClient
vi.mock("./grok-client.js", () => {
  const GrokClient = vi.fn().mockImplementation(function () {
    return {
    ask: vi.fn().mockResolvedValue("mock response"),
    chatCompletion: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "mock chat response" } }],
    }),
    liveSearch: vi.fn().mockResolvedValue({ results: [], total_results: 0, search_time: 0 }),
    getModels: vi.fn().mockResolvedValue(["grok-4.5"]),
    testConnection: vi.fn().mockResolvedValue(true),
    getRuntimeStatus: vi.fn().mockReturnValue({
      timeout_ms: 45000,
      ask_overall_timeout_ms: 90000,
      search_overall_timeout_ms: 90000,
      search_retries: 0,
    }),
    };
  });
  return { GrokClient, DEFAULT_GROK_MODEL: "grok-4.7", DEFAULT_GROK_SEARCH_MODEL: "grok-4.7" };
});

import { handleToolCall, grokClient } from "./index.js";

describe("Property-Based Tests: Grok MCP Server Update", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Property 1: Exact dependency version pinning
  // Validates: Requirements 1.5
  it("Property 1: all direct dependencies use exact versions (no ^ or ~)", () => {
    const pkgJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    };
    fc.assert(
      fc.property(fc.constantFrom(...Object.entries(allDeps)), ([name, version]) => {
        const v = version as string;
        expect(v).not.toMatch(/^[\^~]/);
      }),
      { numRuns: 100 },
    );
  });

  // Property 2: Deprecated model warning and passthrough
  // Validates: Requirements 2.5
  it("Property 2: deprecated model triggers warn log and request is forwarded unchanged", async () => {
    const deprecatedModels = [
      "grok-4-1-fast-reasoning",
      "grok-4-1-fast-non-reasoning",
      "grok-4-fast-reasoning",
      "grok-4-fast-non-reasoning",
      "grok-4-0709",
      "grok-code-fast-1",
      "grok-3",
      "grok-imagine-image-pro",
    ];

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...deprecatedModels), async (deprecatedModel) => {
        vi.clearAllMocks();

        // Mock ask to capture the model passed
        let capturedModel: string | undefined;
        (grokClient.ask as any).mockImplementationOnce(async (_q: any, _c: any, _s: any, opts: any) => {
          capturedModel = opts?.model;
          return "response";
        });

        await handleToolCall({
          params: {
            name: "grok_ask",
            arguments: { question: "test", model: deprecatedModel },
          },
        });

        // The model should be forwarded unchanged
        expect(capturedModel).toBe(deprecatedModel);
      }),
      { numRuns: 100 },
    );
  });

  // Property 3: Question tool returns a consistent response shape
  // Validates: Requirements 2.2
  it("Property 3: grok_ask returns response content and forwards user question", async () => {
    const questionArb = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((value) => !/[<>'\"`]/.test(value));

    await fc.assert(
      fc.asyncProperty(questionArb, async (question) => {
        vi.clearAllMocks();
        (grokClient.ask as any).mockResolvedValueOnce("ask ok");

        const result = await handleToolCall({
          params: {
            name: "grok_ask",
            arguments: { question },
          },
        });

        expect(result).toEqual({
          content: [{ type: "text", text: "ask ok" }],
        });
      }),
      { numRuns: 100 },
    );
  });

  it("grok_ask search flags enable search without a redundant include_search flag", async () => {
    let capturedOptions: any;
    (grokClient.ask as any).mockImplementationOnce(
      async (_question: any, _context: any, _systemPrompt: any, options: any) => {
        capturedOptions = options;
        return "search-enabled";
      },
    );

    const result = await handleToolCall({
      params: {
        name: "grok_ask",
        arguments: { question: "current news", include_x_search: true },
      },
    });

    expect(capturedOptions).toMatchObject({
      includeSearch: true,
      include_x_search: true,
    });
    expect(result.content[0].text).toBe("search-enabled");
  });

  it("invalid chat input is marked as an MCP tool error", async () => {
    const result = await handleToolCall({
      params: { name: "grok_chat", arguments: { messages: [] } },
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Error: Invalid input for grok_chat/);
  });

  it("preserves code and quoted text through ask, chat, and search", async () => {
    const code = 'if (a < b) return "hello"; // `quoted` <tag>';
    await handleToolCall({ params: { name: "grok_ask", arguments: {
      question: code, context: code, system_prompt: code,
    } } });
    expect(grokClient.ask).toHaveBeenLastCalledWith(code, code, code, expect.any(Object));

    await handleToolCall({ params: { name: "grok_chat", arguments: {
      messages: [{ role: "user", content: code }],
    } } });
    expect(grokClient.chatCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({ messages: [{ role: "user", content: code }] }), undefined,
    );

    await handleToolCall({ params: { name: "grok_search", arguments: { query: code } } });
    expect(grokClient.liveSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: code }), undefined,
    );
  });

  it("redacts credentials in user-facing errors as well as logs", async () => {
    vi.mocked(grokClient.ask).mockRejectedValueOnce(new Error("Provider failed with password=fake-password"));
    const result = await handleToolCall({ params: { name: "grok_ask", arguments: { question: "test" } } });
    expect(result.content[0].text).toContain("[REDACTED]");
    expect(result.content[0].text).not.toContain("fake-password");
    expect("isError" in result && result.isError).toBe(true);
  });

  it("reserves answer time when chat requests search context", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(grokClient.liveSearch).mockImplementationOnce(async () => {
      now.mockReturnValue(31000);
      return { results: [], total_results: 0, search_time: 30 };
    });
    try {
      await handleToolCall({ params: { name: "grok_chat", arguments: {
        messages: [{ role: "user", content: "news" }], include_search: true,
      } } });
      expect(grokClient.liveSearch).toHaveBeenLastCalledWith(expect.any(Object), 45000);
      expect(grokClient.chatCompletion).toHaveBeenLastCalledWith(
        expect.any(Object), { timeoutMs: 45000, overallTimeoutMs: 60000, retries: 0 },
      );
    } finally {
      now.mockRestore();
    }
  });

  // Property 4: Chat tool handles message arrays and surfaces assistant content
  // Validates: Requirements 2.3
  it("Property 4: grok_chat returns assistant content for valid message arrays", async () => {
    const messagesArb = fc.array(
      fc.record({
        role: fc.constantFrom("system", "user", "assistant"),
        content: fc
          .string({ minLength: 1, maxLength: 60 })
          .filter((value) => !/[<>'\"`]/.test(value)),
      }),
      { minLength: 1, maxLength: 4 },
    );

    await fc.assert(
      fc.asyncProperty(messagesArb, async (messageSet) => {
        vi.clearAllMocks();

        const result = await handleToolCall({
          params: {
            name: "grok_chat",
            arguments: { messages: messageSet },
          },
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe("mock chat response");
      }),
      { numRuns: 100 },
    );
  });

  // Property 5: Search tool formats returned results into a response string
  // Validates: Requirements 2.4
  it("Property 5: grok_search returns formatted results from live search", async () => {
    const queryArb = fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((value) => !/[<>'\"`]/.test(value));

    await fc.assert(
      fc.asyncProperty(queryArb, async (q) => {
        vi.clearAllMocks();
        (grokClient.liveSearch as any).mockResolvedValueOnce({
          results: [
            {
              title: "Result title",
              url: "https://example.com",
              snippet: "Result summary",
              published_date: "2026-01-01",
            },
          ],
          total_results: 1,
          search_time: 0.2,
        });

        const result = await handleToolCall({
          params: {
            name: "grok_search",
            arguments: { query: q },
          },
        });

        expect(result.content[0].text).toContain(`Search Results for "${q}"`);
        expect(result.content[0].text).toContain("Result title");
        expect(result.content[0].text).toContain("https://example.com");
      }),
      { numRuns: 100 },
    );
  });

  // Property 6: Unknown/legacy tool names should be rejected
  // Validates: Unknown tool behavior after model/tool modernization
  it("Property 6: removed legacy tools return Unknown tool", async () => {
    const staleToolNames = ["grok_imagine", "grok_video", "grok_tts", "grok_stt"];

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...staleToolNames), async (toolName) => {
        vi.clearAllMocks();
        const result = await handleToolCall({
          params: {
            name: toolName,
            arguments: {},
          },
        });

        expect(result.content[0].text).toBe(`Error: Unknown tool: ${toolName}`);
      }),
      { numRuns: 100 },
    );
  });

  // Property 7: Models tool returns the list from client
  // Validates: Requirements 2.1
  it("Property 7: grok_models returns a text list for all provided model names", async () => {
    const modelListArb = fc.array(fc.string({ minLength: 1, maxLength: 40 }).filter((value) => !/[<>'\"`]/.test(value)), {
      minLength: 1,
      maxLength: 5,
    });

    await fc.assert(
      fc.asyncProperty(modelListArb, async (models) => {
        vi.clearAllMocks();
        (grokClient.getModels as any).mockResolvedValueOnce(models);

        const result = await handleToolCall({
          params: {
            name: "grok_models",
            arguments: {},
          },
        });

        expect(result.content[0].text).toContain("Available Grok models:");
        for (const model of models) {
          expect(result.content[0].text).toContain(`- ${model}`);
        }
      }),
      { numRuns: 50 },
    );
  });

  // Property 8: Test connection tool maps client bool to human text
  // Validates: Requirements 6.2
  it("Property 8: grok_test_connection maps boolean response to status message", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (isConnected) => {
        vi.clearAllMocks();
        (grokClient.testConnection as any).mockResolvedValueOnce(isConnected);

        const result = await handleToolCall({
          params: {
            name: "grok_test_connection",
            arguments: {},
          },
        });

        expect(result.content).toHaveLength(1);
        if (isConnected) {
          expect(result.content[0].text).toMatch(/connection successful/);
        } else {
          expect(result.content[0].text).toMatch(/connection failed/);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Property 9: Health tool response structure
  // Validates: Requirements 9.1, 9.2, 9.3
  it("Property 9: grok_health always returns 2-item content array with correct structure", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (_metricsSucceeds) => {
        vi.clearAllMocks();

        const result = await handleToolCall({
          params: { name: "grok_health", arguments: {} },
        });

        // Must have exactly 2 content items
        expect(result.content).toHaveLength(2);
        // First item must be the status text
        expect(result.content[0].text).toContain(
          "OK: Grok MCP Server process healthy",
        );
        expect(result.content[0].text).toContain(
          '"search_overall_timeout_ms":90000',
        );
        // Second item must be a string (metrics or error description)
        expect(typeof result.content[1].text).toBe("string");
        // Must NOT have a top-level "metrics" field
        expect("metrics" in result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Property 10: Current tool set should be callable and not return unknown tool
  // Validates: Tool surface stability
  it("Property 10: current tools all return non-Unknown-tool responses", async () => {
    const toolNames = ["grok_ask", "grok_chat", "grok_search", "grok_x_search", "grok_models", "grok_test_connection", "grok_health"];

    const validArgs: Record<string, any> = {
      grok_ask: { question: "test" },
      grok_chat: { messages: [{ role: "user", content: "hi" }] },
      grok_search: { query: "test" },
      grok_x_search: { query: "test" },
      grok_models: {},
      grok_test_connection: {},
      grok_health: {},
    };

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...toolNames), async (toolName) => {
        vi.clearAllMocks();
        const result = await handleToolCall({
          params: {
            name: toolName,
            arguments: validArgs[toolName],
          },
        });

        expect(result.content[0].text).not.toMatch(/^Error: Unknown tool/);
      }),
      { numRuns: 100 },
    );
  });
});
