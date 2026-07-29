import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { GrokClient } from "./grok-client.js";
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
        model: "grok-4.5",
        temperature: 0.1,
        max_output_tokens: 1200,
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com/article");
    expect(result.total_results).toBe(1);
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

    expect(mockInstance.get).toHaveBeenCalledWith("/models");
    expect(models).toEqual(["grok-4.5", "grok-build-0.1"]);
  });

  it("falls back to default model list when endpoint fails", async () => {
    mockInstance.get.mockRejectedValueOnce(new Error("network"));

    const models = await client.getModels();

    expect(models).toEqual([
      "grok-4.5",
      "grok-4.5-latest",
      "grok-build-latest",
      "grok-4.3",
      "grok-latest",
      "grok-4.20",
      "grok-build-0.1",
      "grok-imagine-image",
      "grok-imagine-image-quality",
      "grok-imagine-video",
      "grok-voice-think-fast-1.0",
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

  it("uses custom timeout from config", () => {
    client = new GrokClient({ ...testConfig, timeoutMs: 120000 });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 120000 }),
    );
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

    client = new GrokClient({ ...testConfig, searchTimeoutMs: 180000 });
    await client.liveSearch({ query: "test" });

    expect(mockInstance.post).toHaveBeenCalledWith(
      "/responses",
      expect.any(Object),
      expect.objectContaining({ timeout: 180000 }),
    );
  });
});

