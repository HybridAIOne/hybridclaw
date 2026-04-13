# Web Search

`web_search` finds current public web results and returns titles, URLs, and snippets. It is meant to pair with `web_fetch`: search first when the target URL is unknown, then fetch the best result for deeper reading.

## Providers

- `auto`: tries configured providers in priority order, then falls back to DuckDuckGo.
- `brave`: Brave Search API via `BRAVE_API_KEY`.
- `perplexity`: Perplexity Search API via `PERPLEXITY_API_KEY`.
- `tavily`: Tavily Search API via `TAVILY_API_KEY`.
- `duckduckgo`: HTML fallback, no API key required.
- `searxng`: self-hosted SearXNG via `SEARXNG_BASE_URL`.

## Configuration

Add the runtime config section below to `~/.hybridclaw/config.json`:

```json
{
  "web": {
    "search": {
      "provider": "auto",
      "fallbackProviders": [],
      "defaultCount": 5,
      "cacheTtlMinutes": 5,
      "searxngBaseUrl": "",
      "tavilySearchDepth": "advanced"
    }
  }
}
```

Environment variables:

- `BRAVE_API_KEY`
- `PERPLEXITY_API_KEY`
- `TAVILY_API_KEY`
- `SEARXNG_BASE_URL`

Runtime settings are forwarded into the agent container with these derived env vars:

- `HYBRIDCLAW_WEB_SEARCH_PROVIDER`
- `HYBRIDCLAW_WEB_SEARCH_FALLBACK_PROVIDERS`
- `HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT`
- `HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES`
- `HYBRIDCLAW_WEB_SEARCH_TAVILY_SEARCH_DEPTH`

## Auto Mode

`auto` checks which configured providers are available and builds a deduplicated chain in this order:

1. `brave`
2. `perplexity`
3. `tavily`
4. `searxng`
5. `duckduckgo`

If `provider` is set explicitly, the tool uses that provider first, then `fallbackProviders`, and still ends with `duckduckgo`.

## Parameters

- `query`: required search string.
- `count`: optional result count, clamped to `1-10`.
- `freshness`: optional `day`, `week`, `month`, or `year`.
- `country`: optional two-letter country code such as `US` or `DE`.
- `language`: optional ISO 639-1 code such as `en` or `de`.
- `provider`: optional per-call provider override, including `auto`.

## Notes

- Search responses are cached for 5 minutes by default.
- API keys are read from environment variables only.
- Result URLs are validated before they are returned.
- Provider errors are aggregated without echoing secrets.
