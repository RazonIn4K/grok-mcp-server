import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_SEARCH_MODEL,
  GrokClient,
} from "./grok-client.js";
import { ExternalServiceError } from "./errors.js";
import type { GrokConfig } from "./types.js";

// Mock axios
vi.mock("axios");
const mockedAxios = vi.mocked(axios, true);

const testConfig: GrokConfig = {
  apiKey: "test-api-key",
  baseUrl: "https://api.x.ai/v1",
  model: "grok-4.5",
  temperature: 0.7,
  maxTokens: 4000,
};

// Helper to create a mock axios instance
function createMockAxiosInstance() {
  const instance = {
    post: vi.fn(),
    get: vi.fn(),
    defaults: { headers: {} },
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return instance;
}

describe("GrokClient.chatCompletion()", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient(testConfig);
  });

  it("calls the chat completion endpoint with expected payload", async () => {
    const mockResponse = {
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
    mockInstance.post.mockResolvedValueOnce(mockResponse);

    await client.chatCompletion({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Say hi" }],
      temperature: 0.5,
      max_tokens: 50,
      reasoning_effort: "low",
    });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.objectContaining({
        model: "grok-4.5",
        messages: [{ role: "user", content: "Say hi" }],
        stream: false,
        temperature: 0.5,
        max_tokens: 50,
        reasoning_effort: "low",
      }),
    );
  });

  it("defaults to client config temperature and maxTokens when not provided", async () => {
    const mockResponse = {
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
    mockInstance.post.mockResolvedValueOnce(mockResponse);

    await client.chatCompletion({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Defaults" }],
    });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.objectContaining({
        temperature: 0.7,
        max_tokens: 4000,
      }),
    );
  });

  it.each(["grok-4.5", "grok-4.6", "grok-4.7"])(
    'omits unsupported reasoning_effort "none" for %s', async (model) => {
      mockInstance.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          id: "chat-id",
          object: "chat.completion",
          created: 123,
          model,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

      await client.chatCompletion({
        model,
        messages: [{ role: "user", content: "No reasoning" }],
        reasoning_effort: "none",
      });

      expect(mockInstance.post).toHaveBeenCalledWith(
        "/chat/completions",
        expect.not.objectContaining({ reasoning_effort: expect.anything() }),
      );
  });

  it.each(["grok-4.6", "grok-4.7"])(
    "accepts xhigh reasoning_effort for %s", async (model) => {
      mockInstance.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          id: "chat-id",
          object: "chat.completion",
          created: 123,
          model,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

      await client.chatCompletion({
        model,
        messages: [{ role: "user", content: "Think hard" }],
        reasoning_effort: "xhigh",
      });

      expect(mockInstance.post).toHaveBeenCalledWith(
        "/chat/completions",
        expect.objectContaining({
          model,
          reasoning_effort: "xhigh",
        }),
      );
  });

  it("omits unsupported reasoning_effort for Grok 4.20 models", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.20-0309-reasoning",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });

    await client.chatCompletion({
      model: "grok-4.20-0309-reasoning",
      messages: [{ role: "user", content: "Use the selected reasoning model" }],
      reasoning_effort: "low",
    });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.not.objectContaining({ reasoning_effort: expect.anything() }),
    );
  });

  it("uses the current public model for default chat and search configuration", async () => {
    expect(DEFAULT_GROK_MODEL).toBe("grok-4.7");
    expect(DEFAULT_GROK_SEARCH_MODEL).toBe("grok-4.7");
    client = new GrokClient({ ...testConfig, model: DEFAULT_GROK_MODEL });
    mockInstance.post.mockResolvedValueOnce({
      data: { choices: [{ message: { role: "assistant", content: "ok" } }] },
    });

    await client.chatCompletion({ messages: [{ role: "user", content: "Hi" }] });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.objectContaining({ model: "grok-4.7" }),
    );
    expect(client.getRuntimeStatus()).toMatchObject({
      model: "grok-4.7",
      search_model: "grok-4.7",
    });
  });

  it("wraps API errors as a plain Error from chatCompletion", async () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: {
        status: 400,
        data: { error: { message: "Invalid model" } },
      },
    });
    vi.spyOn(axios, "isAxiosError").mockReturnValue(true);
    mockInstance.post.mockRejectedValueOnce(axiosError);

    await expect(
      client.chatCompletion({
        model: "invalid-model",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("Grok API Error: 400 - Invalid model");
  });
});

describe("GrokClient.ask()", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient(testConfig);
  });

  it("builds a simple user message and returns assistant content", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "No problem" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    });

    const result = await client.ask("Can you help?");

    const sentPayload = mockInstance.post.mock.calls[0][1];
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
    expect(sentPayload.messages).toEqual([
      { role: "user", content: "Can you help?" },
    ]);
    expect(result).toBe("No problem");
  });

  it("adds search context when includeSearch is true", async () => {
    vi.spyOn(client, "liveSearch").mockResolvedValue({
      results: [
        {
          title: "Source",
          url: "https://example.com",
          snippet: "Recent context",
          published_date: "2026-01-01",
        },
      ],
      total_results: 1,
      search_time: 0.1,
    });

    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "Search-aware response" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 6, completion_tokens: 7, total_tokens: 13 },
      },
    });

    const result = await client.ask("Current weather", undefined, undefined, {
      includeSearch: true,
    });

    const sentPayload = mockInstance.post.mock.calls[0][1];
    expect(sentPayload.messages).toHaveLength(2);
    expect(sentPayload.messages[1]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Recent search results for context"),
    });
    expect(result).toBe("Search-aware response");
  });

  it("shares one deadline across search and chat without injecting degraded fallback text", async () => {
    client = new GrokClient({
      ...testConfig,
      askOverallTimeoutMs: 2000,
      searchOverallTimeoutMs: 5000,
      timeoutMs: 45000,
    });
    const searchSpy = vi.spyOn(client, "liveSearch").mockResolvedValue({
      results: [
        {
          title: "Live search temporarily unavailable",
          url: "https://www.google.com/search?q=current",
          snippet: "retry shortly",
          source: "fallback",
        },
      ],
      total_results: 1,
      search_time: 1,
      degraded: true,
    });
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "Base answer" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      },
    });

    const result = await client.ask("Current info", undefined, undefined, {
      includeSearch: true,
    });

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Current info" }),
      1000,
    );
    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.objectContaining({
        messages: [{ role: "user", content: "Current info" }],
      }),
      expect.objectContaining({
        timeout: expect.any(Number),
      }),
    );
    const timeout = mockInstance.post.mock.calls[0][2].timeout;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(2000);
    expect(result).toBe("Base answer");
  });

  it("makes no provider call when the ask budget expires before a limiter slot", async () => {
    client = new GrokClient({
      ...testConfig,
      askOverallTimeoutMs: 1,
    });
    const searchSpy = vi.spyOn(client, "liveSearch");
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "Fast answer" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      },
    });

    await expect(
      client.ask("Fast", undefined, undefined, { includeSearch: true }),
    ).rejects.toThrow(/deadline/i);

    expect(searchSpy).not.toHaveBeenCalled();
    expect(mockInstance.post).not.toHaveBeenCalled();
  });
});

describe("GrokClient.liveSearch()", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient(testConfig);
  });

  it("returns parsed search citations as results", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Search response",
                citations: [
                  {
                    url: "https://example.com/article",
                    title: "Example",
                    snippet: "Helpful summary",
                    published_date: "2026-01-01",
                    source: "web",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const result = await client.liveSearch({
      query: "what is xAI",
      max_results: 1,
      include_news: false,
      time_filter: "day",
    });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/responses",
      expect.objectContaining({
        model: "grok-4.7",
        temperature: 0.1,
        max_output_tokens: 2000,
        reasoning: { effort: "low" },
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com/article");
    expect(result.total_results).toBe(1);
    expect(result.summary).toContain("Search response");
  });

  it("does not use numeric citation labels as titles", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        citations: [
          "https://x.ai/news/grok-4-6",
          "https://docs.x.ai/developers/grok-4-6",
        ],
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Grok 4.6 launched on August 12, 2026.[[1]](https://x.ai/news/grok-4-6) Docs are current.[[2]](https://docs.x.ai/developers/grok-4-6)",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://x.ai/news/grok-4-6",
                    title: "1",
                  },
                  {
                    type: "url_citation",
                    url: "https://docs.x.ai/developers/grok-4-6",
                    title: "2",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const result = await client.liveSearch({ query: "Grok 4.6 release" });

    expect(result.results.map((item) => item.title)).toEqual([
      "grok 4.6 (x.ai)",
      "grok 4.6 (docs.x.ai)",
    ]);
    expect(result.results[0].snippet).not.toBe(result.results[1].snippet);
    expect(result.summary).toContain("August 12, 2026");
  });

  it("maps legacy search_parameters into Responses web_search tool payload", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Search response",
                citations: [
                  {
                    url: "https://allowed.com/article",
                    title: "Allowed result",
                    snippet: "Legacy mapping example",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const result = await client.liveSearch({
      query: "legacy compatibility test",
      include_news: false,
      enable_image_understanding: true,
      search_parameters: {
        max_search_results: 1,
        from_date: "2026-01-01",
        to_date: "2026-05-01",
        sources: [
          {
            type: "web",
            allowed_websites: ["allowed.com", "example.org"],
          },
        ],
      },
    });

    const payload = mockInstance.post.mock.calls[0][1];
    expect(payload).toEqual(
      expect.objectContaining({
        tools: [
          {
            type: "web_search",
            filters: {
              allowed_domains: ["allowed.com", "example.org"],
            },
            enable_image_understanding: true,
          },
        ],
      }),
    );

    const userPrompt = payload.input[1].content;
    expect(userPrompt).toContain("Search for: legacy compatibility test");
    expect(userPrompt).toContain(
      "Filter results between 2026-01-01 and 2026-05-01.",
    );
    expect(userPrompt).toContain("Exclude news results if possible.");
    expect(userPrompt).toContain(
      "Only search allowed domains: allowed.com, example.org.",
    );
    expect(result.results[0].url).toBe("https://allowed.com/article");
    expect(result.results[0].title).toBe("Allowed result");
  });

  it("returns a truthful empty result for a successful X search with no matches", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "No results found for the search query." }],
          },
        ],
      },
    });

    const result = await client.liveSearch({
      query: "from:example impossible sentinel",
      include_x_search: true,
      search_web: false,
    });

    expect(result).toMatchObject({
      results: [],
      total_results: 0,
    });
    expect(result.degraded).toBeUndefined();
  });

  it("does not invent a URL for an uncited search summary", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "A useful uncited summary." }],
          },
        ],
      },
    });

    const result = await client.liveSearch({ query: "summary only" });

    expect(result.results[0]).toMatchObject({
      title: "Search summary for: summary only",
      url: "",
      source: "model_summary",
    });
  });
});

describe("GrokClient.testConnection()", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient(testConfig);
  });

  it("returns true when chat completion succeeds", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "yes" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });

    await expect(client.testConnection()).resolves.toBe(true);
  });

  it("returns false when chat completion fails", async () => {
    mockInstance.post.mockRejectedValueOnce(new Error("network error"));

    await expect(client.testConnection()).resolves.toBe(false);
  });

  it.each([null, "", "   "])("does not report an empty answer (%s) as healthy", async (content) => {
    mockInstance.post.mockResolvedValueOnce({
      data: { choices: [{ message: { role: "assistant", content } }] },
    });

    await expect(client.testConnection()).resolves.toBe(false);
    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.objectContaining({ reasoning_effort: "low", max_tokens: 256 }),
      expect.any(Object),
    );
  });

  it("always performs a live uncached connection probe", async () => {
    mockInstance.post
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "OK" } }],
          id: "chat-id-1",
          object: "chat.completion",
          created: 123,
          model: "grok-4.5",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "OK" } }],
          id: "chat-id-2",
          object: "chat.completion",
          created: 124,
          model: "grok-4.5",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

    await expect(client.testConnection()).resolves.toBe(true);
    await expect(client.testConnection()).resolves.toBe(true);

    expect(mockInstance.post).toHaveBeenCalledTimes(2);
    expect(mockInstance.post).toHaveBeenNthCalledWith(
      1,
      "/chat/completions",
      expect.any(Object),
      { timeout: expect.any(Number) },
    );
    expect(mockInstance.post.mock.calls[0][2].timeout).toBeGreaterThan(0);
    expect(mockInstance.post.mock.calls[0][2].timeout).toBeLessThanOrEqual(15000);
  });
});

describe("GrokClient.getModels()", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient(testConfig);
  });

  it("uses /models endpoint when available", async () => {
    mockInstance.get.mockResolvedValueOnce({
      data: {
        data: [{ id: "grok-4.5" }, { id: "grok-build-0.1" }],
      },
    });

    const models = await client.getModels();

    expect(mockInstance.get).toHaveBeenCalledWith("/models", { timeout: 10000 });
    expect(models).toEqual(["grok-4.5", "grok-build-0.1"]);
  });

  it("falls back to default model list when endpoint fails", async () => {
    mockInstance.get.mockRejectedValueOnce(new Error("network"));

    const models = await client.getModels();

    expect(models).toEqual([
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
      "grok-4.20-multi-agent-0309",
      "grok-4.3",
      "grok-build-0.1",
      "grok-imagine-image",
      "grok-imagine-image-2.0",
      "grok-imagine-image-quality",
      "grok-imagine-video",
      "grok-imagine-video-1.5",
    ]);
  });
});

describe("GrokClient timeout and retry behavior", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
  });

  it("caps oversized per-attempt timeouts from config", () => {
    client = new GrokClient({ ...testConfig, timeoutMs: 120000 });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 45000 }),
    );
  });

  it("caps direct chat execution overrides and configured retry counts", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        id: "chat-id",
        object: "chat.completion",
        created: 123,
        model: "grok-4.5",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    client = new GrokClient({
      ...testConfig,
      timeoutMs: 120000,
      retries: 10,
    });

    await client.chatCompletion(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "bounded" }],
      },
      { timeoutMs: 120000, retries: 10 },
    );

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/chat/completions",
      expect.any(Object),
      { timeout: expect.any(Number) },
    );
    expect(mockInstance.post.mock.calls[0][2].timeout).toBeGreaterThan(0);
    expect(mockInstance.post.mock.calls[0][2].timeout).toBeLessThanOrEqual(45000);
    expect(client.getRuntimeStatus()).toMatchObject({
      timeout_ms: 45000,
      retries: 1,
    });
  });

  it("retries chatCompletion on transient network failure and succeeds", async () => {
    mockInstance.post
      .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { isAxiosError: true }))
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          id: "chat-id",
          object: "chat.completion",
          created: 123,
          model: "grok-4.5",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

    client = new GrokClient(testConfig);
    const result = await client.chatCompletion({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(mockInstance.post).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe("ok");
  });

  it("retries chatCompletion on 429 and succeeds", async () => {
    const rateLimitError = Object.assign(new Error("Too Many Requests"), {
      isAxiosError: true,
      response: { status: 429, data: { error: "rate limited" } },
    });
    vi.spyOn(axios, "isAxiosError").mockReturnValue(true);
    mockInstance.post
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          id: "chat-id",
          object: "chat.completion",
          created: 123,
          model: "grok-4.5",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

    client = new GrokClient(testConfig);
    const result = await client.chatCompletion({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(mockInstance.post).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe("ok");
  });

  it("does not retry chatCompletion on 4xx client errors", async () => {
    const clientError = Object.assign(new Error("Bad Request"), {
      isAxiosError: true,
      response: { status: 400, data: { error: { message: "Invalid model" } } },
    });
    vi.spyOn(axios, "isAxiosError").mockReturnValue(true);
    mockInstance.post.mockRejectedValueOnce(clientError);

    client = new GrokClient(testConfig);
    await expect(
      client.chatCompletion({
        model: "invalid-model",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("Invalid model");

    expect(mockInstance.post).toHaveBeenCalledTimes(1);
  });

  it("throws a timeout-specific error when request times out", async () => {
    const timeoutError = Object.assign(new Error("timeout of 60000ms exceeded"), {
      isAxiosError: true,
      code: "ECONNABORTED",
    });
    mockInstance.post.mockRejectedValue(timeoutError);

    client = new GrokClient(testConfig);
    await expect(
      client.chatCompletion({
        model: "grok-4.5",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("TIMEOUT");
  });

  it("applies search timeout to liveSearch requests", async () => {
    mockInstance.post.mockResolvedValueOnce({
      data: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Search response",
                citations: [{ url: "https://example.com", title: "Example", snippet: "Summary" }],
              },
            ],
          },
        ],
      },
    });

    client = new GrokClient({
      ...testConfig,
      searchTimeoutMs: 30000,
      searchOverallTimeoutMs: 60000,
    });
    await client.liveSearch({ query: "test" });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/responses",
      expect.any(Object),
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it("does not retry search by default and returns a truthful degraded result", async () => {
    const timeoutError = Object.assign(new Error("request timed out"), {
      isAxiosError: true,
      code: "ECONNABORTED",
    });
    mockInstance.post.mockRejectedValueOnce(timeoutError);

    client = new GrokClient({
      ...testConfig,
      searchTimeoutMs: 10,
      searchOverallTimeoutMs: 20,
    });
    const result = await client.liveSearch({ query: "bounded timeout" });

    expect(mockInstance.post).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    expect(result.results[0]).toMatchObject({
      title: "Live search temporarily unavailable",
      source: "fallback",
    });
    expect(result.results[0].url).toContain(
      "google.com/search?q=bounded%20timeout",
    );
    expect(result.search_time).toBeGreaterThanOrEqual(0);
    expect(result.search_time).not.toBe(0.5);
  });

  it("does not begin a retry that cannot fit inside the overall search budget", async () => {
    const transientError = Object.assign(new Error("temporary failure"), {
      isAxiosError: true,
      code: "ECONNRESET",
    });
    mockInstance.post.mockRejectedValueOnce(transientError);

    client = new GrokClient({
      ...testConfig,
      searchRetries: 2,
      retryDelayMs: 1000,
      searchOverallTimeoutMs: 100,
    });
    const result = await client.liveSearch({ query: "retry budget" });

    expect(mockInstance.post).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
  });

  it("reports the active timeout and limiter configuration", () => {
    client = new GrokClient({
      ...testConfig,
      timeoutMs: 45000,
      askOverallTimeoutMs: 85000,
      searchTimeoutMs: 30000,
      searchOverallTimeoutMs: 70000,
      retries: 1,
      searchRetries: 0,
    });

    expect(client.getRuntimeStatus()).toMatchObject({
      model: "grok-4.5",
      timeout_ms: 45000,
      ask_overall_timeout_ms: 85000,
      search_timeout_ms: 30000,
      search_overall_timeout_ms: 70000,
      retries: 1,
      search_retries: 0,
      limiter: {
        running: 0,
        queued: 0,
      },
    });
  });
});

describe("GrokClient queued request deadlines", () => {
  let client: GrokClient;
  let mockInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockedAxios.isAxiosError.mockReturnValue(false);
    mockInstance = createMockAxiosInstance();
    mockedAxios.create = vi.fn().mockReturnValue(mockInstance);
    client = new GrokClient({
      ...testConfig,
      minTimeMs: 1000,
      maxConcurrent: 1,
      askOverallTimeoutMs: 500,
      searchOverallTimeoutMs: 500,
    });
    mockInstance.post.mockResolvedValue({
      data: { choices: [{ message: { role: "assistant", content: "OK" } }] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function occupyFirstSlot() {
    const warmup = client.chatCompletion({ messages: [{ role: "user", content: "warmup" }] });
    await vi.advanceTimersByTimeAsync(10);
    await warmup;
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
  }

  it("returns at the chat deadline and never sends an expired queued request", async () => {
    await occupyFirstSlot();
    const pending = client.chatCompletion(
      { messages: [{ role: "user", content: "queued" }] },
      { timeoutMs: 50, retries: 0 },
    );
    const assertion = expect(pending).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
  });

  it("returns degraded search when the queue consumes its whole budget", async () => {
    await occupyFirstSlot();
    const pending = client.liveSearch({ query: "queued search" }, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ degraded: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
  });

  it("reports an expired connection probe as unhealthy without making a late call", async () => {
    await occupyFirstSlot();
    const pending = client.testConnection();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
  });

  it("enforces the overall ask budget even when search is disabled", async () => {
    mockInstance.post.mockImplementationOnce(() => new Promise(() => {}));
    const pending = client.ask("bounded ask");
    const assertion = expect(pending).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(mockInstance.post).toHaveBeenCalledTimes(1);
    expect(mockInstance.post.mock.calls[0][2].timeout).toBeLessThanOrEqual(500);
  });

  it("does not call Perplexity after its fallback queue exhausts the search budget", async () => {
    const perplexity = createMockAxiosInstance();
    mockedAxios.create = vi.fn()
      .mockReturnValueOnce(mockInstance)
      .mockReturnValueOnce(perplexity);
    client = new GrokClient({
      ...testConfig,
      minTimeMs: 0,
      perplexityApiKey: "test-perplexity-key",
      searchOverallTimeoutMs: 5000,
    });
    mockInstance.post.mockResolvedValue({ data: { output: [] } });
    perplexity.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: "A source." } }],
        citations: ["https://example.com/source"],
      },
    });

    const first = client.liveSearch({ query: "first fallback" });
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toMatchObject({ total_results: 1 });
    expect(perplexity.post).toHaveBeenCalledTimes(1);

    const second = client.liveSearch({ query: "queued fallback" }, 1100);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(second).resolves.toMatchObject({ degraded: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInstance.post).toHaveBeenCalledTimes(2);
    expect(perplexity.post).toHaveBeenCalledTimes(1);
  });
});
