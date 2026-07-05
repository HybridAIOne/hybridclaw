---
title: Apps Gallery
description: Build, save, preview, and refresh generated HTML apps from HybridClaw web chat.
sidebar_position: 2
---

# Apps Gallery

The Apps gallery is the local home for generated web artifacts: apps,
websites, printable documents, games, dashboards, quizzes, and focused tools.
Open it at `/apps` on the running gateway, or start from web chat with:

```text
/app <what you want to build>
```

Bare `/app` or `/apps` opens the gallery. `/app <description>` starts an
app-building chat conversation, tags the session as an app build, and asks the
agent to create one self-contained HTML file.

## Build A Web App

From `/apps`, choose **New app** and pick a category:

- Apps and websites
- Documents and templates
- Games
- Productivity tools
- Creative projects
- Quiz or survey
- Start from scratch

HybridClaw opens a chat with a build brief. When you provide an idea, the
agent proposes a short plan, waits for your approval, then writes the artifact
as a single HTML file in the agent workspace, usually under `apps/`.

When the run finishes, HybridClaw captures the HTML into the Apps gallery and
opens a preview. Each app can be opened in the gallery, opened in a new browser
tab, searched, filtered by category, or deleted. Deleting a gallery app removes
the stored app record; it does not delete the source workspace file.

## Artifact Capture

HTML artifacts from chat turns are captured into the gallery. App-build
sessions get extra handling:

- HTML files referenced in the assistant reply, such as `apps/dashboard.html`,
  are read from the agent workspace and saved as gallery apps.
- Inline HTML returned in the assistant message is captured when no file-backed
  artifact is found.
- File-backed apps are keyed by agent and workspace file path, so rebuilding
  `apps/dashboard.html` updates the same gallery entry instead of creating a
  duplicate.
- Inline HTML has no stable file path, so it remains scoped to the chat
  session that produced it.

The generated app should be client-side HTML with inline CSS and JavaScript.
External libraries may be loaded from public CDNs, but the artifact should not
need a build step, local files, backend APIs, or embedded secrets.

## Live Apps

Live apps are connector-aware generated apps. Start one from `/apps` with
**New app** -> **Live app**. HybridClaw uses the connected MCP tools available
to the chat session as the data source, embeds an initial snapshot in the HTML,
and asks the app to refresh through the Apps viewer.

Inside a live app, generated HTML should use the viewer bridge instead of
calling gateway URLs directly:

```js
const result = await window.hybridclaw.callMcpTool(
  'server__connector__list_items',
  { limit: 20 },
);

window.hybridclaw.setRefreshHandler(async () => {
  // Re-query connector data and update the UI.
});
```

The bridge is intentionally narrow:

- it is injected only for apps stored as `live`
- it accepts namespaced MCP-style tool names such as
  `server__connector__list_items`
- it only allows read-oriented action prefixes: `describe`, `fetch`, `find`,
  `get`, `list`, `lookup`, `query`, `read`, `retrieve`, and `search`
- tool arguments are limited to 64 KB
- bridge calls run with a 120 second wall-clock timeout and a 60 second
  inactivity timeout
- connector calls that need approval return an approval-required error instead
  of silently running

If the bridge is unavailable, the embedded snapshot should still render so the
app remains useful outside the Apps viewer.

## Security Boundaries

Apps render inside a sandboxed iframe. Credentials stay in HybridClaw's
runtime secret store and connector auth paths; generated HTML must not embed
API keys, refresh tokens, bearer tokens, or private gateway credentials.

Live app refreshes still route through the gateway, the selected session and
agent, the allowed-tool restriction for that exact connector tool, and normal
approval handling. Mutating connector action names are rejected before an
agent run starts.
