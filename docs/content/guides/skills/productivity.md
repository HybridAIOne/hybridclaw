---
title: Productivity Skills
description: Feature planning, project management, and Trello board integration.
sidebar_position: 6
---

# Productivity Skills

## feature-planning

Break features into implementation plans, acceptance criteria, and sequenced
tasks.

**Prerequisites** — none.

> 💡 The skill inspects current code paths, types, and tests before planning.

> 💡 Task definitions include exact file paths and verification commands.

> 💡 Risky/uncertain work is sequenced first to surface blockers early.

> 🎯 **Try it yourself**

> 🎯 `Plan the implementation of a user notification system with email and in-app channels`

> 🎯 `Break down the migration from REST to GraphQL into tasks with acceptance criteria`

> 🎯 `What's the safest sequence to refactor the auth middleware?`

> 🎯 `Analyze the current auth module in src/auth/, identify what needs to change for OAuth2 support, break it into sequenced tasks with acceptance criteria, and flag any risky dependencies`

---

## project-manager

Plan sprints, milestones, roadmaps, risks, dependencies, and stakeholder
updates for team delivery.

**Prerequisites** — none.

> 💡 Outputs include: implementation plans, milestone tables, risk registers, sprint plans, stakeholder updates, dependency maps.

> 💡 Estimates are always labeled as assumptions.

> 💡 Status updates are kept short and decision-oriented.

> 🎯 **Try it yourself**

> 🎯 `Create a 4-week sprint plan for the checkout redesign with milestones and exit criteria`

> 🎯 `Build a risk register for the database migration with impact, probability, and mitigation for each risk`

> 🎯 `Map the dependencies between the auth, billing, and notification workstreams`

> 🎯 `Review the current sprint board, identify items at risk of slipping, build an updated risk register, and draft a stakeholder update email summarizing progress and blockers`

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

> 💡 Always resolve board and list IDs before creating or moving cards.

> 💡 Use `jq` for readable API output.

> 💡 Confirm before archival or bulk moves.

> 🎯 **Try it yourself**

> 🎯 `Show me all cards on the "Sprint 12" board`

> 🎯 `Create a card "Fix login bug" in the "To Do" list on the Engineering board`

> 🎯 `Add a comment to the "API redesign" card with today's progress update`

> 🎯 `List all cards on the "Sprint 14" board, move any cards in "Done" to "Archive", and create a summary card in "To Do" listing unfinished items carried over to the next sprint`

**Troubleshooting**

- **401 Unauthorized** — regenerate your token; Trello tokens can expire.
- **Board not found** — list boards first to get the correct board ID.
