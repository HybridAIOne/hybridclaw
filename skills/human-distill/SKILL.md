---
name: human-distill
description: "Distill a real person into a hireable coworker agent from their source material — chat exports, emails, meeting transcripts, documents, interviews, and live mirroring. Use when the operator wants to clone a colleague, build a coworker from someone's writing, onboard a digital twin, or asks to 'distill', 'clone', or 'mirror' a person. Consent-gated for real humans."
user-invocable: true
metadata:
  hybridclaw:
    category: productivity
    short_description: "Distill a human into a coworker agent."
    tags:
      - coworker
      - distillation
      - persona
      - cloning
      - onboarding
    related_skills:
      - skill-creator
      - personality
---

# Human Distillation

Turn a person's source material into a working coworker agent: a persona
written into the agent identity files (`IDENTITY.md`, `SOUL.md`, `USER.md`,
`CV.md`) and a work-module skill (`skills/<alias>-playbook/`) that carries
their workflows, preferences, and judgment. Every generated claim cites the
corpus documents it came from; nothing is invented beyond the source.

The deterministic engine is the `hybridclaw coworker` CLI. Your judgment
enters the pipeline through exactly one artefact: `extraction.json`. You never
edit the persona files directly — the engine renders them from validated
claims so every line stays cited, versioned, and reversible.

## Hard rules

1. **Consent first.** Distilling a real, named human requires a recorded
   consent artefact. Never run `coworker consent record` on your own
   initiative or invent a consent statement — the operator must provide the
   statement and run (or explicitly dictate) the command. If a run is
   blocked, relay the remediation message and stop.
2. **Evidence or nothing.** Every claim in `extraction.json` must cite real
   corpus document ids from the analysis packet. If you cannot support a
   claim, leave it out or put the question in `openQuestions`. The engine
   flags and drops uncited claims — do not try to route around it.
3. **Never impersonate.** The coworker mirrors the subject's judgment, not
   their identity. Do not sign as the subject or present generated output as
   written by them.
4. **Privacy.** Third-party PII is masked at ingest. If you see unmasked
   third-party contact details anywhere in generated output, stop and run
   `hybridclaw coworker eval --alias <alias>` to surface it.

## Pipeline

```
hybridclaw coworker distill --alias <alias> --name "<display name>" \
  [--role "<role>"] [--match-alias <name|email>]... --source <path> [...]
```

Stages run in order, each resumable: `ingest → analyse → build → merge →
correct`. The run record lives at `runtime/distill/<run-id>/run.json` in the
coworker's agent workspace, with a human-readable `REPORT.md` beside it.

1. **Intake.** Ask the operator: who is being distilled (display name, role,
   relationship), which aliases/emails identify their authorship
   (`--match-alias`, critical for chat exports), whether they are a real
   person (default) or fictional (`--fictional`), and what source material
   exists.
2. **Consent.** For a real person, confirm consent is recorded
   (`hybridclaw coworker consent show --alias <alias>`). If not, give the
   operator the exact `consent record` command to run and wait.
3. **Ingest + analyse.** Run `coworker distill` with the sources. The engine
   masks third-party PII, weights quality (authored long-form > chat
   one-liners), holds out a slice for eval, and writes an analysis packet.
4. **Extract.** Read `analysis/PACKET.md` in the run directory and write
   `analysis/extraction.json` following
   [references/extraction-contract.md](references/extraction-contract.md)
   and the six-dimension model in
   [references/six-dimensions.md](references/six-dimensions.md).
5. **Merge.** Resume the run
   (`coworker distill --alias <alias> --resume <run-id>`). The engine
   validates citations, merges claims, writes the persona files and the
   work-module skill as versioned edits, and opens review items for any
   conflict you declared. Report flagged claims and open reviews to the
   operator verbatim from `REPORT.md`.
6. **Verify.** Run `hybridclaw coworker eval --alias <alias>`. A leakage
   failure must be reported and fixed before the coworker is used.

## Intake modalities

Use every channel of evidence the operator can provide; they compound:

| Modality | How |
|---|---|
| Chat exports | Slack export dirs/JSON, generic chat JSONL — `--kind auto` detects them |
| Email | `.mbox` archives |
| Meetings ("listening") | Speaker-labelled transcripts (`Name: text` lines) |
| Writing samples | Markdown / text docs, decision records, posts |
| Questionnaire | `hybridclaw coworker interview --alias <alias> [--audience subject\|colleague] --out <file>` generates a gap-driven interview targeting the dimensions with least evidence; the answered file is ingested with `--kind interview` (highest weight) |
| Mirroring | Live draft-compare-diff sessions per [references/mirroring.md](references/mirroring.md); differences become corrections |

After each merge, check `openQuestions` and dimension coverage in the packet;
offer the operator a fresh interview round for the weakest dimensions.

## Incremental updates and corrections

- New material later: same `coworker distill` command — only the delta is
  re-analysed; standing conclusions are never overwritten. Contradictions
  you declare via `conflictsWith` become review items the operator resolves
  with `coworker review resolve`.
- When the operator corrects the coworker's behaviour in conversation
  ("she'd never open with a greeting"), persist it immediately:
  `hybridclaw coworker correct --alias <alias> --note "<correction>"`.
  It becomes a maximum-weight corpus document and is promoted into the
  persona on the next run. Then continue with the corrected behaviour in the
  current session.

## Operating boundaries

- Green: reading sources/corpus/status/reports, generating questionnaires,
  writing `extraction.json`, `coworker status|eval|interview|review list`.
- Amber (confirm with the operator first): `coworker distill` runs and
  resumes (they write workspace files, reversibly), `coworker correct`,
  `coworker review resolve`, `coworker export`.
- Red (never): recording or fabricating consent, `coworker forget`
  (operator-only), editing generated persona/skill files by hand, distilling
  someone the operator has not named.

## Container note

If `hybridclaw` is not on PATH (sandboxed container session), do the
file-contract half yourself — read `PACKET.md`, write `extraction.json` —
and hand the operator the exact `distill --resume` command to run locally.

## Deeper material

- [references/six-dimensions.md](references/six-dimensions.md) — the persona model and what evidence each dimension needs
- [references/extraction-contract.md](references/extraction-contract.md) — the `extraction.json` schema with a worked example
- [references/interview-protocol.md](references/interview-protocol.md) — running subject and colleague interviews well
- [references/mirroring.md](references/mirroring.md) — the live mirroring loop and fidelity grading
