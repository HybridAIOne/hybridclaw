# v0.32.1 Release Coverage Audit

Audit date: September 26, 2026.

Compared `v0.32.0..52b6b295c` using first-parent merge history and the
individual changes behind those merges. All 31 merged PRs are covered below.
Open PRs are outside this release baseline. Historical release audit documents
retain the version they describe.

## Changelog Coverage

| PR | v0.32.1 coverage |
| --- | --- |
| [#1572](https://github.com/HybridAIOne/hybridclaw/pull/1572) | Optional Discord replies (added during release audit) |
| [#1573](https://github.com/HybridAIOne/hybridclaw/pull/1573) | CI throughput (added during release audit) |
| [#1574](https://github.com/HybridAIOne/hybridclaw/pull/1574) | Empty auxiliary model replies use the fallback chain |
| [#1575](https://github.com/HybridAIOne/hybridclaw/pull/1575) | Docs response hardening (added during release audit) |
| [#1577](https://github.com/HybridAIOne/hybridclaw/pull/1577) | Lazy Google shell authentication (added during release audit) |
| [#1578](https://github.com/HybridAIOne/hybridclaw/pull/1578) | Shell approval, deletion, pinned-path, and workspace-fence fixes |
| [#1579](https://github.com/HybridAIOne/hybridclaw/pull/1579) | Leaner root dependencies |
| [#1580](https://github.com/HybridAIOne/hybridclaw/pull/1580) | Model-facing safety instructions (added during release audit) |
| [#1581](https://github.com/HybridAIOne/hybridclaw/pull/1581) | Eval harness moved out of the product build |
| [#1582](https://github.com/HybridAIOne/hybridclaw/pull/1582) | Unicode PDF generation (added during release audit) |
| [#1583](https://github.com/HybridAIOne/hybridclaw/pull/1583) | Test isolation (added during release audit) |
| [#1584](https://github.com/HybridAIOne/hybridclaw/pull/1584) | Agent budget hard stop |
| [#1585](https://github.com/HybridAIOne/hybridclaw/pull/1585) | Running downloaded code needs explicit approval |
| [#1587](https://github.com/HybridAIOne/hybridclaw/pull/1587) | npm publishing |
| [#1588](https://github.com/HybridAIOne/hybridclaw/pull/1588) | Document delivery; paginated pages in web_fetch |
| [#1589](https://github.com/HybridAIOne/hybridclaw/pull/1589) | Runtime SECURITY.md copy retired |
| [#1590](https://github.com/HybridAIOne/hybridclaw/pull/1590) | Attachments in follow-up turns; interrupted turns keep their tool calls |
| [#1591](https://github.com/HybridAIOne/hybridclaw/pull/1591) | Binary uploads without copying bytes through the model (added during release audit) |
| [#1592](https://github.com/HybridAIOne/hybridclaw/pull/1592) | MCP tool annotations respected |
| [#1593](https://github.com/HybridAIOne/hybridclaw/pull/1593) | Test isolation (added during release audit) |
| [#1594](https://github.com/HybridAIOne/hybridclaw/pull/1594) | Failed turns and delegations |
| [#1595](https://github.com/HybridAIOne/hybridclaw/pull/1595) | Test isolation (added during release audit) |
| [#1596](https://github.com/HybridAIOne/hybridclaw/pull/1596) | Failed turns and delegations |
| [#1597](https://github.com/HybridAIOne/hybridclaw/pull/1597) | Atomic agent output files |
| [#1598](https://github.com/HybridAIOne/hybridclaw/pull/1598) | Media-tools and transformers-embeddings plugin moves; Mermaid parser removal |
| [#1599](https://github.com/HybridAIOne/hybridclaw/pull/1599) | macOS browser control window isolation |
| [#1600](https://github.com/HybridAIOne/hybridclaw/pull/1600) | Turns right after an interrupt |
| [#1601](https://github.com/HybridAIOne/hybridclaw/pull/1601) | Routed turns keep their tool calls |
| [#1602](https://github.com/HybridAIOne/hybridclaw/pull/1602) | Warm-pool refill failures |
| [#1603](https://github.com/HybridAIOne/hybridclaw/pull/1603) | Changelog correction: refiled entries and normalized section order |
| [#1605](https://github.com/HybridAIOne/hybridclaw/pull/1605) | Retries that repeated tool side effects |

## Documentation Review

- Added the file-reference syntax, supported tools, file-size limit, and
  `http_request.bodyBase64` example to the tools reference.
- Documented optional replies in the Discord channel guide.
- Existing merged docs cover budget hard stops, plugin installation and
  embeddings migration, eval-harness commands, shell approval rules, lazy
  Google shell authentication, and request-scoped IPC replies.
- Updated the README release link, contributor-facing version snapshot,
  package metadata, and console What's New highlights to v0.32.1.
- Reviewed lockfile diffs: only product version fields changed in this
  preparation; dependency versions and lifecycle scripts are unchanged.

## Upgrade Notes

Media generation and transcription require the `media-tools` plugin. Local
Transformers.js embeddings require `transformers-embeddings`; non-default
embedding settings migrate once. The Codex app-server runtime and installed
eval CLI are removed. These changes are explicitly described in the changelog
and retained in the release summary despite the requested patch version.
