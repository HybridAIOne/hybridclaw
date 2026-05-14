---
name: search.news
description: Search news results through the configured self-hosted SearXNG instance for recent events, current reporting, headlines, and time-sensitive source discovery.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: research
    short_description: "SearXNG news search."
    tags:
      - search
      - news
      - searxng
      - research
---
# Search News

Use this skill when the user asks for news, latest reporting, headlines, recent events, current developments, or time-sensitive source discovery.

## Workflow

1. Call `web_search` with:
   - `provider: "searxng"`
   - `categories: "news"`
   - the user's news query
   - `freshness: "day"` or `freshness: "week"` when the user asks for recent/latest news and no tighter window is specified.
   - `count`, `country`, or `language` only when the user asks for them or they are clearly implied.
2. Return the most relevant news results with title, URL, age/date when available, and a short snippet.
3. Use `web_fetch` after `web_search` before making factual claims beyond the snippets.

## Constraints

- Do not use hosted news search providers for this skill unless the user explicitly asks to leave the sovereign SearXNG path.
- Make recency explicit when reporting news.
- If SearXNG is not configured, say that the self-hosted news search provider is unavailable and include the tool error.
