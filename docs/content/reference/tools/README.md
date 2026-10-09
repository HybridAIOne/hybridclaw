---
title: Tools
description: Reference pages for individual HybridClaw tools.
sidebar_position: 1
---

# Tools

These pages document individual built-in tools and their configuration.

## In This Section

- [Web Search](./web-search.md)

## Browser Actions

`browser_navigate` and `browser_click` return the resulting page snapshot,
including actionable element references, so the agent can read the page and
choose its next action without a separate `browser_snapshot` call. Snapshots
are capped at 12,000 characters. After typing, pressing a key, or scrolling,
use `browser_snapshot` to inspect the changed page; its interactive mode helps
when a long page was truncated.

Download clicks and pages waiting for two-factor authentication omit the
snapshot. If the action succeeds but the snapshot fails, the result reports
`snapshot_error`; the action is not repeated automatically.

For login pages, `browser_sign_in` fills credentials saved for that exact host
without revealing them to the model. See
[Website sign-ins](../../getting-started/authentication.md#website-sign-ins)
for storage, device permissions, and the client sign-in flow.

`browser_take_over` hands the open page to the owner, who drives it from the
Hy app, and waits up to 10 minutes. The gateway relays agent-browser's stream
(frames out; mouse, keyboard and touch in) to the phone over
`/api/browser/take-over/stream`, which needs the owner-only `browser.control`
action and host sandbox mode. While the user drives, a page script records
clicks, choices and typed values; passwords, one-time codes, card fields and
sign-in names are recorded only as "typed". The steps reach the model only when
the user picks "Remember how I did that", and the agent then saves them as a
mini skill.

## Sending Local Files Through Tools

For MCP tools, plugin tools, and `http_request`, use `<file-base64:path>` as
an entire string argument value when the destination expects base64 bytes:

```json
{"bodyBase64": "<file-base64:/workspace/report.pdf>"}
```

`bodyBase64` is the `http_request` field; for connectors, use the field in
that tool's schema. The runtime reads and encodes the file after approval,
so the model does not have to reproduce its contents. Successful calls include
a receipt with the path and number of bytes sent.

Files must be under the workspace or the uploaded/Discord media caches and
must be at most 8 MiB each. References cannot be embedded in a larger string.
Other tools reject these references; use their own file-path parameters.
Oversized or abbreviated hand-pasted base64 payloads are rejected to prevent
corrupted uploads.

## Reading PDFs and Images

`read` accepts a PDF path with a `pages` selection such as `"5-8"` or `"1,3"`.
Each call reads at most four pages; without `pages`, it selects the first four.
Selected pages reach a supported multimodal model through native PDF input or
page images; results report which pages were processed and omitted. Read omitted
pages explicitly and cite the original page numbers. Text-only models receive
extracted text, so visual details require a model that supports images or PDFs.

Use a literal `query` to locate relevant pages before inspecting them:

```json
{"path": "/workspace/report.pdf", "query": "operating profit"}
```

Then make a separate call with the returned page numbers:

```json
{"path": "/workspace/report.pdf", "pages": "5-8"}
```

`query` cannot be combined with `pages` or `render`. Search covers extracted text,
so scans may need visual page inspection. PDF reads use page selections instead
of text-file `offset` and `limit`. `render: "never"` requests extracted text only.
Image reads deliver pixels to supported models; visual snapshots persist for
replay after a worker restart.
