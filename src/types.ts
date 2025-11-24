export interface GrokMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GrokChatRequest {
  model: string;
  messages: GrokMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  functions?: GrokFunction[];
  function_call?: string | { name: string };
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
  include_images?: boolean;
  include_news?: boolean;
  time_filter?: 'day' | 'week' | 'month' | 'year' | 'all';
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
}

export interface GrokConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}