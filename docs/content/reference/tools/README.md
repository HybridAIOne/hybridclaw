---
title: Tools
description: Reference pages for individual HybridClaw tools.
sidebar_position: 1
---

# Tools

These pages document individual built-in tools and their configuration.

## In This Section

- [Web Search](./web-search.md)

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
