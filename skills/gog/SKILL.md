---
name: gog
description: Google Workspace CLI for Gmail, Google Calendar events, meetings, schedules, availability, Drive, Contacts, Sheets, and Docs.
user-invocable: true
requires:
  bins:
    - gog
metadata:
  hybridclaw:
    category: productivity
    short_description: "Google Workspace via gog CLI."
    tags:
      - google
      - workspace
      - gmail
      - calendar
      - drive
      - sheets
      - docs
    related_skills:
      - google-workspace
    install:
      - id: brew
        kind: brew
        formula: steipete/tap/gogcli
        bins: ["gog"]
        label: Install gog CLI (brew)
---
# gog

Use this skill when the user wants deterministic Google Workspace automation through `gog` instead of browser automation. `gog` covers Gmail, Calendar, Drive, Contacts, Sheets, and Docs, and requires OAuth setup before use.

## Setup

If `gog` is missing, tell the user to run:

```bash
hybridclaw skill install gog brew
```

Then complete HybridClaw Google OAuth setup once from the host:

```bash
hybridclaw auth login google --client-id <id> --client-secret <secret> --account you@gmail.com
hybridclaw auth status google
```

HybridClaw stores the Google OAuth client secret and refresh token in encrypted runtime secrets, mints a short-lived access token on the host, and injects only `GOG_ACCESS_TOKEN` plus `GOG_ACCOUNT` into the agent runtime for `gog`.

If the user already has a refresh token, they can store it directly:

```bash
hybridclaw auth login google --client-id <id> --client-secret <secret> --account you@gmail.com --refresh-token <token>
```

Use the minimum scopes needed for the task. Keep OAuth client secrets outside the repo and outside version control.

## Default Workflow

1. Check availability with `gog --help` or the specific subcommand help.
2. Check auth state with `hybridclaw auth status google` before assuming an account exists.
3. The runtime normally provides `GOG_ACCOUNT`; pass `--account you@example.com` only when the user has explicitly configured multiple accounts.
4. Prefer read/list/search commands first, then propose write operations.
5. Require explicit confirmation before sending email, creating drafts that may be sent, creating or updating calendar events, changing Sheets values, or modifying Drive/Docs resources.
6. For scripting and follow-up parsing, prefer `--json`, `--results-only`, and `--no-input` when the subcommand supports them.
7. Do not pipe `gog ... --json` into `python3 - <<'PY'`; the heredoc becomes Python's stdin, so `json.load(sys.stdin)` will not receive the `gog` output. Use a temp JSON file or call `gog` from Python with `subprocess.check_output`.

## Gmail

Search threads:

```bash
gog gmail search 'newer_than:7d' --max 10
```

Search individual messages, ignoring thread grouping:

```bash
gog gmail messages search "in:inbox from:example.com" --max 20 --account you@example.com
```

Send a plain text email:

```bash
gog gmail send --to recipient@example.com --subject "Hi" --body "Hello"
```

Send a multi-paragraph email from a file:

```bash
gog gmail send --to recipient@example.com --subject "Hi" --body-file ./message.txt
```

Send a multi-paragraph email from stdin:

```bash
gog gmail send --to recipient@example.com --subject "Hi" --body-file - <<'EOF'
Hi Name,

Thanks for meeting today. Next steps:
- Item one
- Item two

Best regards,
Your Name
EOF
```

Create and send drafts:

```bash
gog gmail drafts create --to recipient@example.com --subject "Hi" --body-file ./message.txt
gog gmail drafts send <draftId>
```

Reply to a message:

```bash
gog gmail send --to recipient@example.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <messageId>
```

HTML email is available when rich formatting is necessary:

```bash
gog gmail send --to recipient@example.com --subject "Update" --body-html "<p>Hi Name,</p><p>Thanks for meeting today.</p>"
```

Prefer plain text unless the user asks for formatting. `--body` does not unescape `\n`; use `--body-file` for line breaks and multi-paragraph messages.

## Calendar

List events:

```bash
gog calendar events <calendarId> --from <iso> --to <iso>
```

For broad user requests like "my calendar", "my Google Calendar", or "all my meetings", omit `<calendarId>` first so `gog` searches all available calendars. Use `primary` only when the user explicitly asks for the primary calendar or after confirming that primary is the right scope.

```bash
gog calendar events --from <iso> --to <iso> --json --results-only --no-input
```

When filtering JSON results, either write JSON to a temp file:

```bash
gog calendar events --from <iso> --to <iso> --json --results-only --no-input > /tmp/gog-events.json
python3 -c 'import json,re; items=json.load(open("/tmp/gog-events.json")); rx=re.compile("festival", re.I); print(json.dumps([e for e in items if rx.search(str(e.get("summary","")) + " " + str(e.get("description","")))], ensure_ascii=False, indent=2))'
```

Or call `gog` from Python:

```bash
python3 -c 'import json,re,subprocess; out=subprocess.check_output(["gog","calendar","events","--from","<iso>","--to","<iso>","--json","--results-only","--no-input"], text=True); items=json.loads(out); rx=re.compile("festival", re.I); print(json.dumps([e for e in items if rx.search(str(e.get("summary","")) + " " + str(e.get("description","")))], ensure_ascii=False, indent=2))'
```

Create an event:

```bash
gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>
```

Create or update events with a Google Calendar color:

```bash
gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7
gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4
```

Show available event colors:

```bash
gog calendar colors
```

Known event color IDs:

| ID | Color |
|----|-------|
| 1 | `#a4bdfc` |
| 2 | `#7ae7bf` |
| 3 | `#dbadff` |
| 4 | `#ff887c` |
| 5 | `#fbd75b` |
| 6 | `#ffb878` |
| 7 | `#46d6db` |
| 8 | `#e1e1e1` |
| 9 | `#5484ed` |
| 10 | `#51b749` |
| 11 | `#dc2127` |

## Drive And Contacts

Search Drive:

```bash
gog drive search "query" --max 10
```

List contacts:

```bash
gog contacts list --max 20
```

## Sheets

Read values:

```bash
gog sheets get <sheetId> "Tab!A1:D10" --json
```

Update values:

```bash
gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED
```

Append values:

```bash
gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS
```

Clear values:

```bash
gog sheets clear <sheetId> "Tab!A2:Z"
```

Inspect spreadsheet metadata:

```bash
gog sheets metadata <sheetId> --json
```

Use `--values-json` for reliable structured input. Confirm the target sheet, tab, and range before writes.

## Docs

Export a document:

```bash
gog docs export <docId> --format txt --out /tmp/doc.txt
```

Print document text:

```bash
gog docs cat <docId>
```

`gog` supports Docs export, cat, and copy workflows. In-place Docs edits require a Docs API client or browser automation.

## Rules

- Never ask the user to paste Google passwords, refresh tokens, or OAuth client secrets into chat.
- Never commit OAuth client files, downloaded document exports, or generated email bodies that contain private data unless the user explicitly asks and the path is appropriate.
- Confirm before sending email, sending a draft, creating or updating calendar events, changing Sheets values, or modifying Drive/Docs resources.
- State the account and target resource before write operations.
- Prefer `gog gmail messages search` when the user needs every email returned separately; `gog gmail search` returns one row per thread.
