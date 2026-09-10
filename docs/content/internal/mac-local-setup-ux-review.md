---
title: Mac Local Setup UX Review
description: Current product references and a proposed consumer setup flow for HybridClaw's local Mac models.
---

# Mac Local Setup UX Review

Reviewed 2026-09-10 at the user's request. This is a design proposal, not a new
implementation. Research used publisher documentation, release notes, published
screenshots and Exo source. Competitor apps were not installed or tested through
a fresh installation. Screenshot examples can lag the latest binaries; the
models pictured in them do not replace HybridClaw's current shortlist.

## Recommendation

Placement decision (user, 2026-09-10): the proposed setup page belongs under
**Labs → Local Models** in the existing, initially collapsed Labs sidebar group.
Keep normal provider management under Models. The desktop's existing setup,
start and stop actions are grouped under **HybridClaw → Labs**.

Use Jan's focused first-run layout, Msty's managed engine/download workflow and
LM Studio/Bionic's separation of ordinary use from advanced controls. Borrow
Exo's device visibility for later hybrid execution views.

The first screen should offer one recommended model and one clear installation
action. The full twelve-model shortlist belongs behind **Compare models**.
Runtime dependencies should be handled by setup. A user should not need to know
what uv, Python, MLX or a quantization suffix means to get started.

## What the products demonstrate

| Product | Observed setup pattern | Application to HybridClaw |
| --- | --- | --- |
| Jan | Its current quickstart describes automatically downloading a foundation model. The published preparation screen centers one recommendation, size and downloaded bytes. Hub cards expose fit and capability labels, with variants expandable. | One recommendation first; alternatives and artifact details on demand. Show download size before the user starts. |
| Msty Studio | One Local Models area spans MLX, Ollama and Llama.cpp. It recommends a compatible engine, installs missing engines, and keeps installations running during navigation with an activity badge and cancellation. | Treat runtime and weights as one setup job. Keep progress accessible after the setup view is closed. |
| LM Studio | User mode auto-configures ordinary use; Developer mode exposes load/inference settings. Model search, downloads and loaded models are separate concepts. LM Studio 0.4.24 was released September 9. | Keep advanced settings available without requiring decisions about engines or context on the primary path. Distinguish downloaded, checking and running. |
| Bionic, from LM Studio | Its August/September changelog records automatic MLX context sizing from available memory, model loading/prompt-processing progress in transcripts, less prominent runtime downloads, and clearer startup errors. | Keep memory sizing automatic, show the current stage, and provide fixes where an error occurs. |
| Exo | Automatic device discovery and a cluster dashboard. Its current ModelCard renders per-device memory previews; the downloads page exposes bytes, speed, pause, resume and retry per node. | Show where work runs and what memory is needed. Use one-machine progress initially; defer cluster topology to a separate view. |
| Ollama | Its desktop app combines model downloads and chat in a small interface. Document/context controls carry a memory tradeoff. Its current general quickstart is CLI-oriented. | End setup with a useful first interaction. Keep the routine lifecycle simple. |
| Exa | Exa is a web-search/data API. Its public documentation points to dashboard onboarding that generates an integration prompt for a coding agent. The authenticated onboarding itself was not inspected. | Useful as an example of ending setup with a usable integration. It is not evidence for a local-model installer; Exo may be the intended reference. |

Sources: [Jan quickstart and screenshots](https://www.jan.ai/docs/desktop/quickstart),
[Msty local models](https://docs.msty.ai/studio/managing-models/local-models),
[Msty onboarding example](https://msty.ai/resources/blog/getting-started-with-msty-studio/),
[LM Studio modes](https://lmstudio.ai/docs/app/user-interface/modes),
[LM Studio changelog](https://lmstudio.ai/changelog/lmstudio),
[Bionic changelog](https://lmstudio.ai/changelog),
[Exo overview](https://github.com/exo-explore/exo),
[Exo ModelCard at the inspected revision](https://github.com/exo-explore/exo/blob/21a54c5ea0230a3bec1e1a786d200126c7e34ec6/dashboard/src/lib/components/ModelCard.svelte),
[Exo downloads at the inspected revision](https://github.com/exo-explore/exo/blob/21a54c5ea0230a3bec1e1a786d200126c7e34ec6/dashboard/src/routes/downloads/%2Bpage.svelte),
[Ollama desktop app](https://ollama.com/blog/new-app),
[Ollama current quickstart](https://docs.ollama.com/quickstart),
[Exa onboarding description](https://exa.ai/docs/reference/search-api-guide-for-coding-agents).

## Proposed HybridClaw flow

### 1. Your Mac and its recommendation

Open the dedicated **Labs → Local Models** view. Desktop menu and model-selector
setup shortcuts should lead to that same view once it is implemented. Put a
compact setup panel in that view, with this hierarchy:

- **Run a model on this Mac**.
- Detected chip and total memory, with a clear note when other apps constrain
  current availability.
- One recommended model card: name, intended use, download size, estimated
  runtime memory and **Recommended for this Mac**. Memory is an estimate, not a
  measured performance score.
- Primary action: **Download and set up · [size]**.
- Secondary actions: **Compare models**, **Use an existing local server**,
  **Set up later**.

The recommendation must come from the existing admission code and
[current shortlist](local-model-shortlist.md). Do not duplicate thresholds in
the UI or replace the list with models pictured in competitor screenshots.
Keep raw repo/revision, license, engine and context details in a disclosure.
Show unsupported entries in comparison with their reasons, even on large Macs.
Use separate language for **Fits the memory estimate** and **Passed local checks**.

### 2. One setup job with honest progress

Represent preparation, download, verification, model loading and tool checks as
named stages. Show downloaded bytes and measured speed; derive an ETA only when
there is enough evidence. Verification and GPU loading should show their stage
rather than an invented percentage.

The setup job should continue when the user navigates away or closes its view.
A sidebar or model-menu activity indicator returns to progress. A separate
**Cancel setup** action stops the job. Resume after an interrupted download
should be exposed only once the downloader and persisted job state support it.
Do not display a pause button that is merely cancellation under another name.

Manage the pinned Python/MLX runtime within setup, including a supported way to
obtain uv or an equivalent bundled installer. Do not surface a terminal command
as the normal prerequisite path. Keep dependency provenance and detailed logs
available to administrators.

### 3. Ready means tested

After streaming and tool checks pass, show **Ready on this Mac**, the installed
model and a **Try a local task** action. Put measured speed and peak memory under
details and label them as a short setup check. Keep downloaded models visible
when stopped; **Stop** should clearly mean releasing runtime memory, while
removing downloaded files is a separate operation.

Describe the actual guarantee: model inference runs locally. The current
phase-1 implementation does not make every tool, auxiliary call or fallback in
an entire task local. Do not use an unconditional “nothing leaves your Mac”
claim until the later disclosure policy enforces it.

## Recovery belongs in the same view

| State | Useful explanation | Action |
| --- | --- | --- |
| Insufficient current memory | Explain the required estimate and current budget. | Recheck memory; choose a smaller fitting candidate. |
| Insufficient disk space | Show additional space needed and target location. | Retry after freeing space; offer location selection only if supported. |
| Download interrupted | Preserve verified/partial files and identify the failed stage. | Retry; resume when supported by the job backend. |
| Runtime installation failed | Name the prerequisite failure in plain language. | Retry or reveal sanitized diagnostics. |
| Streaming or tool check failed | Explain that the model was not activated. | Retry checks or choose another supported candidate. |
| Unsupported format/runtime | Explain that fitting in memory is insufficient. | View the artifact/limitation; do not offer an active Install button. |
| Existing local server found | Show its endpoint and reachable model list. | Test and connect without downloading a duplicate model. |

## Implemented console flow and remaining work

As of 2026-09-10, **Labs → Local Models** in the web console reads the gateway
Mac's measured memory and current shortlist. It shows one recommendation,
comparison, download size, memory/context estimates, storage admission and
unavailable-artifact reasons. The API runs the shared pinned installer in a
gateway-owned job with named stages and cancellation. Navigation leaves the job
running. Start/stop controls operate the installed model after qualification.
Existing local endpoints remain under Providers.

Progress reports preparation, download/verification, loading, checks and
activation. Byte counts, transfer speed, ETA, a global activity indicator and
managed uv installation remain follow-up work. The page links the uv
prerequisite instructions when it is missing. Job status survives page
navigation, but does not persist across gateway restarts. Cached model files
remain available for retry.

The desktop flow in `desktop/src/mlx-runtime.ts` still uses native dialogs and
a static progress window reached through **HybridClaw → Labs**. Closing that
window cancels desktop-owned installation. Neither setup entry point restarts
the gateway as a side effect.

### Console API boundary and failure notes

`/api/admin/local-models` uses existing authenticated admin dispatch and
same-origin mutation checks. GET requires `admin.models.read`; POST requires
the dedicated `admin.local_models.manage` permission. Both reject non-loopback
sockets, non-local Host headers and forwarding headers. Setup accepts only a
current fitting catalog ID, with no URL, repository, revision, path or shell
arguments. Status projects selected metadata and never returns tokens or raw
subprocess diagnostics. Local inference privacy does not extend automatically
to task tools or other providers.

One in-memory job serializes console operations; the shared filesystem lock
serializes installation with CLI and desktop. Cancellation blocks activation
and restores the prior installation, manifest, token and benchmark. The gateway
stops its owned model during shutdown. Existing externally started services
retain their owner, although an explicitly requested Stop uses authenticated
loopback control. HTTP boundary tests cover authorization and forwarded/remote
requests; service and installer tests cover invalid catalog inputs, admission,
concurrency, cancellation, redacted failures, rollback and shutdown ownership.

Acceptance should cover keyboard/screen-reader operation, a narrow window,
busy-memory and low-disk states, missing runtime prerequisites, interrupted
downloads, leaving/reopening progress, explicit cancellation, failed tool checks
and successful activation. Test the setup job independently of its view.

For later hybrid execution, show **This Mac**, **HybridAI private GPU**,
**HybridAI EU**, and **HybridAI global** as explicit destinations. Exo's sharding
across devices is different from routing work across these policy boundaries;
use its visual clarity without treating those mechanisms as equivalent.
