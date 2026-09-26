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
