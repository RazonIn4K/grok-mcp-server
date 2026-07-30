export interface GrokMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GrokSearchParameters {
  mode?: "auto" | "on" | "off";
  return_citations?: boolean;
  max_search_results?: number;
  sources?: Array<{
    type: "web" | "x" | "news" | "rss";
    max_results?: number;
    country?: string;
    excluded_websites?: string[];
    allowed_websites?: string[];
  }>;
  from_date?: string;
  to_date?: string;
}

export interface GrokChatRequest {
  model: string;
  messages: GrokMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: "none" | "low" | "medium" | "high";
  stream?: boolean;
  functions?: GrokFunction[];
  function_call?: string | { name: string };
  search_parameters?: GrokSearchParameters;
}

export interface GrokChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      function_call?: {
        name: string;
        arguments: string;
      };
      citations?: string[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GrokFunction {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface GrokSearchRequest {
  query: string;
  max_results?: number;
  include_news?: boolean;
  time_filter?: "day" | "week" | "month" | "year" | "all";
  search_parameters?: GrokSearchParameters;
  // Modern Responses API web_search / x_search tool options (preferred over legacy chat search_parameters)
  enable_image_understanding?: boolean;
  enable_image_search?: boolean;
  include_x_search?: boolean; // include x_search tool alongside or instead of web
  search_web?: boolean; // default true; set to false for pure X search (used by grok_x_search)
}

export interface GrokSearchResponse {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    published_date?: string;
    source?: string;
  }>;
  total_results: number;
  search_time: number;
  degraded?: boolean;
}

export interface GrokConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  perplexityApiKey?: string;
  perplexityModel?: string;
  // Timeout / retry configuration
  timeoutMs?: number;
  askOverallTimeoutMs?: number;
  searchTimeoutMs?: number;
  searchOverallTimeoutMs?: number;
  retries?: number;
  searchRetries?: number;
  retryDelayMs?: number;
  maxConcurrent?: number;
  minTimeMs?: number;
}
