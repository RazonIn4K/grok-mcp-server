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
import { redactSecrets, toSafeError } from "./safe-error.js";

const MAX_ATTEMPT_TIMEOUT_MS = 45000;
const MAX_OVERALL_TIMEOUT_MS = 90000;
const MAX_RETRIES = 1;

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finiteValue = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(finiteValue)));
}

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
  redact: {
    paths: [
      "apiKey",
      "*.apiKey",
      "headers.Authorization",
      "headers.authorization",
      "config.headers.Authorization",
      "config.headers.authorization",
      "err.config.headers.Authorization",
      "err.config.headers.authorization",
      "err.request._options.headers.Authorization",
      "err.request._options.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
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

  getRuntimeStatus() {
    const counts = this.limiter.counts();
    return {
      model: this.config.model,
      timeout_ms: this.config.timeoutMs ?? 45000,
      ask_overall_timeout_ms: this.config.askOverallTimeoutMs ?? 90000,
      retries: this.config.retries ?? 1,
      search_timeout_ms: this.config.searchTimeoutMs ?? 45000,
      search_overall_timeout_ms:
        this.config.searchOverallTimeoutMs ?? 90000,
      search_retries: this.config.searchRetries ?? 0,
      cache_entries: this.cache.size,
      limiter: {
        running: counts.RUNNING,
        queued: counts.QUEUED,
      },
    };
  }

  constructor(config: GrokConfig) {
    this.config = {
      ...config,
      timeoutMs: clampInteger(
        config.timeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS,
        1,
        MAX_ATTEMPT_TIMEOUT_MS,
      ),
      askOverallTimeoutMs: clampInteger(
        config.askOverallTimeoutMs ?? MAX_OVERALL_TIMEOUT_MS,
        1,
        MAX_OVERALL_TIMEOUT_MS,
      ),
      searchTimeoutMs: clampInteger(
        config.searchTimeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS,
        1,
        MAX_ATTEMPT_TIMEOUT_MS,
      ),
      searchOverallTimeoutMs: clampInteger(
        config.searchOverallTimeoutMs ?? MAX_OVERALL_TIMEOUT_MS,
        1,
        MAX_OVERALL_TIMEOUT_MS,
      ),
      retries: clampInteger(config.retries ?? MAX_RETRIES, 0, MAX_RETRIES),
      searchRetries: clampInteger(
        config.searchRetries ?? 0,
        0,
        MAX_RETRIES,
      ),
    };
    this.cache = new LRUCache({ max: 100, ttl: 1000 * 60 * 5 }); // 5 min cache
    this.limiter = new Bottleneck({
      maxConcurrent: config.maxConcurrent ?? 2,
      minTime: config.minTimeMs ?? 500,
    });
    this.perplexityLimiters = new Map();
    const timeoutMs = this.config.timeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS;
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
        timeout: this.config.searchTimeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS,
      });
    }
  }

  /**
   * Send a chat completion request to Grok 4.5 or another configured text model.
   */
  async chatCompletion(
    request: Partial<GrokChatRequest>,
    execution?: {
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<GrokChatResponse> {
    const executionTimeoutMs =
      execution?.timeoutMs === undefined
        ? undefined
        : clampInteger(
            execution.timeoutMs,
            1,
            this.config.timeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS,
          );
    const executionRetries =
      execution?.retries === undefined
        ? undefined
        : clampInteger(
            execution.retries,
            0,
            this.config.retries ?? MAX_RETRIES,
          );
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
    // xAI's Grok 4.5 rejects the literal value "none". Treat it as the
    // compatibility spelling for omitting reasoning_effort altogether.
    if (
      request.reasoning_effort !== undefined &&
      request.reasoning_effort !== "none"
    ) {
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
            () =>
              executionTimeoutMs
                ? this.client.post("/chat/completions", fullRequest, {
                    timeout: executionTimeoutMs,
                  })
                : this.client.post("/chat/completions", fullRequest),
            "chatCompletion",
            executionRetries,
          ),
        );
      this.cache.set(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error(
        {
          error: toSafeError(error),
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
          ? `Request timed out after ${executionTimeoutMs ?? this.config.timeoutMs ?? MAX_ATTEMPT_TIMEOUT_MS}ms.`
          : (errorData?.error?.message ||
             errorData?.error ||
             errorData?.message ||
             redactSecrets(error.message));
        logger.error(
          {
            status: error.response?.status,
            code: error.code,
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
  async liveSearch(
    request: GrokSearchRequest,
    overallTimeoutMs = this.config.searchOverallTimeoutMs ?? 90000,
  ): Promise<GrokSearchResponse> {
    const effectiveOverallTimeoutMs = clampInteger(
      overallTimeoutMs,
      1,
      this.config.searchOverallTimeoutMs ?? MAX_OVERALL_TIMEOUT_MS,
    );
    const startedAt = Date.now();
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

      const searchTimeoutMs =
        this.config.searchTimeoutMs ?? this.config.timeoutMs ?? 45000;
      const response: AxiosResponse = await this.limiter.schedule(() =>
        this.withRetries(
          () => {
            const remainingMs = this.remainingSearchBudgetMs(
              startedAt,
              effectiveOverallTimeoutMs,
            );
            if (remainingMs <= 0) {
              throw new Error("Search deadline exhausted before xAI request");
            }
            return this.client.post("/responses", responsePayload, {
              timeout: Math.min(searchTimeoutMs, remainingMs),
            });
          },
          "liveSearch",
          this.config.searchRetries ?? 0,
          () =>
            this.remainingSearchBudgetMs(
              startedAt,
              effectiveOverallTimeoutMs,
            ),
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
      } else if (content.length > 0) {
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
        return this.fallbackSearch(
          request,
          cacheKey,
          startedAt,
          effectiveOverallTimeoutMs,
        );
      }

      const searchResponse: GrokSearchResponse = {
        results: results.slice(0, normalizedMaxResults),
        total_results: results.length,
        search_time: this.elapsedSeconds(startedAt),
      };

      this.cache.set(cacheKey, searchResponse);
      return searchResponse;
    } catch (error) {
      logger.error(
        { error: toSafeError(error) },
        "Grok API liveSearch error",
      );
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const errorMessage =
          errorData?.error?.message ||
          errorData?.error ||
          errorData?.message ||
          redactSecrets(error.message);
        logger.warn(
          {
            status: error.response?.status,
            errorMessage,
          },
          "Live search via Responses API failed, using fallback",
        );
      }
      return this.fallbackSearch(
        request,
        cacheKey,
        startedAt,
        effectiveOverallTimeoutMs,
      );
    }
  }

  private elapsedSeconds(startedAt: number): number {
    return Number(((Date.now() - startedAt) / 1000).toFixed(3));
  }

  private remainingSearchBudgetMs(
    startedAt: number,
    overallTimeoutMs: number,
  ): number {
    return Math.max(0, overallTimeoutMs - (Date.now() - startedAt));
  }

  private async fallbackSearch(
    request: GrokSearchRequest,
    cacheKey: string,
    startedAt: number,
    overallTimeoutMs: number,
  ): Promise<GrokSearchResponse> {
    const remainingMs = this.remainingSearchBudgetMs(
      startedAt,
      overallTimeoutMs,
    );

    if (this.perplexityClient && remainingMs >= 1000) {
      try {
        const perplexityResults = await this.perplexitySearch(
          request,
          Date.now() + remainingMs,
        );
        perplexityResults.search_time = this.elapsedSeconds(startedAt);
        this.cache.set(cacheKey, perplexityResults);
        return perplexityResults;
      } catch (error) {
        logger.warn(
          { error: toSafeError(error) },
          "Perplexity fallback failed or exhausted the search budget",
        );
      }
    }

    const fallback: GrokSearchResponse = {
      results: [
        {
          title: "Live search temporarily unavailable",
          url: `https://www.google.com/search?q=${encodeURIComponent(request.query)}`,
          snippet:
            "The configured live-search providers did not return within the request budget. Open this search link or retry shortly.",
          source: "fallback",
        },
      ],
      total_results: 1,
      search_time: this.elapsedSeconds(startedAt),
      degraded: true,
    };

    // Avoid a thundering herd while allowing a quick recovery on the next try.
    this.cache.set(cacheKey, fallback, { ttl: 10000 });
    return fallback;
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
    deadlineAt: number,
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
            this.perplexityClient!.post("/chat/completions", payload, {
              timeout: Math.max(1, deadlineAt - Date.now()),
            }),
          );
          break;
        } catch (err: any) {
          const status = err?.response?.status;
          if (status === 429 && attempt < 2) {
            const waitMs = 500 * (attempt + 1);
            if (Date.now() + waitMs >= deadlineAt) {
              throw err;
            }
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
        search_time: 0,
      };
    } catch (error) {
      logger.error(
        { error: toSafeError(error) },
        "Perplexity search failed",
      );
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
    maxRetriesOverride?: number,
    remainingBudgetMs?: () => number,
  ): Promise<T> {
    const configuredRetries = this.config.retries ?? MAX_RETRIES;
    const maxRetries = clampInteger(
      maxRetriesOverride ?? configuredRetries,
      0,
      configuredRetries,
    );
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
        const remainingMs = remainingBudgetMs?.();
        if (remainingMs !== undefined && remainingMs <= waitMs) {
          throw error;
        }
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries,
            operation: operationName,
            waitMs,
            error: toSafeError(error),
          },
          `${operationName} failed, retrying`,
        );
        await this.delay(waitMs);
      }
    }

    throw lastError;
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
    const startedAt = Date.now();
    const overallTimeoutMs = this.config.askOverallTimeoutMs ?? 90000;
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
        const remainingBeforeSearchMs = Math.max(
          0,
          overallTimeoutMs - (Date.now() - startedAt),
        );
        const searchBudgetMs = Math.min(
          this.config.searchOverallTimeoutMs ?? 90000,
          Math.floor(remainingBeforeSearchMs / 2),
        );
        if (searchBudgetMs <= 0) {
          throw new Error("Ask deadline has no remaining search budget");
        }
        const searchResults = await this.liveSearch(
          {
            query: question,
            max_results: 3,
            enable_image_understanding: options?.enable_image_understanding,
            enable_image_search: options?.enable_image_search,
            include_x_search: options?.include_x_search,
          },
          searchBudgetMs,
        );
        if (!searchResults.degraded && searchResults.results.length > 0) {
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
          { error: toSafeError(searchError) },
          "Search failed, proceeding without search context",
        );
      }
    }

    const remainingMs = Math.max(
      1,
      overallTimeoutMs - (Date.now() - startedAt),
    );
    const response = await this.chatCompletion(
      {
        messages,
        model: options?.model,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        reasoning_effort: options?.reasoningEffort,
      },
      options?.includeSearch
        ? {
            timeoutMs: Math.min(
              this.config.timeoutMs ?? 45000,
              remainingMs,
            ),
            retries: 0,
          }
        : undefined,
    );

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
      logger.error(
        { error: toSafeError(error) },
        "Grok connection test failed",
      );
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
        { error: toSafeError(error) },
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
