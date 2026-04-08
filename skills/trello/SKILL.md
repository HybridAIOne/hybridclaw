---
name: trello
description: Inspect Trello boards, lists, and cards; create or move tasks; and manage Kanban workflows through the Trello API.
user-invocable: true
metadata:
  hybridclaw:
    category: productivity
    short_description: "Trello boards and cards."
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

Before API calls, write a private temp curl config and register cleanup so
secrets stay off the shell command line and the auth file is removed on exit:

```bash
AUTH_CURL="$(mktemp)"
chmod 600 "$AUTH_CURL"
trap 'rm -f "$AUTH_CURL"' EXIT INT TERM
cat >"$AUTH_CURL" <<EOF
data = "key=$TRELLO_API_KEY"
data = "token=$TRELLO_TOKEN"
EOF
```

## Common Operations

List boards:

```bash
curl -s -G "https://api.trello.com/1/members/me/boards" -K "$AUTH_CURL" | jq '.[] | {name, id}'
```

List lists in a board:

```bash
curl -s -G "https://api.trello.com/1/boards/BOARD_ID/lists" -K "$AUTH_CURL" | jq '.[] | {name, id}'
```

List cards in a list:

```bash
curl -s -G "https://api.trello.com/1/lists/LIST_ID/cards" -K "$AUTH_CURL" | jq '.[] | {name, id, desc}'
```

Create a card:

```bash
curl -s -X POST "https://api.trello.com/1/cards" -K "$AUTH_CURL" \
  -d "idList=LIST_ID" \
  -d "name=Card title" \
  -d "desc=Card description"
```

Move a card:

```bash
curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID" -K "$AUTH_CURL" \
  -d "idList=NEW_LIST_ID"
```

Comment on a card:

```bash
curl -s -X POST "https://api.trello.com/1/cards/CARD_ID/actions/comments" -K "$AUTH_CURL" \
  -d "text=Your comment here"
```

## Rules

- Resolve the board and list IDs before creating or moving cards.
- Read first, write second.
- Confirm before archival or bulk card moves.
- Keep API key and token out of logs and tracked files.
- If you are done before the shell exits, run `rm -f "$AUTH_CURL"` and
  `trap - EXIT INT TERM`.
- Use `jq` to keep list and search output readable.
