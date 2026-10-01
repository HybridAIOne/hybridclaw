# v0.34.0 Release Coverage Audit

Release date: 2026-10-01. Previous published release: `v0.33.0`.
Source range reviewed: `v0.33.0..598d5a628` on `main`, plus this release commit.

The changelog combines merged PR release notes with the actual commit range,
including the existing Unreleased browser notes. No dependency versions or
lifecycle scripts change in the release lockfiles; only product versions change.

| PR | User-facing coverage |
| --- | --- |
| #1691 | Todos, repeating habits, streaks, open-item reminders |
| #1692 | User-scoped phone-shared data and the device_data tool |
| #1693 | Warm workers stop after their agent's traffic window |
| #1694 | Channel SDKs load only when used, reducing idle gateway memory |
| #1695 | Jobs In Progress reflects an executing run |
| #1696 | Schedule results find wrapped-prompt runs |
| #1697 | Mobile prompt trimming and requires.os skill eligibility |
| #1698 | Goals, tracking, outcomes, status history, and check-ins |
| #1699 | Mobile conversation continuity across automatic reset windows |
| #1700 | Phone reply and needs-you alerts carry assistant name and text |
| #1701 | Browser frames, per-checkout approvals, Chromium in images |
| #1702 | Superseded pinned session IDs follow the current conversation |
| #1703 | Internal turn-tail diagnostics; omitted from product highlights |
| #1704 | Signed hosted-owner handoff and history-scoped device tokens |
| #1705 | Device-token media upload |
| #1706 | Closed mac-cua window recovery and headed navigation metadata |
| #1707 | Mobile turns use the local browser |
| #1708 | Paired-device voice sessions continue the chat |
| #1709 | Default phone assistant name is Hy |
| #1710 | mac-cua text clicks, actionable snapshots, live frames |
| #1711 | Reuse unchanged skill hashes and promotion scan signatures |
| #1712 | mac-cua back/forward toolbar buttons and loading-page waits |
| #1713 | Faster IPC, cache-skipping artifact collection, catalog refresh |
| #1714 | Deterministic UUIDs in an audit test; internal-only |
| #1716 | Phone contacts and capped, accent-insensitive source queries |

All non-merge commits in the range belong to these changes. No reverts were
found. #1694 and #1716 merged during preparation and are included in the final range.

## Minor-Release Compatibility Cleanup

Four implementation markers expire at v0.34 and are removed:

- Legacy memory embedding settings are no longer migrated to plugin config.
  Tests cover ignored old keys and preservation of explicit plugin settings.
- Instruction sync no longer removes retired runtime SECURITY.md copies.
  Tests cover active trust-document integrity and preservation of unrelated files.
- The gateway no longer reads output.json from worker images without request IDs.
  Tests cover rejecting an unmatched legacy reply and existing request isolation,
  timeouts, interrupts, and IPC redaction.
- The installer no longer supplies an ONNX CUDA-download environment override.

The changelog documents how to move custom embedding settings, upgrade worker
images, handle retired copies, and install an older ONNX-based release deliberately.
Existing paired tokens need pairing again to obtain the new voice scope.

## Validation Scope

Local checks cover product-version alignment, lockfile policy, root and container
release pack contents, formatting, root typecheck/lint, container lint, build,
IPC/instruction/config tests, and the console release-notes test. PR CI supplies
the complete unit coverage gate, integration/e2e, Docker preflight, installer
shellcheck and tests, dependency signatures, and notices verification.

The macOS system Bash 3.2 cannot parse several pre-existing installer test
command substitutions; Linux CI runs that suite with its supported Bash.
Live credential-based tests are left to configured CI gates.
