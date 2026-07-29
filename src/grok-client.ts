import axios, { AxiosInstance, AxiosResponse } from "axios";
import {
  GrokChatRequest,
  GrokChatResponse,
  GrokSearchRequest,
  GrokSearchResponse,
  GrokSearchParameters,
  GrokConfig,
} from "./types.js";
import { LRUCache } from "lru-cache";
import Bottleneck from "bottleneck";
import Agent from "agentkeepalive";
import pino from "pino";
const PERPLEXITY_MODEL_LIMITS: Record<string, number> = {
  "sonar-deep-research": 5,
  "sonar-reasoning-pro": 50,
  "sonar-reasoning": 50,
  "sonar-pro": 50,
  sonar: 50,
  "llama-3.1-sonar-large-online": 50,
};
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
      : undefined,
});

export class GrokClient {
  private client: AxiosInstance;
  private perplexityClient?: AxiosInstance;
  private config: GrokConfig;
  private cache: LRUCache<string, any>;
  private limiter: Bottleneck;
  private perplexityLimiters: Map<string, Bottleneck>;

  constructor(config: GrokConfig) {
    this.config = config;
    this.cache = new LRUCache({ max: 100, ttl: 1000 * 60 * 5 }); // 5 min cache
    this.limiter = new Bottleneck({
      maxConcurrent: config.maxConcurrent ?? 2,
      minTime: config.minTimeMs ?? 500,
    });
    this.perplexityLimiters = new Map();
    const timeoutMs = config.timeoutMs ?? 60000;
    this.client = axios.create({
      baseURL: config.baseUrl,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
      httpAgent: new Agent({ maxSockets: 10, keepAlive: true }),
      httpsAgent: new Agent.HttpsAgent({ maxSockets: 10, keepAlive: true }),
    });

    if (config.perplexityApiKey) {
      this.perplexityClient = axios.create({
        baseURL: "https://api.perplexity.ai",
        headers: {
          Authorization: `Bearer ${config.perplexityApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: config.searchTimeoutMs ?? 30000,
      });
    }
  }

  /**
   * Send a chat completion request to Grok 4.5 or another configured text model.
   */
  async chatCompletion(
    request: Partial<GrokChatRequest>,
  ): Promise<GrokChatResponse> {
    const cacheKey = JSON.stringify({ type: "chat", ...request });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, "Cache hit for chatCompletion");
      return cached;
    }
    // Build request with only supported parameters for xAI API
    // Avoid unsupported params like presencePenalty, frequencyPenalty, etc.
    const fullRequest: GrokChatRequest = {
      model: request.model || this.config.model,
      messages: request.messages || [],
      stream: false,
    };

    // Only add optional parameters if explicitly provided
    if (request.temperature !== undefined) {
      fullRequest.temperature = request.temperature;
    } else if (this.config.temperature !== undefined) {
      fullRequest.temperature = this.config.temperature;
    }

    if (request.max_tokens !== undefined) {
      fullRequest.max_tokens = request.max_tokens;
    } else if (this.config.maxTokens !== undefined) {
      fullRequest.max_tokens = this.config.maxTokens;
    }
    if (request.reasoning_effort !== undefined) {
      fullRequest.reasoning_effort = request.reasoning_effort;
    }

    // Add function calling parameters if provided
    if (request.functions) {
      fullRequest.functions = request.functions;
    }
    if (request.function_call) {
      fullRequest.function_call = request.function_call;
    }

    // Add search_parameters if provided
    if (request.search_parameters) {
      fullRequest.search_parameters = request.search_parameters;
    }

    try {
      const response: AxiosResponse<GrokChatResponse> =
        await this.limiter.schedule(() =>
          this.withRetries(
            () => this.client.post("/chat/completions", fullRequest),
            "chatCompletion",
          ),
        );
      this.cache.set(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error(
        {
          err: error,
          request: {
            model: fullRequest.model,
            messageCount: fullRequest.messages?.length,
            hasSearchParams: !!fullRequest.search_parameters,
          },
        },
        "Grok API chatCompletion error",
      );
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const isTimeout = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
        const errorMessage = isTimeout
          ? `Request timed out after ${this.config.timeoutMs ?? 60000}ms. Consider increasing GROK_TIMEOUT_MS.`
          : (errorData?.error?.message ||
             errorData?.error ||
             errorData?.message ||
             error.message);
        logger.error(
          {
            status: error.response?.status,
            code: error.code,
            errorData,
            errorMessage,
          },
          "Detailed Grok API error",
        );
        throw new Error(
          `Grok API Error: ${isTimeout ? "TIMEOUT" : error.response?.status} - ${errorMessage}`,
        );
      }
      throw error;
    }
  }

  /**
   * Perform a live search using Grok's Responses API web_search tool.
   */
  async liveSearch(request: GrokSearchRequest): Promise<GrokSearchResponse> {
    const cacheKey = JSON.stringify({ type: "search", ...request });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, "Cache hit for liveSearch");
      return cached;
    }
    try {
      // Prefer the current flagship reasoning model unless caller selects another
      const searchModel = this.config.model.includes("grok-4")
        ? this.config.model
        : "grok-4.5";

      const {
        normalizedMaxResults,
        userPrompt,
        webSearchTool,
      } = this.buildLegacySearchPromptAndTool(request);

      // Enhance web_search tool with modern flags
      const webTool: any = { ...webSearchTool };
      if (request.enable_image_understanding) {
        webTool.enable_image_understanding = true;
      }
      if (request.enable_image_search) {
        webTool.enable_image_search = true;
      }

      const tools: any[] = [];
      const includeWeb = request.search_web !== false; // default true
      if (includeWeb) {
        tools.push(webTool);
      }

      const wantsX =
        request.include_x_search ||
        (request.search_parameters?.sources || []).some((s: any) => s?.type === "x");

      if (wantsX) {
        tools.push({ type: "x_search" as const });
      }

      // If neither, fall back to web
      if (tools.length === 0) {
        tools.push(webTool);
      }

      const responsePayload = {
        model: searchModel,
        input: [
          {
            role: "system" as const,
            content:
              "You are a factual search assistant. When using web search, provide citations and concise summaries.",
          },
          {
            role: "user" as const,
            content: userPrompt,
          },
        ],
        tools,
        max_output_tokens: 1200,
        temperature: 0.1,
      };

      logger.info(
        { model: responsePayload.model, query: request.query },
        "Executing live search request",
      );

      const searchTimeoutMs = this.config.searchTimeoutMs ?? this.config.timeoutMs ?? 120000;
      const response: AxiosResponse = await this.limiter.schedule(() =>
        this.withRetries(
          () =>
            this.client.post("/responses", responsePayload, {
              timeout: searchTimeoutMs,
            }),
          "liveSearch",
        ),
      );

      const output = Array.isArray(response.data?.output)
        ? response.data.output
        : [];
      const extractedContentParts: string[] = [];
      const citations: any[] = [];

      const appendCitations = (items: any[]) => {
        for (const c of items || []) {
          if (c) citations.push(c);
        }
      };

      for (const outputItem of output) {
        if (Array.isArray(outputItem?.citations)) {
          appendCitations(outputItem.citations);
        }

        if (!Array.isArray(outputItem?.content)) {
          continue;
        }

        for (const part of outputItem.content) {
          if (typeof part === "string") {
            extractedContentParts.push(part);
            continue;
          }

          if (part?.type === "output_text" && typeof part.text === "string") {
            extractedContentParts.push(part.text);
          } else if (typeof part?.content === "string") {
            extractedContentParts.push(part.content);
          }

          if (Array.isArray(part?.citations)) {
            appendCitations(part.citations);
          }
          if (Array.isArray(part?.metadata?.citations)) {
            appendCitations(part.metadata.citations);
          }

          // Modern Responses API annotations for inline citations / sources
          if (Array.isArray(part?.annotations)) {
            for (const ann of part.annotations) {
              if (ann && (ann.url || ann.data?.url)) {
                appendCitations([ann]);
              }
            }
          }
        }
      }

      const content = extractedContentParts
        .filter(Boolean)
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .join("\n\n");

      if (Array.isArray(response.data?.citations)) {
        appendCitations(response.data.citations);
      }

      // Also collect from top-level annotations if present (structured citations)
      if (Array.isArray(response.data?.annotations)) {
        appendCitations(response.data.annotations);
      }

      const normalizedCitations = citations.filter(Boolean);

      // Build search results from citations
      const results: Array<{
        title: string;
        url: string;
        snippet: string;
        published_date?: string;
        source?: string;
      }> = [];

      const contentSnippet =
        content.length > 0
          ? content.substring(0, 200) + (content.length > 200 ? "..." : "")
          : "";

      if (normalizedCitations.length > 0) {
        // Use actual citations from the API response
        for (const citation of normalizedCitations) {
          if (typeof citation === "string") {
            results.push({
              title: citation,
              url: citation,
              snippet: contentSnippet,
            });
            continue;
          }

          results.push({
            title: citation.title || citation.url || "Search Result",
            url: citation.url || citation.link || "",
            snippet: citation.snippet || citation.text || contentSnippet,
            published_date: citation.published_date,
            source: citation.source,
          });
        }
      } else {
        // Parse results from the content if no citations returned
        // Add the full response as a single result
        results.push({
          title: `Search results for: ${request.query}`,
          url: `https://x.ai/search?q=${encodeURIComponent(request.query)}`,
          snippet:
            content.substring(0, 500) + (content.length > 500 ? "..." : ""),
        });
      }

      // If Grok returns no usable results, try Perplexity fallback when configured
      if (results.length === 0) {
        logger.warn(
          { query: request.query },
          "No search results from Grok, attempting Perplexity fallback",
        );
        if (this.perplexityClient) {
          const perplexityResults = await this.perplexitySearch(request);
          this.cache.set(cacheKey, perplexityResults);
          return perplexityResults;
        }
        const simulated = await this.simulateSearch(request);
        this.cache.set(cacheKey, simulated);
        return simulated;
      }

      const searchResponse: GrokSearchResponse = {
        results: results.slice(0, normalizedMaxResults),
        total_results: results.length,
        search_time: 0.5,
      };

      this.cache.set(cacheKey, searchResponse);
      return searchResponse;
    } catch (error) {
      logger.error({ err: error }, "Grok API liveSearch error");
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const errorMessage =
          errorData?.error?.message ||
          errorData?.error ||
          errorData?.message ||
          error.message;
        logger.warn(
          {
            status: error.response?.status,
            errorMessage,
            errorData,
          },
          "Live search via Responses API failed, using fallback",
        );
        // Try Perplexity first if available
        if (this.perplexityClient) {
          try {
            const perplexityResults = await this.perplexitySearch(request);
            this.cache.set(cacheKey, perplexityResults);
            return perplexityResults;
          } catch (perplexityError) {
            logger.warn(
              { err: perplexityError },
              "Perplexity fallback failed, using simulated search",
            );
          }
        }
        const simulated = await this.simulateSearch(request);
        this.cache.set(cacheKey, simulated);
        return simulated;
      }
      throw error;
    }
  }

  /**
   * Build prompt + web_search tool config (with filters from legacy) for the
   * Responses API. Modern flags (enable_*) are applied on top in liveSearch.
   * Legacy search_parameters are still supported for the grok_search tool schema.
   */
  private buildLegacySearchPromptAndTool(request: GrokSearchRequest): {
    normalizedMaxResults: number;
    userPrompt: string;
    webSearchTool: {
      type: "web_search";
      filters?: {
        allowed_domains?: string[];
        excluded_domains?: string[];
      };
    };
  } {
    const normalizedMaxResults =
      this.resolveSearchMaxResults(request.search_parameters, request.max_results);

    const webSearchHints: string[] = [];
    const filters = this.buildLegacySearchFilters(request.search_parameters);

    if (request.search_parameters?.mode === "off") {
      logger.info(
        { query: request.query },
        "search_parameters.mode is off; using request-level compatibility behavior for web search tool",
      );
    }

    if (request.time_filter && request.time_filter !== "all") {
      webSearchHints.push(`Search within the last ${request.time_filter}.`);
    }

    if (
      request.search_parameters?.from_date ||
      request.search_parameters?.to_date
    ) {
      if (request.search_parameters.from_date && request.search_parameters.to_date) {
        webSearchHints.push(
          `Filter results between ${request.search_parameters.from_date} and ${request.search_parameters.to_date}.`,
        );
      } else if (request.search_parameters.from_date) {
        webSearchHints.push(
          `Filter results from ${request.search_parameters.from_date} onward.`,
        );
      } else if (request.search_parameters.to_date) {
        webSearchHints.push(
          `Filter results to ${request.search_parameters.to_date} or earlier.`,
        );
      }
    }

    if (request.include_news === false || request.search_parameters?.mode === "off") {
      webSearchHints.push("Exclude news results if possible.");
    }

    const allowedDomains = filters?.allowed_domains?.join(", ");
    const excludedDomains = filters?.excluded_domains?.join(", ");
    if (allowedDomains) {
      webSearchHints.push(`Only search allowed domains: ${allowedDomains}.`);
    }
    if (excludedDomains) {
      webSearchHints.push(`Exclude domains: ${excludedDomains}.`);
    }

    webSearchHints.push(`Return up to ${normalizedMaxResults} results.`);

    const userPrompt = [
      `Search for: ${request.query}`,
      ...webSearchHints,
    ].join(" ");

    const webSearchTool = filters
      ? { type: "web_search" as const, filters }
      : { type: "web_search" as const };

    return {
      normalizedMaxResults,
      userPrompt: userPrompt.replace(/\s+/g, " ").trim(),
      webSearchTool,
    };
  }

  private buildLegacySearchFilters(
    searchParameters?: GrokSearchParameters,
  ):
    | {
        allowed_domains?: string[];
        excluded_domains?: string[];
      }
    | undefined {
    if (!searchParameters?.sources?.length) {
      return undefined;
    }

    const webSources = searchParameters.sources.filter(
      (source) => source.type === "web",
    );
    if (!webSources.length) {
      return undefined;
    }

    const allowed = this.normalizeSearchDomains(
      webSources.flatMap((source) => source.allowed_websites || []),
    );
    const excluded = this.normalizeSearchDomains(
      webSources.flatMap((source) => source.excluded_websites || []),
    );

    if (allowed.length > 0 && excluded.length > 0) {
      logger.warn(
        {
          query: "legacy search",
          allowed,
          excluded,
        },
        "Both allowed and excluded search domains supplied in legacy sources; dropping filters to avoid invalid web_search request.",
      );
      return undefined;
    }

    if (allowed.length > 0) {
      return { allowed_domains: allowed.slice(0, 5) };
    }

    if (excluded.length > 0) {
      return { excluded_domains: excluded.slice(0, 5) };
    }

    return undefined;
  }

  private normalizeSearchDomains(domains: string[]): string[] {
    return Array.from(
      new Set(
        domains
          .map((domain) => (typeof domain === "string" ? domain.trim() : ""))
          .filter(Boolean),
      ),
    );
  }

  private extractSourceMaxResults(
    searchParameters?: GrokSearchParameters,
  ): number | undefined {
    if (!searchParameters?.sources?.length) {
      return undefined;
    }

    const sourceMaxes = searchParameters.sources
      .map((source) => source.max_results)
      .filter((value): value is number => typeof value === "number" && value > 0);

    return sourceMaxes.length > 0 ? Math.max(...sourceMaxes) : undefined;
  }

  private resolveSearchMaxResults(
    searchParameters: GrokSearchParameters | undefined,
    maxResultsOverride?: number,
  ): number {
    if (maxResultsOverride && maxResultsOverride > 0) {
      return maxResultsOverride;
    }

    if (searchParameters?.max_search_results && searchParameters.max_search_results > 0) {
      return searchParameters.max_search_results;
    }

    const sourceMaxResults = this.extractSourceMaxResults(searchParameters);
    if (sourceMaxResults && sourceMaxResults > 0) {
      return sourceMaxResults;
    }

    return 10;
  }

  /**
   * Perplexity fallback search using online model (if PERPLEXITY_API_KEY is configured)
   */
  private async perplexitySearch(
    request: GrokSearchRequest,
  ): Promise<GrokSearchResponse> {
    if (!this.perplexityClient) {
      throw new Error("Perplexity client not configured");
    }

    const maxResults = this.resolveSearchMaxResults(
      request.search_parameters,
      request.max_results,
    );
    const model = this.config.perplexityModel || "sonar-reasoning-pro";
    const limiter = this.getPerplexityLimiter(model);
    const payload = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a search agent. Return concise citations for the query.",
        },
        {
          role: "user",
          content: `Search for: ${request.query} (Return up to ${maxResults} results).`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.1,
    };

    try {
      let response: AxiosResponse | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await limiter.schedule(() =>
            this.perplexityClient!.post("/chat/completions", payload),
          );
          break;
        } catch (err: any) {
          const status = err?.response?.status;
          if (status === 429 && attempt < 2) {
            const waitMs = 500 * (attempt + 1);
            logger.warn(
              { waitMs, attempt, status },
              "Perplexity rate limited, backing off",
            );
            await this.delay(waitMs);
            continue;
          }
          throw err;
        }
      }

      if (!response) {
        throw new Error("Perplexity response missing");
      }

      const choice = response.data?.choices?.[0];
      const rawContent = choice?.message?.content ?? "";
      const content =
        typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent
                .map((part: any) => {
                  if (typeof part === "string") return part;
                  if (typeof part?.text === "string") return part.text;
                  return "";
                })
                .filter(Boolean)
                .join("\n")
                .trim()
            : String(rawContent ?? "");

      const citations = Array.isArray(response.data?.citations)
        ? response.data.citations
        : Array.isArray(choice?.citations)
          ? choice.citations
          : Array.isArray(choice?.message?.citations)
            ? choice.message.citations
            : [];

      const results = citations
        .map((c: any) => {
          if (typeof c === "string") {
            return {
              title: c,
              url: c,
              snippet: content.substring(0, 200),
            };
          }
          return {
            title: c?.title || c?.url || "Perplexity result",
            url: c?.url || "",
            snippet: c?.snippet || c?.text || content.substring(0, 200),
            published_date: c?.published_date,
            source: "perplexity",
          };
        })
        .filter((r: { url?: string }) => r.url);

      if (results.length === 0) {
        results.push({
          title: `Perplexity search: ${request.query}`,
          url: `https://www.perplexity.ai/search?q=${encodeURIComponent(request.query)}`,
          snippet:
            content.substring(0, 500) + (content.length > 500 ? "..." : ""),
          source: "perplexity",
        });
      }

      return {
        results: results.slice(0, maxResults),
        total_results: results.length,
        search_time: 0.6,
      };
    } catch (error) {
      logger.error({ err: error }, "Perplexity search failed");
      throw error;
    }
  }

  private getPerplexityLimiter(model: string): Bottleneck {
    if (this.perplexityLimiters.has(model)) {
      return this.perplexityLimiters.get(model)!;
    }
    const rpm = PERPLEXITY_MODEL_LIMITS[model] || 50;
    const minTime = Math.max(50, Math.ceil(60000 / rpm));
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime });
    this.perplexityLimiters.set(model, limiter);
    return limiter;
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Determine whether an Axios error is retryable.
   */
  private isRetryableError(error: any): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    // Retry on network errors, timeouts, and 5xx / 429 responses.
    const status = error.response?.status;
    if (status === 429 || (status && status >= 500)) {
      return true;
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return true;
    }
    return !error.response; // network-level failure without response
  }

  /**
   * Execute an Axios request with retries and exponential backoff.
   */
  private async withRetries<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    const maxRetries = this.config.retries ?? 2;
    const baseDelay = this.config.retryDelayMs ?? 1000;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const isLast = attempt === maxRetries;
        if (isLast || !this.isRetryableError(error)) {
          throw error;
        }
        const waitMs = baseDelay * 2 ** attempt;
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries,
            operation: operationName,
            waitMs,
            error: axios.isAxiosError(error)
              ? {
                  code: error.code,
                  status: error.response?.status,
                  message: error.message,
                }
              : (error as Error)?.message,
          },
          `${operationName} failed, retrying`,
        );
        await this.delay(waitMs);
      }
    }

    throw lastError;
  }

  /**
   * Simulate search using chat completion when live search is unavailable
   */
  private async simulateSearch(
    request: GrokSearchRequest,
  ): Promise<GrokSearchResponse> {
    const maxResults = this.resolveSearchMaxResults(
      request.search_parameters,
      request.max_results,
    );
    const searchPrompt = `I need you to simulate web search results for the query: "${request.query}"

Please provide ${maxResults} realistic search results that someone would find when searching for this topic online.

Respond with ONLY valid JSON in this exact format:
{
  "results": [
    {
      "title": "Title of the webpage",
      "url": "https://example.com/page",
      "snippet": "Brief description of what this page contains",
      "published_date": "2024-01-01" (optional)
    }
  ]
}

Make sure:
- URLs are realistic and related to the topic
- Snippets are informative and relevant
- No extra text outside the JSON
- Each result has title, url, and snippet`;

    const chatResponse = await this.chatCompletion({
      messages: [
        {
          role: "system",
          content:
            "You are a search results generator. Respond ONLY with valid JSON. Do not include any explanation or additional text.",
        },
        { role: "user", content: searchPrompt },
      ],
      temperature: 0.1, // Lower temperature for more consistent JSON
      max_tokens: 2000,
    });

    try {
      let content =
        chatResponse.choices[0]?.message?.content || '{"results": []}';

      // Clean up the content to extract JSON
      content = content.trim();

      // Remove markdown code blocks if present
      content = content.replace(/```json\n?|```\n?/g, "");

      // Try to find JSON in the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        content = jsonMatch[0];
      }

      const parsed = JSON.parse(content);

      return {
        results: parsed.results || [],
        total_results: parsed.results?.length || 0,
        search_time: 0.5,
      };
    } catch (parseError) {
      logger.error(
        { err: parseError, content: chatResponse.choices[0]?.message?.content },
        "Failed to parse search results",
      );

      // Return fallback results based on the query
      const fallbackResults = [
        {
          title: `Search results for: ${request.query}`,
          url: `https://www.google.com/search?q=${encodeURIComponent(request.query)}`,
          snippet: `Information about ${request.query} - simulated search result as the live search API is not available.`,
        },
      ];

      return {
        results: fallbackResults,
        total_results: fallbackResults.length,
        search_time: 0.5,
      };
    }
  }

  /**
   * Ask Grok a question with optional context
   */
  async ask(
    question: string,
    context?: string,
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      includeSearch?: boolean;
      // Modern search flags (passed to liveSearch when includeSearch is active)
      enable_image_understanding?: boolean;
      enable_image_search?: boolean;
      include_x_search?: boolean;
      model?: string;
      reasoningEffort?: "none" | "low" | "medium" | "high";
    },
  ): Promise<string> {
    const messages = [];

    if (systemPrompt) {
      messages.push({ role: "system" as const, content: systemPrompt });
    }

    if (context) {
      messages.push({
        role: "user" as const,
        content: `Context: ${context}\n\nQuestion: ${question}`,
      });
    } else {
      messages.push({ role: "user" as const, content: question });
    }

    // If search is requested, add recent information
    if (options?.includeSearch) {
      try {
        const searchResults = await this.liveSearch({
          query: question,
          max_results: 3,
          enable_image_understanding: options?.enable_image_understanding,
          enable_image_search: options?.enable_image_search,
          include_x_search: options?.include_x_search,
        });
        if (searchResults.results.length > 0) {
          const searchContext = searchResults.results
            .map(
              (result, idx) =>
                `${idx + 1}. [${result.title}](${result.url})\n${result.snippet}${result.published_date ? ` (Published: ${result.published_date})` : ""}`,
            )
            .join("\n\n");

          messages.push({
            role: "system" as const,
            content: `Recent search results for context (use the links for citations if referencing):\n\n${searchContext}`,
          });
        }
      } catch (searchError) {
        logger.warn(
          { err: searchError },
          "Search failed, proceeding without search context",
        );
      }
    }

    const response = await this.chatCompletion({
      messages,
      model: options?.model,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      reasoning_effort: options?.reasoningEffort,
    });

    return response.choices[0]?.message?.content || "No response generated";
  }

  /**
   * Test the connection to Grok API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.chatCompletion({
        messages: [{ role: "user", content: "Hello, are you working?" }],
        max_tokens: 10,
      });
      return true;
    } catch (error) {
      logger.error({ err: error }, "Grok connection test failed");
      return false;
    }
  }

  /**
   * Get available models (if endpoint exists)
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await this.client.get("/models");
      return response.data.data?.map((model: any) => model.id) || ["grok-4.5"];
    } catch (error) {
      logger.warn(
        { err: error },
        "Models endpoint not available, using default models",
      );
      return [
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
      ];
    }
  }
}
