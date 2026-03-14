---
name: trello
description: Use this skill when the user wants to inspect Trello boards, lists, or cards, create or move tasks, comment on cards, or manage lightweight Kanban workflows through the Trello API.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - trello
      - kanban
      - tasks
      - office
    related_skills:
      - project-manager
      - notion
---

# Trello

Use Trello's REST API for boards, lists, and cards.

## Setup

If credentials are not already configured:

1. Get the API key from `https://trello.com/app-key`
2. Generate a token from the same page
3. Export:
   ```bash
   export TRELLO_API_KEY="..."
   export TRELLO_TOKEN="..."
   ```

Do not print the raw token back to the user.

Before API calls, write a short temporary curl config so secrets stay off the shell command line:

```bash
cat >/tmp/trello-auth.curl <<EOF
data = "key=$TRELLO_API_KEY"
data = "token=$TRELLO_TOKEN"
EOF
```

## Common Operations

List boards:

```bash
curl -s -G "https://api.trello.com/1/members/me/boards" -K /tmp/trello-auth.curl | jq '.[] | {name, id}'
```

List lists in a board:

```bash
curl -s -G "https://api.trello.com/1/boards/BOARD_ID/lists" -K /tmp/trello-auth.curl | jq '.[] | {name, id}'
```

List cards in a list:

```bash
curl -s -G "https://api.trello.com/1/lists/LIST_ID/cards" -K /tmp/trello-auth.curl | jq '.[] | {name, id, desc}'
```

Create a card:

```bash
curl -s -X POST "https://api.trello.com/1/cards" -K /tmp/trello-auth.curl \
  -d "idList=LIST_ID" \
  -d "name=Card title" \
  -d "desc=Card description"
```

Move a card:

```bash
curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID" -K /tmp/trello-auth.curl \
  -d "idList=NEW_LIST_ID"
```

Comment on a card:

```bash
curl -s -X POST "https://api.trello.com/1/cards/CARD_ID/actions/comments" -K /tmp/trello-auth.curl \
  -d "text=Your comment here"
```

## Rules

- Resolve the board and list IDs before creating or moving cards.
- Read first, write second.
- Confirm before archival or bulk card moves.
- Keep API key and token out of logs and tracked files.
- Remove `/tmp/trello-auth.curl` when you are done with a session that used it.
- Use `jq` to keep list and search output readable.
