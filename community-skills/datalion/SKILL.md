---
name: datalion
description: Use for DataLion workflows such as listing, reading, creating, or editing projects, inspecting data sources, importing Excel or CSV data, working with reports and report tabs and codebooks, reading chart tables, or coordinating dashboard and export work through a configured datalion MCP server and related API or UI paths.
user-invocable: true
metadata:
  hybridclaw:
    category: business
    tags:
      - datalion
      - analytics
      - dashboards
      - reports
      - data
    related_skills:
      - xlsx
      - project-manager
---

# DataLion

Use this skill for DataLion project, project-settings, data-import, codebook,
chart-table, report, report-tab, dashboard, and export workflows.

In DataLion, "tab" and "dashboard" are used interchangeably for the report
subpages managed under a report.

## Default Strategy

1. Verify the `datalion` MCP server is enabled and inspect which
   `datalion__*` tools are actually available in the current session.
2. Use MCP first for supported actions.
3. Do not invent Datalion MCP tools. If a matching tool is missing, switch to a
   REST or browser/UI path from
   [references/setup-and-capabilities.md](references/setup-and-capabilities.md).
4. Read first, write second. Restate the exact target object and proposed
   mutation before calling a write path.

## Setup

- Run HybridClaw in host sandbox mode for this local Node-based MCP server.
- Install the bridge dependencies before first use:
  `npm --prefix <path-to-your-datalion-repo>/mcp install`
- Keep `DATALION_API_TOKEN` inside MCP server config `env`, never in tracked
  files or chat.
- Use the MCP server name `datalion` so tools appear as `datalion__...`.
- For `hybridclaw gateway mcp add ...`, pass the JSON config as one quoted
  shell argument. In `zsh`, unquoted `{...}` and `[...]` will be expanded
  before HybridClaw sees them.
- See
  [references/setup-and-capabilities.md](references/setup-and-capabilities.md)
  for ready-to-paste CLI and TUI examples, dependency notes, and ability
  requirements.

## Working Rules

- Always state whether you are using MCP, REST API, or browser/UI automation.
- Resolve the exact project, report, dashboard, export, or chart before
  mutating anything.
- The current bridge directly supports project listing, project reads, project
  creation, project settings updates, data source listing, CSV upload, full
  Excel/CSV import, report list/create and tab CRUD, chart-table reads, and
  codebook list, download, generation, deletion, and upload.
- The bridge also exposes 4 browser URL helpers for project/report/dashboard
  opening and widget insertion.
- The current bridge tool surface has 22 tools total: 18 backend MCP actions
  and 4 browser URL helpers.
- Prefer `datalion__list_projects` and `datalion__read_project` before writes
  when the exact target project is not already pinned down.
- Treat `datalion__upload_data` as a data-import tool, not a generic
  project-update tool.
- Treat `datalion__edit_project` as a `defsettings` merge tool. It updates only
  the keys you pass and keeps the existing settings for all other keys.
- Use `datalion__list_data_sources` to inspect what is already loaded into a
  project before uploading or troubleshooting data.
- Prefer `datalion__import_excel_data` when the source is an `.xlsx` workbook or
  when you want Datalion's full import pipeline, including optional codebook
  generation during import.
- Use `datalion__list_codebook` when the user needs a question-level inventory;
  use `datalion__download_codebook` for the tree structure.
- For workbook imports, prefer an absolute `localPath` so the bridge can read
  the file directly.
- For uploads, confirm filename, header and delimiter assumptions, data source
  name if relevant, and whether existing rows should be truncated.
- For `import_excel_data`, confirm `projectId`, file path or base64 file
  content, filename if you are not using `localPath`, whether you want the
  default main data source (`useDefaultDataSource=true`) or a named data
  source, and whether `replaceData`, `runCalculations`, `convertComma`,
  `skipLines`, `comment`, and `createCodebook` should be enabled.
- For project settings edits, confirm the target `projectId` and the exact
  `defsettings` keys and values before calling.
- For chart-table reads, confirm `projectId`, `chartId`, and any filter string
  before calling.
- For codebook uploads, confirm `projectId`, CSV filename, import mode, and
  whether any explicit column mapping is needed. The current backend expects
  `columnMapping` as an array aligned to the CSV header order.
- For reports, prefer direct MCP coverage first.
- For dashboard and export tasks without direct MCP coverage, inspect the local
  Datalion repo and its OpenAPI or route definitions before choosing a fallback
  path.
- Keep tokens, auth headers, and exported files out of logs unless the user
  explicitly asks for them.

## Current MCP Coverage

The current `datalion` bridge exposes these direct tools:

- `datalion__list_projects`
- `datalion__read_project`
- `datalion__create_project`
- `datalion__edit_project`
- `datalion__list_data_sources`
- `datalion__upload_data`
- `datalion__import_excel_data`
- `datalion__list_reports`
- `datalion__create_report`
- `datalion__create_report_tab`
- `datalion__edit_report_tab`
- `datalion__delete_report_tab`
- `datalion__open_project_browser`
- `datalion__open_report_browser`
- `datalion__open_dashboard_browser`
- `datalion__open_add_widget_browser`
- `datalion__get_chart_table`
- `datalion__list_codebook`
- `datalion__download_codebook`
- `datalion__generate_codebook`
- `datalion__delete_codebook`
- `datalion__upload_codebook`

That means:

- project discovery and project detail reads are supported directly
- project creation is supported directly
- project settings updates through `defsettings` merges are supported directly
- project data sources can be listed directly
- CSV-style data import into an existing project is supported directly
- workbook and full-pipeline Excel/CSV import are supported directly
- the full-pipeline import path uses DataLion's datasource service rather than
  the raw CSV upload path, so it handles type detection, replace/append mode,
  optional codebook generation, and optional calculations
- report listing and report creation are supported directly
- chart tables can be read directly
- codebooks can be listed, downloaded, generated, deleted, and uploaded
  directly
- report editing beyond report-tab CRUD, dashboard editing, and export
  generation require fallback API or UI paths until the bridge grows more tools

## Common Workflows

For explicit TUI testing, prefer `/skill datalion ...`.

- `/skill datalion create a project named "MCP Smoke Test"`
- plain natural-language prompts that mention DataLion also work
- `/datalion ...` may still be routed as a normal message, but it is not a
  built-in slash-menu command, so do not use slash-menu visibility as the test
  for whether the skill is installed

### Create a Project

1. Confirm the project name and any optional `identcode` or `defsettings`.
2. Call `datalion__create_project`.
3. Return the new project ID and recommend the next step, usually data import
   or report/dashboard setup.

### Create a Report

1. Confirm the project ID and report name.
2. Call `datalion__create_report`.
3. Note that the report is seeded with a first tab and return both the report
   ID and first tab ID.

### Manage Report Tabs

1. Call `datalion__create_report_tab` to add a tab to an existing report.
2. Call `datalion__edit_report_tab` to rename or update a tab.
3. Call `datalion__delete_report_tab` to remove a tab after confirming the
   report and tab IDs.
4. Keep `projectId` aligned with the report or tab/dashboard you are mutating.

### Open In Browser

1. Use `datalion__open_project_browser` for the project screen.
2. Use `datalion__open_report_browser` for the report editor or a specific
   report tab/dashboard.
3. Use `datalion__open_dashboard_browser` for a specific tab/dashboard view.
4. Use `datalion__open_add_widget_browser` to get the modal URL used to add a
   question/widget to a tab/dashboard. The actual insertion still happens in
   the browser UI after the modal is opened.

### Find or Read a Project

1. Call `datalion__list_projects` when the user gives a fuzzy project name or
   identcode.
2. Call `datalion__read_project` once you know the `projectId`.
3. Use the returned `defsettings`, `categoriesCount`, and `dataSourcesCount` to
   guide the next step.

### Edit Project Settings

1. Confirm `projectId` and the exact `defsettings` keys to merge.
2. Call `datalion__edit_project`.
3. Return the updated keys and note that untouched settings stay as they were.

### Upload Data

1. Confirm the target project ID.
2. Call `datalion__list_data_sources` first if you need to inspect existing
   data sources.
3. Prefer CSV text input for the current bridge.
4. Call `datalion__upload_data`.
5. Return the job ID and the import assumptions you used.

### Import Excel or CSV via Datalion Pipeline

1. Confirm `projectId` and the source file path or file content.
2. Prefer `localPath` for `.xlsx` imports when the file exists on disk.
3. Use `useDefaultDataSource=true` when you want the workbook imported into
   the main project data table and codebook generation to read from that same
   table. Otherwise confirm `dataSourceName`.
4. Confirm whether `createCodebook` should run during import.
5. Call `datalion__import_excel_data`.
6. Return the data source name, imported row count, and whether codebook
   generation was requested.

### Read a Chart Table

1. Confirm `projectId`, `chartId`, and filters.
2. Call `datalion__get_chart_table`.
3. Summarize the result and surface obvious caveats.

### Codebook Workflows

1. For question-level inspection, call `datalion__list_codebook`.
2. For tree-structured inspection, call `datalion__download_codebook`.
3. For regenerate-from-data workflows, call `datalion__generate_codebook`.
4. For destructive cleanup, call `datalion__delete_codebook` and confirm
   whether `includeTextboxes` should be `true`.
5. For CSV import, call `datalion__upload_codebook` with the filename, file
   content, import mode, and any index-based `columnMapping` array that should
   align with the CSV header order.

### Reports

1. Call `datalion__list_reports` to inspect existing reports for a project.
2. Call `datalion__create_report` to create a new report once the target
   project and report name are confirmed. The new report is seeded with a
   first tab and the response includes both IDs.
3. Use the report-tab tools for tab-level create/edit/delete work.
4. Treat report edits beyond tab CRUD as fallback work until direct MCP
   coverage exists.

### Dashboards and Exports

1. Check current `datalion__*` tool coverage first.
2. If no direct tool exists, inspect `openapi.yaml`, `routes/dashboard.php`, and
   `routes/export.php` in the local Datalion checkout or use browser automation
   against the Datalion UI.
3. Prefer REST endpoints for API-backed CRUD and browser/UI paths for web-only
   export flows.
4. Be explicit about which path you chose and why.
