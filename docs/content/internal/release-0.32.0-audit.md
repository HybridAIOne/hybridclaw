# v0.32.0 Release Coverage Audit

Prepared on 2026-09-25 against `26f564eaefae7c1d44faf1ffed11022aa68591e6`,
which matched GitHub `main` at audit time. The last published release was
`v0.31.1`. Scope is every merged PR whose merge commit is reachable in
`v0.31.1..HEAD`: **42 PRs**, including stacked #1533 and #1545. Unmerged PRs
and work already released in v0.31.1 are excluded.

Compared PR descriptions and changed-file inventories with the current
changelog, documentation, and implementation where behavior needed confirmation.
This is a release documentation audit, not a repeat code/security review of
all 42 PRs.

**23 PRs lacked explicit changelog coverage** and are covered in the
v0.32.0 section. Related PRs share entries where appropriate. “Existing” below
means the unreleased changelog already covered the change; “Added” means this
preparation supplied coverage. Documentation links point to the final guidance,
including updates made during this audit. Internal-only fixes need no new
operator command: the installer CUDA default and Codex cache affinity are
recorded in the changelog.

| PR | Changelog coverage | Topic | Documentation |
| --- | --- | --- | --- |
| [#1402](https://github.com/HybridAIOne/hybridclaw/pull/1402) | Added | Qwen thinking effort | [Reference](../channels/admin-console.md) |
| [#1432](https://github.com/HybridAIOne/hybridclaw/pull/1432) | Existing | Codex cache affinity and grounded voice reassurance | [Reference](../guides/twilio-voice.md) |
| [#1505](https://github.com/HybridAIOne/hybridclaw/pull/1505) | Added | Teams assignments and per-user usage | [Reference](../channels/msteams.md) |
| [#1523](https://github.com/HybridAIOne/hybridclaw/pull/1523) | Existing | Twilio credential recovery | [Reference](../guides/twilio-voice.md) |
| [#1527](https://github.com/HybridAIOne/hybridclaw/pull/1527) | Added | Routing transparency and manual escalation | [Reference](../reference/model-selection.md) |
| [#1528](https://github.com/HybridAIOne/hybridclaw/pull/1528) | Added | Readable tool-result spill files | [Reference](../developer-guide/memory.md) |
| [#1529](https://github.com/HybridAIOne/hybridclaw/pull/1529) | Existing | Daily memory in Agent Files | [Reference](../reference/faq.md) |
| [#1530](https://github.com/HybridAIOne/hybridclaw/pull/1530) | Added | Tool error flags and tools-used accuracy | [Reference](../developer-guide/memory.md) |
| [#1531](https://github.com/HybridAIOne/hybridclaw/pull/1531) | Existing | Shared history/compaction budget | [Reference](../developer-guide/memory.md) |
| [#1532](https://github.com/HybridAIOne/hybridclaw/pull/1532) | Existing | Chat Recall labels and deduplication | [Reference](../developer-guide/memory.md) |
| [#1533](https://github.com/HybridAIOne/hybridclaw/pull/1533) | Existing | One compaction engine (stacked into #1531) | [Reference](../developer-guide/memory.md) |
| [#1535](https://github.com/HybridAIOne/hybridclaw/pull/1535) | Added | Cache accounting and pricing | [Reference](../channels/admin-console.md) |
| [#1536](https://github.com/HybridAIOne/hybridclaw/pull/1536) | Existing | Cron update action | [Reference](../reference/commands.md) |
| [#1539](https://github.com/HybridAIOne/hybridclaw/pull/1539) | Added | Deferred MCP catalog | [Reference](../reference/configuration.md) |
| [#1540](https://github.com/HybridAIOne/hybridclaw/pull/1540) | Added | Unified routing and shadow comparisons | [Reference](../reference/model-selection.md) |
| [#1541](https://github.com/HybridAIOne/hybridclaw/pull/1541) | Added | Inline and display equations | [Reference](../channels/admin-console.md) |
| [#1542](https://github.com/HybridAIOne/hybridclaw/pull/1542) | Added | Session RAG inheritance | [Reference](../developer-guide/memory.md) |
| [#1543](https://github.com/HybridAIOne/hybridclaw/pull/1543) | Added | Agentic TPM skill and package | [Reference](../extensibility/agent-packages.md) |
| [#1544](https://github.com/HybridAIOne/hybridclaw/pull/1544) | Added | HybridAI OAuth browser sign-in | [Reference](../getting-started/authentication.md) |
| [#1545](https://github.com/HybridAIOne/hybridclaw/pull/1545) | Added | Headless device sign-in (stacked into #1544) | [Reference](../getting-started/authentication.md) |
| [#1546](https://github.com/HybridAIOne/hybridclaw/pull/1546) | Existing | Competitor monitoring | [Reference](../../../community-skills/competitor-monitoring/SKILL.md) |
| [#1547](https://github.com/HybridAIOne/hybridclaw/pull/1547) | Added | Silent scheduled delivery | [Reference](../reference/commands.md) |
| [#1548](https://github.com/HybridAIOne/hybridclaw/pull/1548) | Added | Shared office runtime libraries | [Reference](../guides/office-dependencies.md) |
| [#1549](https://github.com/HybridAIOne/hybridclaw/pull/1549) | Added | Cross-chat web cron management | [Reference](../reference/commands.md) |
| [#1550](https://github.com/HybridAIOne/hybridclaw/pull/1550) | Added | Skill library requirements | [Reference](../extensibility/skills.md) |
| [#1552](https://github.com/HybridAIOne/hybridclaw/pull/1552) | Added | MCP/A2A RBAC and deny-by-default routes | [Reference](../developer-guide/admin-access-control.md) |
| [#1553](https://github.com/HybridAIOne/hybridclaw/pull/1553) | Existing | Connector credential RBAC | [Reference](../developer-guide/admin-access-control.md) |
| [#1554](https://github.com/HybridAIOne/hybridclaw/pull/1554) | Existing | Pinned lookups and grep traversal | [Reference](../developer-guide/approvals.md) |
| [#1555](https://github.com/HybridAIOne/hybridclaw/pull/1555) | Existing | IPv6 SSRF guards | [Reference](../developer-guide/approvals.md) |
| [#1556](https://github.com/HybridAIOne/hybridclaw/pull/1556) | Existing | Pinned reads, glob, and grep (shared entry with #1554) | [Reference](../developer-guide/approvals.md) |
| [#1557](https://github.com/HybridAIOne/hybridclaw/pull/1557) | Existing | Competitor examples are templates | [Reference](../../../community-skills/competitor-monitoring/SKILL.md) |
| [#1558](https://github.com/HybridAIOne/hybridclaw/pull/1558) | Existing | Credential controls follow permissions | [Reference](../developer-guide/admin-access-control.md) |
| [#1559](https://github.com/HybridAIOne/hybridclaw/pull/1559) | Existing | Anomaly scoring and red approval | [Reference](../internal/approval-rule-pipeline.md) |
| [#1560](https://github.com/HybridAIOne/hybridclaw/pull/1560) | Existing | Pinned shell/upload paths and quoted writes | [Reference](../developer-guide/approvals.md) |
| [#1561](https://github.com/HybridAIOne/hybridclaw/pull/1561) | Existing | Gateway SSRF and DNS rebinding | [Reference](../developer-guide/approvals.md) |
| [#1562](https://github.com/HybridAIOne/hybridclaw/pull/1562) | Added | Disabled routing controls | [Reference](../channels/admin-console.md) |
| [#1564](https://github.com/HybridAIOne/hybridclaw/pull/1564) | Added | Serving-provider logos | [Reference](../channels/admin-console.md) |
| [#1565](https://github.com/HybridAIOne/hybridclaw/pull/1565) | Added | Contributor rules | [Reference](../../../AGENTS.md) |
| [#1566](https://github.com/HybridAIOne/hybridclaw/pull/1566) | Existing | GPT-6 Luna default | [Reference](../reference/model-selection.md) |
| [#1567](https://github.com/HybridAIOne/hybridclaw/pull/1567) | Added | Platform-aware installers | [Reference](../extensibility/skills.md) |
| [#1570](https://github.com/HybridAIOne/hybridclaw/pull/1570) | Existing | Skip unused CUDA download | [Reference](../getting-started/installation.md) |
| [#1571](https://github.com/HybridAIOne/hybridclaw/pull/1571) | Added | Discord announcements | [Reference](../channels/discord.md) |

## Preparation Checks

- Product packages, lockfiles, shrinkwraps, and the console What's New dialog
  target v0.32.0. The initial version-only preparation was followed by the
  requested dependency refresh described below.
- No `compat: remove after vX.Y` implementation markers were found, so no
  compatibility code was removed.
- README's latest-release link remains v0.31.1 until v0.32.0 is published.
- No runtime logic, security policy, or running services were changed.
  Dependency manifests and locks were refreshed. This preparation is delivered
  through a pull request; tagging and release publication remain separate.
- Run the release checks after the final build and recheck GitHub main before
  publication; later merges are outside this snapshot.

## Dependency Refresh

The follow-up refresh uses npm **11.10.0** with `min-release-age=7`, exact
pins, existing major-version bounds (existing minor bounds for 0.x), and Node
22 engine enforcement. Registry publication timestamps were independently
checked against **2026-09-18T15:27:16Z**: all **165 changed npm registry lock
entries** pass. **41 manifest pins/overrides across 27 package names** changed.
This includes gateway, container, console, desktop tooling, managed-browser,
and plugin dependencies; no npm major migration was attempted.

Highlights: React/React DOM 19.3.0, Playwright 1.63.0, Vite 8.3.0, Sentry
10.75.0, DOMPurify 3.4.15, JSZip 3.10.2, updated mail/parser/network libraries,
and refreshed transitive dependencies. Both shrinkwraps byte-match their locks.
The only changed npm package with an install lifecycle is fsevents 2.3.3; its
existing native `node-gyp rebuild` installation was reviewed. No new lifecycle
package or license exception was introduced.

Held back by age: newer releases of the MCP SDK, docx, csv-parse, tsx, Hono,
Undici, TanStack libraries, Vite, and others. agent-browser remains 0.27.0
because its newer compatible-range patches require Node 24. The runtime-tools
lock also moves two previously too-new `@types/node` resolutions back to
age-eligible versions.

Python runtime tools use the same cutoff through `uv pip compile --exclude-newer`
with universal Python 3.11 resolution and hashes. pypdf moves to 5.9.0,
pdfplumber to 0.11.9, and reportlab to 4.5.1. pdfplumber 0.11.10 is held because
it requires a Pillow major upgrade. The MLX direct pin has no eligible update
in its current compatibility range; the pinned Spark source is unchanged.

## Validation Results

- `npm run lint`, container lint, and `npm run build`: passed, including
  console and desktop typechecks and the console/container/gateway builds.
- Root and container `release:check`, dependency policy, version alignment,
  and `notices:check`: passed. SBOMs regenerated under ignored `sbom/`.
- Vulnerability audit and npm registry signature/attestation audit: passed.
- Console: **1,076 tests passed**. Desktop: **30 tests passed**.
- Tool-catalog IPC integration: **18 tests passed**.
- Python 3.11 hash-verified install and smoke tests: passed for PDF generation,
  extraction, rendering, XLSX round-trip, image reading, and pdf2image import.
- `npm run format` and `git diff --check`: passed; existing Biome warnings,
  large bundle warnings, and allowed license-metadata warnings remain.

The initial full root unit run passed **6,531 tests** and failed **42** in
17 suites. Local configuration/credential discovery, sandbox database access,
and fixture isolation affected this run. Reruns from a clean temporary source
copy used an explicit Node 22 binary and excluded checkout-local `.env` data.
The OAuth, cloud-memory, audio-transcription, and full-auto suites passed there
without a global runtime-directory override that would defeat their own
per-test home isolation.

The remaining **13 suites** were compared with the original HEAD dependency
lock in a separate temporary source copy under the same Node 22 and isolated
runtime settings. **Both versions produced exactly 584 passes and the same
four failures**:

- Gateway HTTP: configured voice webhook path.
- Gateway HTTP: URL-auth secret-placeholder fetch expectation.
- Gateway HTTP: Google OAuth URL-auth fetch expectation.
- Postinstall bootstrap: direct-script subprocess exit status.

No additional failures appeared in that dependency comparison. These four
baseline failures remain unresolved; the full root suite is not claimed green.
The temporary LINE install tree was moved outside the repository after its
verification because npm packing otherwise included upstream dependency tests.
Both packaging checks passed on the resulting package input.

Docker image builds, full integration/e2e suites, and live-provider tests were
not run. Updated browser/native libraries have build and unit coverage here,
but browser downloads, live channels, and image-level behavior still require
release CI or deployment validation.

## Handoff

No runtime implementation or security policy changed. Net production source
lines: **0**; production lines added to files over 1,000 lines: **0**; runtime
fact definitions added or removed: **0**. Dependency pins, generated artifacts,
release notes, and documentation account for the changes.

Next: review the preparation PR and baseline test failures, recheck merges
since the audit snapshot, then merge, update README's latest-release link, tag,
and publish when release execution is requested. No gateway restart or global
CLI relink was performed.
