---
name: notion
description: Use this skill when the user wants to search, create, update, or organize Notion pages, databases, meeting notes, project trackers, or workspace docs through the Notion API.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - notion
      - workspace
      - docs
      - database
      - office
    related_skills:
      - project-manager
      - trello
---

# Notion Workspace Operations

Use the Notion API for page, block, and data-source work.

## Setup

If `NOTION_API_KEY` is not already configured:

1. Create an internal integration in Notion.
2. Save the token outside the repo, usually as `NOTION_API_KEY`.
3. Share the target pages or databases with that integration.

Do not assume the integration can see a page until the user confirms sharing.

## API Basics

Before API calls, write a private temp curl config and register cleanup so the
Notion token stays off the shell command line and the auth file is removed on
exit:

```bash
AUTH_CURL="$(mktemp)"
chmod 600 "$AUTH_CURL"
trap 'rm -f "$AUTH_CURL"' EXIT INT TERM
cat >"$AUTH_CURL" <<EOF
header = "Authorization: Bearer $NOTION_API_KEY"
header = "Notion-Version: 2025-09-03"
EOF
```

All requests need:

```bash
curl -s "https://api.notion.com/v1/..." -K "$AUTH_CURL"
```

## Common Operations

Search:

```bash
curl -s -X POST "https://api.notion.com/v1/search" \
  -K "$AUTH_CURL" \
  -H "Content-Type: application/json" \
  -d '{"query":"release notes"}'
```

Get page metadata:

```bash
curl -s "https://api.notion.com/v1/pages/PAGE_ID" -K "$AUTH_CURL"
```

Get page blocks:

```bash
curl -s "https://api.notion.com/v1/blocks/PAGE_ID/children" -K "$AUTH_CURL"
```

Query a data source:

```bash
curl -s -X POST "https://api.notion.com/v1/data_sources/DATA_SOURCE_ID/query" \
  -K "$AUTH_CURL" \
  -H "Content-Type: application/json" \
  -d '{"page_size":20}'
```

Create a page in a database:

```bash
curl -s -X POST "https://api.notion.com/v1/pages" \
  -K "$AUTH_CURL" \
  -H "Content-Type: application/json" \
  -d '{"parent":{"database_id":"DATABASE_ID"},"properties":{"Name":{"title":[{"text":{"content":"New item"}}]}}}'
```

Append blocks:

```bash
curl -s -X PATCH "https://api.notion.com/v1/blocks/PAGE_ID/children" \
  -K "$AUTH_CURL" \
  -H "Content-Type: application/json" \
  -d '{"children":[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"Hello"}}]}}]}'
```

## Important Notes

- Notion now distinguishes `database_id` from `data_source_id`.
- Use `database_id` when creating pages.
- Use `data_source_id` when querying data.
- Read first, write second.
- If you are done before the shell exits, run `rm -f "$AUTH_CURL"` and
  `trap - EXIT INT TERM`.

## Rules

- Confirm the exact parent page or database before creating content.
- Show the proposed page title, properties, and key block content before writing.
- Prefer databases for structured tasks, trackers, and meeting logs instead of ad hoc bullet pages.
- Respect rate limits and avoid large write bursts.
