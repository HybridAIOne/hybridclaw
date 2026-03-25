# DataLion Setup and Capabilities

## Recommended MCP Setup

Run HybridClaw in host mode so the local Node bridge can execute:

```bash
hybridclaw gateway start --foreground --sandbox=host
hybridclaw tui
```

Add the MCP server from the CLI with the JSON quoted as a single shell
argument:

```bash
hybridclaw gateway mcp add datalion '{"transport":"stdio","command":"node","args":["/Users/bkoehler/src/datalion/mcp/mcp-bridge.js"],"env":{"DATALION_API_URL":"https://datalion.test/api/v1/mcp","DATALION_API_TOKEN":"replace-me","DATALION_IGNORE_SSL":"true"},"enabled":true}'
```

In `zsh`, do not leave the JSON unquoted or the shell will try to expand
`{...}` and `[...]` before `hybridclaw gateway` receives the config.

Add the same MCP server from the TUI with:

```text
/mcp add datalion {"transport":"stdio","command":"node","args":["/Users/bkoehler/src/datalion/mcp/mcp-bridge.js"],"env":{"DATALION_API_URL":"https://datalion.test/api/v1/mcp","DATALION_API_TOKEN":"replace-me","DATALION_IGNORE_SSL":"true"},"enabled":true}
```

Replace `replace-me` with a real token.

Do not use `~` inside `args`; MCP stdio commands do not run through a shell, so
tilde expansion will not happen. Use an absolute path like
`/Users/bkoehler/src/datalion/mcp/mcp-bridge.js`.

Install the bridge dependencies before first use:

```bash
npm --prefix /Users/bkoehler/src/datalion/mcp install
```

Verify the server registration with either:

```bash
hybridclaw gateway mcp list
```

or:

```text
/mcp list
```

`mcp list` shows configured MCP servers, not the discovered tool names.
HybridClaw merges MCP tools into the active session tool list at runtime, so the
practical verification path is to run a prompt that should use the server and
then inspect the response or the Datalion bridge log.

In Datalion, "tab" and "dashboard" refer to the same report subpage entity.

When the server is healthy, the active tool names are typically:

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

This is the current 22-tool bridge surface:

- `project.list`, `project.read`, `project.create`, `project.edit`
- `data.sources`, `data.upload`, `data.import.excel`
- `report.list`, `report.create`, `report.tab.create`, `report.tab.edit`,
  `report.tab.delete`
- browser URL helpers:
  - `open_project_browser`
  - `open_report_browser`
  - `open_dashboard_browser`
  - `open_add_widget_browser`
- `chart.table`
- `codebook.list`, `codebook.download`, `codebook.generate`,
  `codebook.delete`, `codebook.upload`

## Testing the Skill

For explicit TUI testing, use:

```text
/skill datalion create a new project named "MCP Smoke Test 2026-03-25"
```

That is the safest explicit invocation path in HybridClaw sessions.
`/datalion ...` is not a built-in slash-menu entry, so it may not appear in
autocomplete even though the skill itself is installed.

## TUI Smoke Tests

Use these in the TUI after `/mcp reconnect datalion`:

```text
/skill datalion list all projects
```

```text
/skill datalion read project 123 and show its full details and defsettings
```

```text
/skill datalion create a new project named "MCP Smoke Test 2026-03-25" with identcode "mcp-smoke-test-2026-03-25" and defsettings {"language":"en","themeselection":"default"}
```

```text
/skill datalion create a report named "MCP Smoke Test Report" for project 123
```

```text
/skill datalion create a new tab in report 456 for project 123 named "Executive Summary"
```

```text
/skill datalion edit tab 456 in report 456 for project 123 by setting description to "Executive Summary - Revised" and sortorder to 2
```

```text
/skill datalion delete tab 456 from report 456 for project 123
```

```text
/skill datalion open project 123 in browser
```

```text
/skill datalion open report 456 for project 123 in browser
```

```text
/skill datalion open dashboard 789 for project 123 in browser
```

```text
/skill datalion open the add-widget modal for project 123, div 4, and category 321
```

```text
/skill datalion update project 123 by merging these defsettings: {"disp_precision":2,"omit_na":true,"report_instant_export":true}
```

```text
/skill datalion list the data sources for project 123
```

```text
/skill datalion import the workbook at /Users/bkoehler/Downloads/synthclaw_sales.xlsx into project 123 as the main data source using useDefaultDataSource=true and createCodebook=true
```

```text
/skill datalion list the reports for project 123
```

```text
/skill datalion create a report named "MCP Smoke Test Report" for project 123
```

```text
/skill datalion download the codebook for project 123
```

```text
/skill datalion list the question-level codebook categories for project 123
```

```text
/skill datalion generate the codebook for project 123 from the current project data
```

```text
/skill datalion delete the codebook for project 123 but keep textboxes
```

```text
/skill datalion delete the codebook for project 123 and include textboxes
```

```text
/skill datalion upload this codebook CSV to project 123 as "codebook.csv" using importType 2:
variable,label,short_label,value
q1,Overall satisfaction,Satisfaction,1
q2,Recommend to a friend,Recommendation,1
```

```text
/skill datalion upload this codebook CSV to project 123 as "codebook.csv" using importType 3 and columnMapping ["fieldname","label","category","values"]:
variable,label,short_label,value
q1,Overall satisfaction,Satisfaction,1
q2,Recommend to a friend,Recommendation,1
```

Bridge-side confirmation is written to:

- `/Users/bkoehler/src/datalion/mcp/mcp-bridge-debug.log`

Look for `Received tools/call request` entries such as `list_projects`,
`read_project`, `create_project`, `edit_project`, `list_data_sources`,
`import_excel_data`, `list_reports`, `create_report`, `list_codebook`,
`download_codebook`, `generate_codebook`, `delete_codebook`, and
`upload_codebook`.

## Required Token Abilities

The current backend checks these abilities:

- `projects.read` for project listing and reads
- `projects.create` for project creation
- `projects.edit` for project settings updates
- `data.read` for project data source reads
- `data.upload` for CSV upload and excel import
- `reports.read` for report listing
- `reports.write` for report creation
- `charts.view-api` for chart table reads
- `codebook.read` for codebook downloads
- `codebook.write` for codebook generation, deletion, and upload

If a call fails with `403`, check the token abilities before retrying.

## Capability Matrix

| Task | Best path today | Notes |
| --- | --- | --- |
| List projects | `datalion__list_projects` | Direct MCP support exists. Returns `projectId`, `identcode`, `name`, `description`, `status`, and `source` for accessible projects. |
| Read project | `datalion__read_project` | Direct MCP support exists. Returns full project details including `defsettings`, `categoriesCount`, and `dataSourcesCount`. |
| Create project | `datalion__create_project` | Direct MCP support exists. The bridge advertises `name` and optional `identcode` and `defsettings`. DataLion uses `name` for project description and dtitle. |
| Edit project settings | `datalion__edit_project` | Direct MCP support exists. `defsettings` must be an object and is merged into the existing project settings rather than replacing them wholesale. |
| List data sources | `datalion__list_data_sources` | Direct MCP support exists. Returns each data source with `id`, `name`, `comment`, row count, and timestamps. |
| Upload CSV data | `datalion__upload_data` | Best current MCP path. Confirm header, delimiter, encoding, truncate behavior, and target project ID. |
| Import Excel or CSV with full pipeline | `datalion__import_excel_data` | Direct MCP support exists. Accepts `localPath` or base64 `file`, plus `filename` when needed; supports `dataSourceName`, `useDefaultDataSource`, `replaceData`, `runCalculations`, `convertComma`, `skipLines`, `createCodebook`, and `comment`. Use `useDefaultDataSource=true` when you want the workbook imported into the main project data table so codebook generation reads the same data table. |
| Upload Excel workbook | `datalion__import_excel_data` | Preferred direct MCP path for `.xlsx` workbooks. Use `localPath` for a local file or base64 `file` if you already have the workbook bytes. If you want the main/default data source, set `useDefaultDataSource=true`. If you send base64 directly, also provide `filename`. |
| List reports | `datalion__list_reports` | Direct MCP support exists. Returns report id, name, publish/archive flags, owner, and tab count. |
| Create report | `datalion__create_report` | Direct MCP support exists. Requires `projectId` and report `name`. The report is seeded with a first tab and the response returns both IDs. |
| Create report tab | `datalion__create_report_tab` | Direct MCP support exists. Requires `projectId`, `reportId`, and `description`. Optional tab/dashboard settings can be applied at creation time. |
| Edit report tab | `datalion__edit_report_tab` | Direct MCP support exists. Requires `projectId` and `tabId`, then merges the supplied tab/dashboard fields. |
| Delete report tab | `datalion__delete_report_tab` | Direct MCP support exists. Requires `projectId` and `tabId`. |
| Open project in browser | `datalion__open_project_browser` | Bridge-local helper. Returns the project screen URL. |
| Open report in browser | `datalion__open_report_browser` | Bridge-local helper. Returns the report editor URL, or the tab/dashboard URL when `tabId` is supplied. |
| Open dashboard in browser | `datalion__open_dashboard_browser` | Bridge-local helper. Returns the tab/dashboard screen URL. |
| Open add-widget modal | `datalion__open_add_widget_browser` | Bridge-local helper. Returns the chart-add modal URL for adding a question/widget to a tab/dashboard. |
| Read chart table | `datalion__get_chart_table` | Requires `projectId` plus `chartId` when the chart ID does not already include the project prefix. Optional filters are passed through. |
| List codebook categories | `datalion__list_codebook` | Direct MCP support exists. Returns question-level measure/item categories with `categoryImportId`, `label`, and `fieldname`. |
| Download codebook | `datalion__download_codebook` | Direct MCP support exists. Returns the category tree plus a total count. |
| Generate codebook | `datalion__generate_codebook` | Direct MCP support exists. Regenerates codebook categories from project data. |
| Delete codebook | `datalion__delete_codebook` | Direct MCP support exists. Optional `includeTextboxes=true` expands the deletion to textboxes. |
| Upload codebook CSV | `datalion__upload_codebook` | Direct MCP support exists. The bridge accepts raw CSV `data` or base64 `file`, plus `filename`, optional `importType` (`2` replace, `3` update, `4` append), and optional `columnMapping` as an array aligned to CSV column order. |
| Create or update dashboard | REST `/api/v1/dashboards` or Datalion UI | Current MCP bridge does not expose dashboard CRUD. See `openapi.yaml` and `routes/dashboard.php`. |
| Update report after creation | REST `/api/v1/reports` or Datalion UI | Current MCP bridge exposes report list/create and tab CRUD, but not full report CRUD. |
| Generate exports | Browser/UI or export web routes | Export flows currently live in `routes/export.php` web routes rather than the MCP bridge. |

## Fallback Inspection Points

When the bridge is not enough, inspect these local files before choosing a
fallback path:

- `openapi.yaml`
- `app/Http/Controllers/Api/V1/MCP/McpController.php`
- `routes/dashboard.php`
- `routes/export.php`

The current Datalion checkout exposes:

- API CRUD families under `/api/v1/dashboards` and `/api/v1/reports`
- chart result endpoints under `/api/v1/projects/{projectId}/chart-results`
  and `/api/v1/projects/{projectId}/chart-results/markdown`
- export flows under web routes such as `/{project}/export/xlsx`,
  `/{project}/export/pptx`, and `/{project}/export/csv`

Prefer API routes for authenticated CRUD and browser/UI flows for web-only
exports or screens that rely on existing session state.
