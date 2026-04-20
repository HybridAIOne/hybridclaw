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
