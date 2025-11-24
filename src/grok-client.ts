import axios, { AxiosInstance, AxiosResponse } from 'axios';
import {
  GrokChatRequest,
  GrokChatResponse,
  GrokSearchRequest,
  GrokSearchResponse,
  GrokConfig,
  SearchParameters
} from './types.js';
import { ExternalServiceError } from './errors.js';
import { LRUCache } from 'lru-cache';
import Bottleneck from 'bottleneck';
import Agent from 'agentkeepalive';
import pino from 'pino';
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

export class GrokClient {
  private client: AxiosInstance;
  private config: GrokConfig;
  private cache: LRUCache<string, any>;
  private limiter: Bottleneck;

  constructor(config: GrokConfig) {
    this.config = config;
    this.cache = new LRUCache({ max: 100, ttl: 1000 * 60 * 5 }); // 5 min cache
    this.limiter = new Bottleneck({ maxConcurrent: 2, minTime: 500 }); // 2 concurrent, 500ms min interval
    this.client = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000, // Increased to 60 seconds
      httpAgent: new Agent({ maxSockets: 10, keepAlive: true }),
      httpsAgent: new Agent.HttpsAgent({ maxSockets: 10, keepAlive: true }),
    });
  }

  /**
   * Send a chat completion request to Grok 4
   */
  async chatCompletion(request: Partial<GrokChatRequest>): Promise<GrokChatResponse> {
    const cacheKey = JSON.stringify({ type: 'chat', ...request });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, 'Cache hit for chatCompletion');
      return cached;
    }
    const fullRequest: GrokChatRequest = {
      model: request.model || this.config.model,
      messages: request.messages || [],
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.max_tokens ?? this.config.maxTokens,
      stream: false,
      ...request,
    };

    try {
      const response: AxiosResponse<GrokChatResponse> = await this.limiter.schedule(() =>
        this.client.post('/chat/completions', fullRequest)
      );
      this.cache.set(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error({ err: error }, 'Grok API chatCompletion error');
      if (axios.isAxiosError(error)) {
        throw new Error(`Grok API Error: ${error.response?.status} - ${error.response?.data?.error?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Perform live search using Grok's integrated agentic search in chat completions
   * This uses the new search_parameters in the chat endpoint (post-Nov 2025 migration)
   */
  async liveSearch(request: GrokSearchRequest): Promise<GrokSearchResponse> {
    const cacheKey = JSON.stringify({ type: 'search', ...request });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, 'Cache hit for liveSearch');
      return cached;
    }

    try {
      // Convert search request to chat completion with search_parameters
      const chatResponse = await this.chatCompletion({
        messages: [
          {
            role: 'user',
            content: `Search for: ${request.query}`
          }
        ],
        search_parameters: {
          mode: 'always',
          return_citations: true,
          sources: request.include_news ? ['web', 'news'] : ['web'],
          from_date: request.time_filter === 'day' ? this.getDateOffset(1) :
                     request.time_filter === 'week' ? this.getDateOffset(7) :
                     request.time_filter === 'month' ? this.getDateOffset(30) :
                     request.time_filter === 'year' ? this.getDateOffset(365) : undefined,
        },
        temperature: 0.3, // Lower temperature for more focused search results
        max_tokens: 2000,
      });

      const message = chatResponse.choices[0]?.message;
      const content = message?.content || '';
      const citations = message?.citations || [];

      // Parse the response to extract search results
      const results = this.parseSearchResults(content, citations, request.max_results);

      const response: GrokSearchResponse = {
        results,
        total_results: results.length,
        search_time: 0.5,
      };

      this.cache.set(cacheKey, response);
      return response;
    } catch (error) {
      logger.error({ err: error }, 'Grok API liveSearch error');
      throw new ExternalServiceError(
        'Live search failed',
        500,
        { cause: error }
      );
    }
  }

  /**
   * Helper to get date offset in YYYY-MM-DD format
   */
  private getDateOffset(daysAgo: number): string {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date.toISOString().split('T')[0];
  }

  /**
   * Parse search results from chat response and citations
   */
  private parseSearchResults(
    content: string,
    citations: string[],
    maxResults?: number
  ): Array<{ title: string; url: string; snippet: string; published_date?: string; source?: string }> {
    const results = [];
    const limit = maxResults || 10;

    // If we have citations, create results from them
    if (citations && citations.length > 0) {
      for (const url of citations.slice(0, limit)) {
        results.push({
          title: this.extractTitleFromUrl(url),
          url,
          snippet: content.substring(0, 200), // Use first part of response as snippet
          source: new URL(url).hostname,
        });
      }
    }

    // If we don't have enough results from citations, try to parse from content
    if (results.length < limit) {
      // Look for structured data in the response (URLs, links, etc)
      const urlPattern = /https?:\/\/[^\s]+/g;
      const foundUrls = content.match(urlPattern) || [];

      for (const url of foundUrls.slice(0, limit - results.length)) {
        if (!citations.includes(url)) {
          results.push({
            title: this.extractTitleFromUrl(url),
            url,
            snippet: content.substring(0, 200),
            source: new URL(url).hostname,
          });
        }
      }
    }

    // If still no results, create a generic result from the content
    if (results.length === 0) {
      results.push({
        title: 'Search Result',
        url: 'https://grok.com',
        snippet: content.substring(0, 300),
        source: 'grok',
      });
    }

    return results;
  }

  /**
   * Helper to extract a title from a URL
   */
  private extractTitleFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.split('/').filter(Boolean).pop() || urlObj.hostname;
      return path.replace(/[-_]/g, ' ').substring(0, 100);
    } catch {
      return 'Search Result';
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
      model?: string;
    }
  ): Promise<string> {
    const messages = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system' as const, content: systemPrompt });
    }
    
    if (context) {
      messages.push({ 
        role: 'user' as const, 
        content: `Context: ${context}\n\nQuestion: ${question}` 
      });
    } else {
      messages.push({ role: 'user' as const, content: question });
    }

    // Build chat completion request
    const chatRequest: Partial<GrokChatRequest> = {
      messages,
      model: options?.model,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
    };

    // If search is requested, add search parameters to the request
    if (options?.includeSearch) {
      chatRequest.search_parameters = {
        mode: 'always',
        return_citations: true,
        sources: ['web', 'news'],
      };
    }

    const response = await this.chatCompletion(chatRequest);

    return response.choices[0]?.message?.content || 'No response generated';
  }

  /**
   * Test the connection to Grok API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.chatCompletion({
        messages: [{ role: 'user', content: 'Hello, are you working?' }],
        max_tokens: 10,
      });
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Grok connection test failed');
      return false;
    }
  }

  /**
   * Get available models (if endpoint exists)
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await this.client.get('/models');
      return response.data.data?.map((model: any) => model.id) || ['grok-4.1-fast'];
    } catch (error) {
      logger.warn({ err: error }, 'Models endpoint not available, using default models');
      return ['grok-4.1-fast', 'grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1', 'grok-4'];
    }
  }
}