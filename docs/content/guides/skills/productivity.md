---
title: Productivity Skills
description: Feature planning, human distillation, project management, Miro boards, and Trello board integration.
sidebar_position: 6
---

# Productivity Skills

## feature-planning

Break features into implementation plans, acceptance criteria, and sequenced
tasks.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> The skill inspects current code paths, types, and tests before planning.
>
> Task definitions include exact file paths and verification commands.
>
> Risky/uncertain work is sequenced first to surface blockers early.

> 🎯 **Try it yourself**
>
> `Plan the implementation of a user notification system with email and in-app channels`
>
> `Break down the migration from REST to GraphQL into tasks with acceptance criteria`
>
> `What's the safest sequence to refactor the auth middleware?`
>
> `Analyze the current authentication flow in this project, identify what needs to change to add OAuth2 support, break it into sequenced tasks with acceptance criteria, and flag any risky dependencies`
>
> **Conversation flow:**
>
> `1. Plan the implementation of a webhook delivery system with retry logic and dead-letter queue`
> `2. The retry backoff strategy — break that subtask down further with exact acceptance criteria and edge cases`
> `3. What's the riskiest part of this plan and what should we prototype first?`

---

## human-distill

Distill a real person's source material into a coworker agent with consent
gating, cited claims, reversible merges, leakage/fidelity evals, and
multi-host export.

**Prerequisites** — source material owned or approved for this use, plus a
recorded consent artefact before distilling a real, named human.

```bash
hybridclaw coworker consent record --alias maya \
  --granted-by "Maya Lindqvist" --method written \
  --statement "I consent to HybridClaw distilling my work communications into a coworker agent."

hybridclaw coworker distill --alias maya --name "Maya Lindqvist" \
  --source ./slack-export --source ./maya-mail.mbox
```

> 💡 **Tips & Tricks**
>
> The deterministic engine is `hybridclaw coworker`; the `human-distill` skill drives intake, extraction, interviews, and mirroring.
>
> Every persona claim must cite corpus document ids. Unsupported claims are flagged into the run report instead of written into identity files.
>
> Use `hybridclaw coworker eval --alias <alias>` before assigning real work to a distilled coworker.

> 🎯 **Try it yourself**
>
> `Help me prepare a consent-gated distillation run for Maya from this Slack export and mbox file`
>
> `Review this distillation analysis packet and write extraction.json with cited claims only`
>
> `Run the coworker leakage/fidelity eval and summarize any blockers`

**Troubleshooting**

- **Consent missing** — record consent first; the pipeline blocks real-person
  distillation without it.
- **Uncited claims** — remove the claim or cite a real corpus document id from
  the analysis packet.
- **PII leakage** — stop and run the eval; fix generated files before using
  the coworker.

See [Human Distillation](../human-distillation.md) for the full workflow.

---

## project-manager

Plan sprints, milestones, roadmaps, risks, dependencies, and stakeholder
updates for team delivery.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> Outputs include: implementation plans, milestone tables, risk registers, sprint plans, stakeholder updates, dependency maps.
>
> Estimates are always labeled as assumptions.
>
> Status updates are kept short and decision-oriented.

> 🎯 **Try it yourself**
>
> `Create a 4-week sprint plan for the checkout redesign with milestones and exit criteria`
>
> `Build a risk register for the database migration with impact, probability, and mitigation for each risk`
>
> `Map the dependencies between the auth, billing, and notification workstreams`
>
> `Review the current sprint board, identify items at risk of slipping, build an updated risk register, and draft a stakeholder update email summarizing progress and blockers`
>
> **Conversation flow:**
>
> `1. Create a 6-week roadmap for launching a new billing system with milestones for design, implementation, testing, and rollout`
> `2. Add a risk register for the top 5 risks, each with impact, probability, and mitigation plan`
> `3. Draft a stakeholder update email summarizing the roadmap and calling out the two highest risks`

---

## miro

Discover Miro boards, read board items for planning and summaries, prepare
guarded board writes, and run Enterprise board export workflows through
SecretRef-backed API requests.

**Prerequisites** — a Miro OAuth app or access token with the narrowest board
scopes needed for the task. Enterprise board export also requires a Discovery
token with `boards:export`, a Miro Enterprise plan, Company Admin role, and
enabled eDiscovery.

Set normal board access:

```bash
hybridclaw secret set MIRO_ACCESS_TOKEN "<oauth-or-access-token>"
```

For Enterprise exports:

```bash
hybridclaw secret set MIRO_DISCOVERY_ACCESS_TOKEN "<enterprise-discovery-token>"
```

> 💡 **Tips & Tricks**
>
> Use `MIRO_ACCESS_TOKEN` for board discovery, item reads, and guarded board
> writes. Use `MIRO_DISCOVERY_ACCESS_TOKEN` only for Enterprise export APIs.
>
> Start with `list-boards`, `get-board`, and `list-items` before summarizing a
> board or planning a change.
>
> Board writes require an approval plan and explicit operator grant. Supported
> writes are sticky notes, text items, shapes, connectors, and frames.
>
> The v1 skill refuses board deletes, item deletes, and permission/share
> changes.

> 🎯 **Try it yourself**
>
> `List my accessible Miro boards matching "roadmap"`
>
> `Summarize sticky notes on the product planning board`
>
> `Prepare an approval plan to add a decision sticky note to this board`
>
> `Create an Enterprise export plan for the quarterly roadmap board`

**Troubleshooting**

- **Missing `MIRO_ACCESS_TOKEN`** — set it in `/admin/secrets`, with
  `/secret set`, or with `hybridclaw secret set` in a local console.
- **401 or 403** — Miro rejected the token or the token lacks the required
  board, organization, Enterprise, or OAuth scope.
- **429** — back off and preserve cursor or request ids for idempotent
  retries.

---

## trello

Inspect Trello boards, lists, and cards; create or move tasks; and manage
Kanban workflows through the Trello REST API.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Trello API key | Authentication | Get from `https://trello.com/app-key` |
| Trello token | Authorization | Generate via the link on the API key page |

Export as `TRELLO_API_KEY` and `TRELLO_TOKEN` environment variables.

> 💡 **Tips & Tricks**
>
> Always resolve board and list IDs before creating or moving cards.
>
> Use `jq` for readable API output.
>
> Confirm before archival or bulk moves.

> 🎯 **Try it yourself**
>
> `Show me all cards on the "Sprint 12" board`
>
> `Create a card "Fix login bug" in the "To Do" list on the Engineering board`
>
> `Add a comment to the "API redesign" card with today's progress update`
>
> `List all cards on the "Sprint 14" board, move any cards in "Done" to "Archive", and create a summary card in "To Do" listing unfinished items carried over to the next sprint`
>
> **Conversation flow:**
>
> `1. Show me all cards on the Engineering board grouped by list`
> `2. Create 3 new cards in "To Do": "Set up CI pipeline", "Write API integration tests", and "Update deployment docs"`
> `3. Move "Set up CI pipeline" to "In Progress" and add a comment saying "Started — targeting end of week"`

**Troubleshooting**

- **401 Unauthorized** — regenerate your token; Trello tokens can expire.
- **Board not found** — list boards first to get the correct board ID.
