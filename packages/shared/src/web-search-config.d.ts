export type SearchProviderName =
  | 'brave'
  | 'perplexity'
  | 'tavily'
  | 'duckduckgo'
  | 'searxng';

export type SearchProviderMode = SearchProviderName | 'auto';

export type WebSearchSecretRef =
  | { source: 'env'; id: string }
  | { source: 'store'; id: string };

export interface WebSearchConfig {
  provider: SearchProviderMode;
  fallbackProviders: SearchProviderName[];
  defaultCount: number;
  cacheTtlMinutes: number;
  searxngBaseUrl: string;
  searxngBearerTokenRef?: WebSearchSecretRef;
  tavilySearchDepth: 'basic' | 'advanced';
  braveApiKey?: string;
  perplexityApiKey?: string;
  tavilyApiKey?: string;
}

export declare const WEB_SEARCH_PROVIDER_NAMES: SearchProviderName[];
