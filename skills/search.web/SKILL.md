---
name: search.web
description: Search the public web through the configured self-hosted SearXNG instance for current information, source discovery, or sovereignty-sensitive research.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: research
    short_description: "SearXNG web search."
    tags:
      - search
      - web
      - searxng
      - research
---
# Search Web

Use this skill when the user asks to search the web, find current sources, look something up, discover URLs, or perform sovereignty-sensitive web research.

## Workflow

1. Call `web_search` with:
   - `provider: "searxng"`
   - `categories: "general"`
   - the user's query
   - `count`, `freshness`, `country`, or `language` only when the user asks for them or they are clearly implied.
2. Return the most relevant results with title, URL, and a short snippet.
3. Use `web_fetch` after `web_search` only when the user asks for content from a result or when an answer needs page-level evidence.

## Constraints

- Do not use hosted search providers for this skill unless the user explicitly asks to leave the sovereign SearXNG path.
- Do not invent citations or claim fetched-page facts from search snippets alone.
- If SearXNG is not configured, say that the self-hosted search provider is unavailable and include the tool error.
