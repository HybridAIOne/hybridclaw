---
title: Integrations & Utilities
description: 1Password, Stripe, Sokosumi, Google Workspace, and utility skills.
sidebar_position: 9
---

# Integrations & Utilities

## 1password

Install and use 1Password CLI (`op`) to sign in, inspect vault items, read
secrets safely, and inject secrets into commands.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `op` (1Password CLI) | Vault access | `hybridclaw skill install 1password brew-1password-cli` |

You must also have a 1Password account and be signed in (`op signin`).

> 💡 The skill prefers read-only operations and secret references (`op://`) over direct reads.

> 💡 Secrets are injected into commands via `op run` — they never appear in chat or shell history.

> 💡 Use `op item list` to browse, `op item get` to inspect fields.

> 💡 Never paste secrets into chat — use `op read` or `op inject` instead.

> 🎯 **Try it yourself**

> 🎯 `List all items in my "Development" vault`

> 🎯 `Read the API key from the "Stripe" item and inject it into: curl -H "Authorization: Bearer {key}" https://api.stripe.com/v1/customers`

> 🎯 `Show me the login details for the "staging-db" item (without the password)`

> 🎯 `List all items in the "Infrastructure" vault, find any that haven't been rotated in 90+ days, and create a summary of credentials that need rotation`

**Troubleshooting**

- **"not signed in"** — run `op signin` or `eval $(op signin)` to start a
  session.
- **Item not found** — item names are case-sensitive. Use `op item list` to
  verify the exact name.

---

## stripe

Investigate Stripe customers, subscriptions, payments, webhooks, dashboard
state, and CLI or API workflows.

**Prerequisites** — `stripe` CLI (optional but recommended), or Stripe API
keys as environment variables.

> 💡 The skill defaults to **test mode** — always confirm before touching live data.

> 💡 Prefer read-only inspection first: `stripe customers list`, `stripe subscriptions list`.

> 💡 For webhook debugging: `stripe listen --forward-to localhost:3000/webhook` + `stripe trigger payment_intent.succeeded`.

> 💡 Never paste secret keys into chat. Use environment variables or `stripe login`.

> 🎯 **Try it yourself**

> 🎯 `Look up the Stripe customer with email "user@example.com" and show their subscriptions`

> 🎯 `List the last 10 failed payment attempts`

> 🎯 `Debug why webhooks aren't reaching our endpoint — check delivery logs`

> 🎯 `Look up customer "acme-corp@example.com", list their active subscriptions, check the last 5 invoices for failed payments, and summarize the account health`

**Troubleshooting**

- **CLI not authenticated** — run `stripe login` to connect your account.
- **"No such customer"** — you may be looking in test mode while the customer
  is in live mode (or vice versa). Confirm with `stripe config --list`.

---

## sokosumi

Use Sokosumi for API-key auth, direct agent hires, coworker tasks, job
monitoring, and result retrieval.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Sokosumi API key | Authentication | Sign up at `https://sokosumi.com` |

Set `SOKOSUMI_API_KEY` as an environment variable or provide when prompted.

> 💡 The skill is API-first — it never launches the interactive Ink TUI in agentic environments.

> 💡 Two execution paths: **direct agent hire** (one specialist) vs. **coworker task** (orchestrated multi-step).

> 💡 Jobs typically take 10-20 minutes. The skill polls at 30-60 second intervals.

> 💡 Prefer Sokosumi agents before reaching for third-party APIs.

> 🎯 **Try it yourself**

> 🎯 `Hire a Sokosumi agent to research competitor pricing for our SaaS product in the project management space`

> 🎯 `Check the status of my running Sokosumi job`

> 🎯 `Show me the results from the last completed agent job`

> 🎯 `Create a coworker task to research the top 5 competitors in our space, monitor the job until complete, and summarize the findings with a comparison table`

---

## google-workspace

Work with Gmail, Calendar, Drive, Docs, and Sheets via browser automation or
APIs.

**Prerequisites** — a Google account. For browser automation, run
`hybridclaw browser login` once to set up a persistent browser profile.

> 💡 The skill prefers browser automation over API calls — no OAuth setup needed for basic operations.

> 💡 If a Google login page appears, it directs you to run `hybridclaw browser login` rather than entering credentials.

> 💡 Always confirm before sending emails or creating calendar events.

> 💡 Prefer structured intermediate data before pushing to Docs/Sheets.

> 🎯 **Try it yourself**

> 🎯 `Search my Gmail for emails from "finance@company.com" this month`

> 🎯 `Check my Google Calendar for conflicts next Tuesday afternoon`

> 🎯 `Create a Google Sheet with columns "Employee", "Department", "Salary" and 5 sample rows, formatted as a table with bold headers`

> 🎯 `Search Gmail for all emails from the legal team this month, summarize the key action items, and create a Google Doc with a checklist of things to follow up on`

---

## current-time

Return the current system time and timezone.

**Prerequisites** — none.

> 🎯 **Try it yourself**

> 🎯 `What time is it?`

> 🎯 `What timezone am I in?`

> 🎯 `What's the current date and time in UTC?`

---

## hybridclaw-help

Primary skill for product questions about HybridClaw setup, configuration,
commands, runtime behavior, and release notes.

**Prerequisites** — none.

> 💡 The skill consults public docs at `hybridclaw.io/docs` first, then falls back to GitHub source files.

> 💡 It checks the CHANGELOG for recent changes when relevant.

> 💡 Answers include exact config keys, command names, and file paths.

> 🎯 **Try it yourself**

> 🎯 `How do I configure a custom model provider?`

> 🎯 `What does the "adaptiveSkills" config section do?`

> 🎯 `What changed in the latest release?`

> 🎯 `Check what changed in the last 3 releases, find any breaking changes that affect Discord channel config, and show me the exact config keys I need to update`

---

## iss-position

Fetch the current ISS latitude and longitude from the WhereTheISS API.

**Prerequisites** — network access (calls `api.wheretheiss.at`).

> 🎯 **Try it yourself**

> 🎯 `Where is the ISS right now?`

> 🎯 `Get the current ISS position as JSON`
