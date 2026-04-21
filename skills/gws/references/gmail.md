# Gmail Commands

## Helper commands (prefer these)

```bash
gws gmail +triage
gws gmail +triage --max 5
gws gmail +triage --query "from:boss subject:urgent"

gws gmail +read --id MESSAGE_ID

gws gmail +send \
  --to recipient@example.com \
  --subject "Meeting notes" \
  --body "Here are the notes..." \
  --attach ./notes.pdf

gws gmail +reply --message-id MSG_ID --body "Thanks, sounds good."
gws gmail +reply-all --message-id MSG_ID --body "Agreed."
gws gmail +forward --message-id MSG_ID --to someone@example.com
```

## Common raw commands

```bash
# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "from:sarah subject:contract", "maxResults": 10}'

# Get full message
gws gmail users messages get --params '{"userId": "me", "id": "MESSAGE_ID"}'

# List labels
gws gmail users labels list --params '{"userId": "me"}'

# List threads
gws gmail users threads list --params '{"userId": "me", "maxResults": 5}'
```
