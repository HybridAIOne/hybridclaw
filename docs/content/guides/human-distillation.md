---
title: Human Distillation
description: Distill a real person's source material into a coworker agent with consent gating, cited claims, reversible merges, and multi-host export.
sidebar_position: 14
---

# Human Distillation

`hybridclaw coworker` turns a person's source material — chat exports,
emails, meeting transcripts, documents, interview answers — into a working
coworker agent: a persona written into the standard identity files
(`IDENTITY.md`, `SOUL.md`, `USER.md`, `CV.md`) plus a generated work-module
skill carrying their workflows, output preferences, and worked examples.

Three properties make the result trustworthy rather than vibes-based:

1. **Citations are structural.** Model judgment enters the pipeline through
   one validated artefact (`extraction.json`); every claim must cite corpus
   document ids, and uncited claims are flagged into the run report instead
   of written into the persona.
2. **Merges are reversible.** Every generated file is snapshotted into the
   F4 revision database; conflicting evidence opens a review item the
   operator resolves explicitly — nothing standing is silently overwritten.
3. **Consent is a hard gate.** A run that names a real human is blocked
   until a consent artefact is recorded, the block is audited, and the
   subject can be erased as one identifier set later.

## Quickstart

```bash
# 1. Record the subject's consent (required for real people).
hybridclaw coworker consent record --alias maya \
  --granted-by "Maya Lindqvist" --method written \
  --statement "I consent to HybridClaw distilling my work communications into a coworker agent."

# 2. Run the pipeline over their source material.
hybridclaw coworker distill --alias maya --name "Maya Lindqvist" \
  --role "Staff Engineer" --match-alias maya@example.com \
  --source ./slack-export --source ./maya-mail.mbox --source ./decision-records

# 3. The run parks at `awaiting-extraction`. An agent (see the
#    `human-distill` skill) reads analysis/PACKET.md, writes
#    analysis/extraction.json with cited claims, then:
hybridclaw coworker distill --alias maya --resume <run-id>

# 4. Verify before use.
hybridclaw coworker eval --alias maya
```

The coworker boots like any other agent: its workspace identity files are
the distilled persona, and `skills/<alias>-playbook/` is its work module.

## Pipeline stages

`ingest → analyse → build → merge → correct`, individually resumable; a
killed run continues from the last completed stage. Run records live at
`runtime/distill/<run-id>/run.json` in the coworker's agent workspace with a
human-readable `REPORT.md` summarising what was extracted, what was flagged,
and what needs operator review.

| Stage | What happens |
|---|---|
| `ingest` | Collectors normalise sources into an agent-scoped corpus (`distill/<alias>/corpus/documents.jsonl`) with author, timestamp, source, quality weight, and a stable provenance id per document. Third-party emails and phone numbers are masked at ingest; operator `.confidential.yml` rules are applied irreversibly. A deterministic slice is held out for eval. |
| `analyse` | The corpus delta (documents not yet analysed) is packaged into `analysis/PACKET.md` together with standing conclusions and per-dimension coverage. |
| `build` | The analysing agent writes `extraction.json`; the engine validates every citation and flags unsupported claims. |
| `merge` | Validated claims merge into standing state; persona files and the work-module skill are rendered and written as F4-versioned edits; declared conflicts open review items. |
| `correct` | Pending conversational corrections are queued for the next analyse cycle. |

## Source modalities

| Source | Format | Notes |
|---|---|---|
| Slack export | Export directory or per-channel JSON | `users.json` resolves author names; conversations and the subject's long-form messages are both captured |
| Email | `.mbox` | Quoted replies and MIME noise stripped |
| Meetings | Speaker-labelled transcripts (`Name: text`) | Detected automatically in `.txt`/`.log` files |
| Documents | Markdown / plain text | Highest-weight behavioural evidence |
| Chat logs | Generic JSONL (`author`/`text`/`timestamp`) | |
| Interview | Generated questionnaire | `hybridclaw coworker interview` targets the dimensions with least evidence; answered files ingest at maximum weight |

Quality weighting is deterministic: authored long-form text ranks above
casual one-liners, third-party material is context only, and interview
answers and corrections rank highest.

## Corrections, reviews, and re-distillation

- `hybridclaw coworker correct --alias maya --note "she'd never open with a
  greeting"` records a maximum-weight correction promoted into the persona
  on the next run, as a `correction`-dimension claim that overrides
  conflicting inferences.
- New source material later re-runs analysis on the delta only. When new
  evidence contradicts a standing claim, the merge opens a review item:
  `hybridclaw coworker review resolve --alias maya --id <review-id> --keep
  standing|incoming|both`. The decision is recorded and reversible.
- `hybridclaw config revisions` surfaces the F4 history of every generated
  file.

## Privacy and trust

- **Consent artefact** (`consent.json`): who granted it, how, the statement
  itself, and an integrity digest. `consent revoke` blocks future runs.
- **Masking**: third-party PII is masked before material lands in the
  corpus; the leakage eval fails if any reaches generated output.
- **Audit**: every lifecycle action — including blocked runs and each merged
  claim — is a `distill.*` event in the hash-chained audit trail under the
  `distill:<alias>` session.
- **Right to be forgotten**: `hybridclaw coworker forget --alias maya
  --confirm` removes the corpus, persona files, work module, run artefacts,
  and their revision snapshots as one set. The erasure event itself stays in
  the append-only audit trail.

## Eval

`hybridclaw coworker eval` runs a leakage scan over all generated files
(third-party PII, citations of unknown documents, confidential-rule hits —
any finding fails with exit code 1) and prepares fidelity prompts from the
held-out corpus slice so a grader can compare the coworker's answers against
what the subject actually wrote.

## Export

```bash
hybridclaw coworker export --alias maya --host claude-code
```

Exports one canonical bundle (persona + skill + state + manifest; corpus
excluded unless `--include-corpus`) and installs it via thin per-host
adapters for `claude-code`, `codex`, `openclaw`, or `hybridclaw`.
`hybridclaw coworker import --alias maya --bundle <dir>` round-trips the
bundle into a fresh agent workspace without re-distillation.

## See also

- The bundled [`human-distill` skill](../extensibility/skills.md) drives the
  agent half of the pipeline: intake, interviews, mirroring sessions, and
  writing the extraction contract.
- Roadmap: R72 in `docs/content/internal/roadmap.md`.
