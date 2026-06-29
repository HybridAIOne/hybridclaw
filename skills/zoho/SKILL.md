---
name: zoho
description: "Use the configured Zoho MCP server for Zoho CRM, Desk, Mail, Calendar, Books, Projects, WorkDrive, Cliq, Campaigns, and related Zoho business workflows. Use when the user asks to search, summarize, create, update, schedule, send, invoice, escalate, or report on Zoho data through MCP."
user-invocable: true
metadata:
  hybridclaw:
    category: business
    short_description: "Zoho apps through configured MCP."
    tags:
      - zoho
      - mcp
      - crm
      - desk
      - mail
      - calendar
      - books
      - projects
      - workdrive
      - cliq
    stakes_tiers:
      green:
        - record-read
        - search
        - report-read
        - file-metadata-read
      amber:
        - record-create
        - record-update
        - ticket-reply
        - email-send
        - calendar-write
        - invoice-create
        - task-create
      red:
        - bulk-delete
        - permission-admin
        - payment-or-refund
        - mass-message
    escalation:
      writes: confirm-each
---

# Zoho

Use this skill for Zoho work through the configured Zoho MCP server. The MCP
server owns the exact Zoho app connections, OAuth scopes, tool schemas, and
allowed actions.

Official reference: <https://www.zoho.com/mcp/>

## Required Surface

- Use the HybridClaw MCP server configured as `zoho`.
- Prefer visible MCP tools named `zoho__<tool>` and follow each tool's schema.
- If the server is configured under a different name, use that namespace only
  after confirming it is the Zoho MCP server.
- If no Zoho MCP tools are visible, tell the operator to run `/mcp list`,
  `/mcp status zoho`, or `/mcp login zoho`.
- Do not ask for Zoho OAuth tokens, passwords, cookies, or refresh tokens in
  chat. Do not use browser login or raw Zoho REST calls for normal skill work.

## Setup Guidance

For a new connection, use the Zoho MCP endpoint details from Zoho MCP and store
the server in HybridClaw as `zoho`:

```text
/mcp add zoho {"transport":"http","url":"<zoho-mcp-server-url>","auth":"oauth","enabled":true}
/mcp login zoho
/mcp status zoho
```

Use `sse` instead of `http` only when Zoho's connection details specify SSE.

## Default Workflow

1. Identify the Zoho app, object type, record target, and requested action.
2. Start with a read or search tool to resolve exact IDs and current state.
3. For read-only requests, summarize the MCP result with record names, dates,
   statuses, owners, amounts, links, and IDs needed for follow-up actions.
4. For writes, show the exact target and change, then wait for explicit
   confirmation before calling the MCP write tool.
5. Execute multi-app workflows one confirmed write step at a time. Stop after
   the first failed step and report which steps did and did not run.
6. Do not claim a write succeeded until the MCP tool returns a success result.

## Task Routing

- CRM and Bigin: leads, contacts, accounts, deals, stages, owners, notes,
  meetings, and follow-up tasks.
- Desk: ticket lookup, thread summaries, status changes, assignments, and
  replies.
- Mail, Calendar, and Cliq: searches and summaries are read-only; sending mail,
  scheduling events, or posting messages requires confirmation.
- Books, Billing, and Expense: read invoices, bills, expenses, payments, and
  reports; creating invoices or expenses requires confirmation.
- Projects and WorkDrive: task, project, milestone, file, and folder lookup;
  file moves or task edits require confirmation.
- Creator and other configured apps: follow the MCP tool descriptions and
  prefer low-risk reads before any record mutation.

## Safety Rules

- Treat reads, searches, and report generation as green.
- Treat creates, updates, status changes, assignments, replies, sends, schedule
  changes, and invoice generation as amber; confirm each operation.
- Treat bulk deletion, permission/admin changes, payment or refund execution,
  mass messaging, and irreversible accounting changes as unsupported through
  this skill unless a separate operator-approved procedure exists.
- Preserve user-level Zoho permissions. If MCP returns an OAuth, scope,
  permission, or login error, ask the operator to run `/mcp login zoho` or
  adjust Zoho MCP scopes; do not retry unrelated tools.
- Never expose secrets or bearer tokens in outputs, logs, files, or command
  arguments.
