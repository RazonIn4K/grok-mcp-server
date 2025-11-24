import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { 
  GrokChatRequest, 
  GrokChatResponse, 
  GrokSearchRequest, 
  GrokSearchResponse,
  GrokConfig 
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
   * Perform a live search using Grok's search capabilities
   */
  async liveSearch(request: GrokSearchRequest): Promise<GrokSearchResponse> {
    const cacheKey = JSON.stringify({ type: 'search', ...request });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, 'Cache hit for liveSearch');
      return cached;
    }
    try {
      const response: AxiosResponse<GrokSearchResponse> = await this.limiter.schedule(() =>
        this.client.post('/search', request)
      );
      this.cache.set(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error({ err: error }, 'Grok API liveSearch error');
      if (axios.isAxiosError(error)) {
        // Fallback: if live search is not available (404 or other errors), simulate it with chat completion
        logger.warn('Live search endpoint not available, using chat completion with search context');
        return this.simulateSearch(request);
      }
      throw error;
    }
  }

  /**
   * Simulate search using chat completion when live search is unavailable
   */
  private async simulateSearch(request: GrokSearchRequest): Promise<GrokSearchResponse> {
    const searchPrompt = `I need you to simulate web search results for the query: "${request.query}"

Please provide ${request.max_results || 5} realistic search results that someone would find when searching for this topic online.

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
        { role: 'system', content: 'You are a search results generator. Respond ONLY with valid JSON. Do not include any explanation or additional text.' },
        { role: 'user', content: searchPrompt }
      ],
      temperature: 0.1, // Lower temperature for more consistent JSON
      max_tokens: 2000,
    });

    try {
      let content = chatResponse.choices[0]?.message?.content || '{"results": []}';
      
      // Clean up the content to extract JSON
      content = content.trim();
      
      // Remove markdown code blocks if present
      content = content.replace(/```json\n?|```\n?/g, '');
      
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
      logger.error({ err: parseError, content: chatResponse.choices[0]?.message?.content }, 'Failed to parse search results');
      
      // Return fallback results based on the query
      const fallbackResults = [
        {
          title: `Search results for: ${request.query}`,
          url: `https://www.google.com/search?q=${encodeURIComponent(request.query)}`,
          snippet: `Information about ${request.query} - simulated search result as the live search API is not available.`,
        }
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

    // If search is requested, add recent information
    if (options?.includeSearch) {
      try {
        const searchResults = await this.liveSearch({ query: question, max_results: 3 });
        if (searchResults.results.length > 0) {
          const searchContext = searchResults.results
            .map(result => `Title: ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`)
            .join('\n\n');
          
          messages.push({
            role: 'system' as const,
            content: `Recent search results for context:\n\n${searchContext}`
          });
        }
      } catch (searchError) {
        logger.warn({ err: searchError }, 'Search failed, proceeding without search context');
      }
    }

    const response = await this.chatCompletion({
      messages,
      model: options?.model,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
    });

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
      return response.data.data?.map((model: any) => model.id) || ['grok-4'];
    } catch (error) {
      logger.warn({ err: error }, 'Models endpoint not available, using default models');
      return ['grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1', 'grok-4', 'grok-3'];
    }
  }
}