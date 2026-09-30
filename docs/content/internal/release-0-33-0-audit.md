# v0.33.0 Release Coverage Audit

Audit date: September 30, 2026.

Compared `v0.32.1..56c006e33` using first-parent merge history, the actual
changes behind those merges, and their PR release notes. All 73 merged
PRs are accounted for below. Open PRs and later main commits are outside this
baseline. There are no direct first-parent commits or reverts in this range.
Historical release sections and earlier audit records retain their versions.

## Changelog coverage

| PR | Coverage or exclusion |
| --- | --- |
| [#1604](https://github.com/HybridAIOne/hybridclaw/pull/1604) | Interrupted workers stop taking work |
| [#1606](https://github.com/HybridAIOne/hybridclaw/pull/1606) | Side-effect-aware tool batches |
| [#1608](https://github.com/HybridAIOne/hybridclaw/pull/1608) | Feedback and user audit attribution |
| [#1609](https://github.com/HybridAIOne/hybridclaw/pull/1609) | File-descriptor exhaustion is contained |
| [#1611](https://github.com/HybridAIOne/hybridclaw/pull/1611) | Long model calls remain alive |
| [#1612](https://github.com/HybridAIOne/hybridclaw/pull/1612) | Unicode pipe decoding |
| [#1613](https://github.com/HybridAIOne/hybridclaw/pull/1613) | Malformed tool arguments return for repair |
| [#1614](https://github.com/HybridAIOne/hybridclaw/pull/1614) | MCP errors preserve tools and timeout |
| [#1615](https://github.com/HybridAIOne/hybridclaw/pull/1615) | Prompt/cache token usage |
| [#1616](https://github.com/HybridAIOne/hybridclaw/pull/1616) | Only current-turn artifacts are returned |
| [#1617](https://github.com/HybridAIOne/hybridclaw/pull/1617) | Unicode performance on image-heavy calls |
| [#1618](https://github.com/HybridAIOne/hybridclaw/pull/1618) | Large tool results and paginated file/session reads |
| [#1619](https://github.com/HybridAIOne/hybridclaw/pull/1619) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1620](https://github.com/HybridAIOne/hybridclaw/pull/1620) | Overload and prompt-too-long recovery |
| [#1621](https://github.com/HybridAIOne/hybridclaw/pull/1621) | Overload and prompt-too-long recovery |
| [#1622](https://github.com/HybridAIOne/hybridclaw/pull/1622) | Durable worker state and session-scoped approvals |
| [#1623](https://github.com/HybridAIOne/hybridclaw/pull/1623) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1624](https://github.com/HybridAIOne/hybridclaw/pull/1624) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1625](https://github.com/HybridAIOne/hybridclaw/pull/1625) | Ollama bounded context and num_ctx |
| [#1626](https://github.com/HybridAIOne/hybridclaw/pull/1626) | Native PDF/image delivery and font guidance |
| [#1627](https://github.com/HybridAIOne/hybridclaw/pull/1627) | Ideas and Outputs in chat |
| [#1628](https://github.com/HybridAIOne/hybridclaw/pull/1628) | Pinned approvals, saved shell directory, and workspace fences |
| [#1629](https://github.com/HybridAIOne/hybridclaw/pull/1629) | Strict policy validation and wildcard migration |
| [#1630](https://github.com/HybridAIOne/hybridclaw/pull/1630) | Pinned approvals, saved shell directory, and workspace fences |
| [#1632](https://github.com/HybridAIOne/hybridclaw/pull/1632) | Session approval modes |
| [#1633](https://github.com/HybridAIOne/hybridclaw/pull/1633) | Disabled Signal skips status probes |
| [#1634](https://github.com/HybridAIOne/hybridclaw/pull/1634) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1635](https://github.com/HybridAIOne/hybridclaw/pull/1635) | Secret resolution default documentation |
| [#1636](https://github.com/HybridAIOne/hybridclaw/pull/1636) | Strict policy validation and wildcard migration |
| [#1637](https://github.com/HybridAIOne/hybridclaw/pull/1637) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1638](https://github.com/HybridAIOne/hybridclaw/pull/1638) | WhatsApp sender, IDs, and self-chat limitations |
| [#1639](https://github.com/HybridAIOne/hybridclaw/pull/1639) | WhatsApp sender, IDs, and self-chat limitations |
| [#1640](https://github.com/HybridAIOne/hybridclaw/pull/1640) | Feedback and user audit attribution |
| [#1641](https://github.com/HybridAIOne/hybridclaw/pull/1641) | Pinned approvals, saved shell directory, and workspace fences |
| [#1642](https://github.com/HybridAIOne/hybridclaw/pull/1642) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1643](https://github.com/HybridAIOne/hybridclaw/pull/1643) | Strict policy validation and wildcard migration |
| [#1644](https://github.com/HybridAIOne/hybridclaw/pull/1644) | WhatsApp sender, IDs, and self-chat limitations |
| [#1645](https://github.com/HybridAIOne/hybridclaw/pull/1645) | Pinned approvals, saved shell directory, and workspace fences |
| [#1646](https://github.com/HybridAIOne/hybridclaw/pull/1646) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1647](https://github.com/HybridAIOne/hybridclaw/pull/1647) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1648](https://github.com/HybridAIOne/hybridclaw/pull/1648) | Strict policy validation and wildcard migration |
| [#1649](https://github.com/HybridAIOne/hybridclaw/pull/1649) | Gateway secret injection for Alexa cookies |
| [#1650](https://github.com/HybridAIOne/hybridclaw/pull/1650) | Strict policy validation and wildcard migration |
| [#1651](https://github.com/HybridAIOne/hybridclaw/pull/1651) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1652](https://github.com/HybridAIOne/hybridclaw/pull/1652) | Browser notifications |
| [#1653](https://github.com/HybridAIOne/hybridclaw/pull/1653) | Strict policy validation and wildcard migration |
| [#1654](https://github.com/HybridAIOne/hybridclaw/pull/1654) | Recent chats filter by agent |
| [#1655](https://github.com/HybridAIOne/hybridclaw/pull/1655) | Delegation waits and inherits tool access |
| [#1656](https://github.com/HybridAIOne/hybridclaw/pull/1656) | WhatsApp sender, IDs, and self-chat limitations |
| [#1657](https://github.com/HybridAIOne/hybridclaw/pull/1657) | Channel rich embeds and tool footers |
| [#1658](https://github.com/HybridAIOne/hybridclaw/pull/1658) | Channel rich embeds and tool footers |
| [#1659](https://github.com/HybridAIOne/hybridclaw/pull/1659) | Feedback and user audit attribution |
| [#1663](https://github.com/HybridAIOne/hybridclaw/pull/1663) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1664](https://github.com/HybridAIOne/hybridclaw/pull/1664) | ZIP chat attachments |
| [#1665](https://github.com/HybridAIOne/hybridclaw/pull/1665) | Optional local Laya router |
| [#1666](https://github.com/HybridAIOne/hybridclaw/pull/1666) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1667](https://github.com/HybridAIOne/hybridclaw/pull/1667) | Authenticated gateway-to-worker IPC |
| [#1668](https://github.com/HybridAIOne/hybridclaw/pull/1668) | Ideas and Outputs in chat |
| [#1669](https://github.com/HybridAIOne/hybridclaw/pull/1669) | Native PDF/image delivery and font guidance |
| [#1670](https://github.com/HybridAIOne/hybridclaw/pull/1670) | Pinned approvals, saved shell directory, and workspace fences |
| [#1671](https://github.com/HybridAIOne/hybridclaw/pull/1671) | Published Tools endpoint and plugin SDK loading |
| [#1672](https://github.com/HybridAIOne/hybridclaw/pull/1672) | Memory consolidation skips unchanged input |
| [#1673](https://github.com/HybridAIOne/hybridclaw/pull/1673) | Skill ZIP imports, scanner calibration, and helper scanning |
| [#1674](https://github.com/HybridAIOne/hybridclaw/pull/1674) | Published Tools endpoint and plugin SDK loading |
| [#1676](https://github.com/HybridAIOne/hybridclaw/pull/1676) | Pinned approvals, saved shell directory, and workspace fences |
| [#1678](https://github.com/HybridAIOne/hybridclaw/pull/1678) | Schedule results, ownership, and task visibility |
| [#1679](https://github.com/HybridAIOne/hybridclaw/pull/1679) | Schedule results, ownership, and task visibility |
| [#1680](https://github.com/HybridAIOne/hybridclaw/pull/1680) | Large tool results and paginated file/session reads |
| [#1683](https://github.com/HybridAIOne/hybridclaw/pull/1683) | Internal-only: test coverage, refactor, or design/workflow documentation |
| [#1686](https://github.com/HybridAIOne/hybridclaw/pull/1686) | Schedule results, ownership, and task visibility |
| [#1687](https://github.com/HybridAIOne/hybridclaw/pull/1687) | Phone pairing, stored replies, and phone alerts |
| [#1688](https://github.com/HybridAIOne/hybridclaw/pull/1688) | Phone pairing, stored replies, and phone alerts |
| [#1689](https://github.com/HybridAIOne/hybridclaw/pull/1689) | Phone pairing, stored replies, and phone alerts |

The release also incorporates the existing Unreleased fixes, without repeating
them as separate entries. The Published Tools notes include its subsequent
model pin, header authentication, legacy handshake, and opt-in URL-token work.
The phone notes include account-bound relay registration and reminder previews.

## Dependency review

- Used npm 11.10.0 and the seven-day age gate. Verified registry publication
  times independently for all 51 changed lock entries across 42 package names;
  all qualify as of September 30. No new dependency lifecycle scripts appear.
- Updated compatible MCP SDK, Sentry, Amaro, docx, TanStack, Node types, and tsx
  pins. Nodemailer 10.0.10 fixes the audited high-severity advisories in the
  gateway and Brevo plugin and requires Node 20+, below our Node 22 requirement.
- Deferred newer releases that have not reached seven days, including the
  latest MCP SDK, docx, mailparser, Nodemailer, sanitize-html, Undici, ws, Vite,
  Hono, shell-quote, electron-builder, and sharp. Pre-1.0 packages retain their
  current minor version lines rather than taking an unreviewed breaking upgrade.
- Refreshed root/workspace, standalone container, runtime-tool, and Brevo locks,
  matching shrinkwraps, approved hashes, and third-party notices. No license
  exceptions were added.
- Fixed the refresh command to load the root age policy for standalone container
  resolution and copy npm-updated shrinkwraps into lockfiles, preventing the old
  lock from erasing npm's updates. Regression tests cover preservation and
  failure when a shrinkwrap is missing.
- Existing compatibility markers expire at v0.34; none expire at v0.33.

## Documentation and upgrade review

Updated the README capabilities and release link, canonical contributor version,
console highlights, guide index, local Laya setup, device pairing, scoped tokens,
and PDF/image tool usage. Existing merged guides cover Published Tools, phone
push, schedules, approval modes, and worker-state persistence. The changelog
includes malformed-policy repairs, host wildcard changes, delegation defaults,
WhatsApp sender/ID changes, and matched gateway/worker upgrades.
