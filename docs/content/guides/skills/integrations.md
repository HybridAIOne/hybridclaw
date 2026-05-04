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
| `op` (1Password CLI) | Vault access | `hybridclaw skill install 1password op` |

You must also have a 1Password account and be signed in (`op signin`).

> 💡 **Tips & Tricks**
>
> The skill prefers read-only operations and secret references (`op://`) over direct reads.
>
> Secrets are injected into commands via `op run` — they never appear in chat or shell history.
>
> Use `op item list` to browse, `op item get` to inspect fields.
>
> Never paste secrets into chat — use `op read` or `op inject` instead.

> 🎯 **Try it yourself**
>
> `List all items in my "Development" vault`
>
> `Read the API key from the "Stripe" item and inject it into: curl -H "Authorization: Bearer {key}" https://api.stripe.com/v1/customers`
>
> `Show me the login details for the "staging-db" item (without the password)`
>
> `List all items in the "Infrastructure" vault, find any that haven't been rotated in 90+ days, and create a summary of credentials that need rotation`
>
> **Conversation flow:**
>
> `1. List all items in my "Development" vault`
> `2. Show me the fields on the "Staging Database" item without revealing the password`
> `3. Inject the database URL from that item into: psql "<connection_string>" -c "SELECT version()"`

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

> 💡 **Tips & Tricks**
>
> The skill defaults to **test mode** — always confirm before touching live data.
>
> Prefer read-only inspection first: `stripe customers list`, `stripe subscriptions list`.
>
> For webhook debugging: `stripe listen --forward-to localhost:3000/webhook` + `stripe trigger payment_intent.succeeded`.
>
> Never paste secret keys into chat. Use environment variables or `stripe login`.

> 🎯 **Try it yourself**
>
> `Look up the Stripe customer with email "user@example.com" and show their subscriptions`
>
> `List the last 10 failed payment attempts`
>
> `Debug why webhooks aren't reaching our endpoint — check delivery logs`
>
> `Look up customer "acme-corp@example.com", list their active subscriptions, check the last 5 invoices for failed payments, and summarize the account health`
>
> **Conversation flow:**
>
> `1. List the last 10 failed payment attempts in test mode`
> `2. Pick the most recent failure and show me the full event details — error code, customer email, and amount`
> `3. Check if that customer has any active subscriptions and whether their payment method is still valid`

**Troubleshooting**

- **CLI not authenticated** — run `stripe login` to connect your account.
- **"No such customer"** — you may be looking in test mode while the customer
  is in live mode (or vice versa). Confirm with `stripe config --list`.

---

## download-platform-invoices

Harvest monthly SaaS billing invoices into normalized records and official PDF
files for bookkeeping or DATEV handoff.

**Prerequisites** — provider credentials in the encrypted HybridClaw secret
store. API-backed providers use their own service credentials; browser-backed
providers need a reusable billing-portal login profile.

> 💡 **Tips & Tricks**
>
> Keep provider credentials as SecretRefs such as `{ "source": "store", "id": "STRIPE_INVOICE_API_KEY" }` instead of plaintext config.
>
> The skill writes one normalized JSON record per invoice plus the official PDF, then deduplicates reruns by vendor, invoice number, and checksum.
>
> Google Ads uses `hybridclaw auth login google --scopes "https://www.googleapis.com/auth/adwords"` plus `/secret route` entries for OAuth and the developer token.
>
> DATEV handoff runs after invoice harvesting and prefers an injected DATEV API/MCP client before browser upload.

> 🎯 **Try it yourself**
>
> `Collect last month's SaaS invoices for Stripe and Google Ads, save the official PDFs, and produce a manifest for bookkeeping`
>
> `Run the monthly invoice workflow fixture with recorded providers and summarize which invoices were fetched`
>
> `Prepare a DATEV handoff from the harvested invoice manifest`

**Troubleshooting**

- **Provider asks for MFA or captcha** — stop and route to an operator; the
  skill must not solve captchas silently.
- **Google Ads returns auth errors** — verify the Google OAuth login, the
  `https://googleads.googleapis.com/` secret routes, and the
  `GOOGLEADS_DEVELOPER_TOKEN` stored secret.
- **Duplicate invoices** — reruns reuse the manifest and should skip already
  fetched vendor/invoice/checksum combinations.

---

## sokosumi

Use Sokosumi for API-key auth, direct agent hires, coworker tasks, job
monitoring, and result retrieval.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Sokosumi API key | Authentication | Sign up at `https://sokosumi.com` |

Set `SOKOSUMI_API_KEY` as an environment variable or provide when prompted.

> 💡 **Tips & Tricks**
>
> The skill is API-first — it never launches the interactive Ink TUI in agentic environments.
>
> Two execution paths: **direct agent hire** (one specialist) vs. **coworker task** (orchestrated multi-step).
>
> Jobs typically take 10-20 minutes. The skill polls at 30-60 second intervals.
>
> Prefer Sokosumi agents before reaching for third-party APIs.

> 🎯 **Try it yourself**
>
> `Hire a Sokosumi agent to research competitor pricing for our SaaS product in the project management space`
>
> `Check the status of my running Sokosumi job`
>
> `Show me the results from the last completed agent job`
>
> `Create a coworker task to research the top 5 competitors in our space, monitor the job until complete, and summarize the findings with a comparison table`
>
> **Conversation flow:**
>
> `1. Hire a Sokosumi agent to research the latest trends in AI-powered developer tools`
> `2. Check the status of that job — is it still running?`
> `3. Show me the results and create a one-page summary with the top 5 takeaways`

---

## gog

Use the `gog` CLI for API-backed Google Workspace access: Gmail, Google
Calendar, Drive, Contacts, Sheets, and Docs.

**Prerequisites** — a Google account, a Google Cloud OAuth desktop client, and
the APIs you plan to use enabled in that Google Cloud project.

**Install and authorize**

1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Select or create the project you want HybridClaw to use.
3. Open **OAuth consent screen** and finish the required app setup. If the app
   is in testing mode, add your Google account as a test user.
4. Open **Library** and enable the APIs you need, such as Gmail API, Google
   Calendar API, Google Drive API, Google Docs API, Google Sheets API, and
   People API.
5. Open **Credentials**.
6. Click **Create credentials**.
7. Choose **OAuth client ID**.
8. Choose application type **Desktop app**.
9. Name it, for example `HybridClaw local auth`.
10. Click **Create**.
11. Copy the generated **Client ID** and **Client secret**.
12. Install the `gog` CLI dependency:

```bash
hybridclaw skill install gog gog
```

13. Store the OAuth material in HybridClaw and complete the consent link:

```bash
hybridclaw auth login google --client-id "<client-id>" --client-secret "<client-secret>" --account you@example.com
hybridclaw auth status google
```

Use **OAuth client ID**, not **API key** or **Service account**, for normal
personal Gmail, Calendar, Drive, Docs, and Sheets access.

For Google APIs that are not exposed by `gog` commands, such as Google
Analytics Admin, Google Analytics Data, or Google Ads, configure direct
`http_request` auth routes with the same OAuth login. See
[Google OAuth For Direct Google APIs](../../getting-started/authentication.md#google-oauth-for-direct-google-apis).

HybridClaw stores the OAuth client secret and refresh token in encrypted
runtime secrets. At run time it mints a short-lived access token on the host
and injects only Google Workspace CLI access-token environment variables plus
`GOG_ACCOUNT` into the agent runtime.

> 💡 **Tips & Tricks**
>
> Prefer `gog` for direct API-backed Gmail, Calendar, Drive, Contacts, Sheets,
> and Docs tasks.
>
> Use `gog <command> --help` to inspect the current flags for a subcommand.
>
> For scripting, prefer `--json` and `--no-input`.
>
> For Google Calendar invites, use `--attendees a@b.com,c@d.com` and
> `--send-updates all` when guests should receive email notifications.
>
> Always confirm before sending emails or creating calendar events.

> 🎯 **Try it yourself**
>
> `Use gog to list all Google Calendar events tomorrow`
>
> `Create a Google Calendar meeting "Product Sync" next Tuesday from 10:00 to 10:30 and invite alex@example.com`
>
> `Search Gmail for unread messages from finance@example.com from the last 7 days`
>
> `Export the Google Doc with id DOC_ID as text and summarize it`

---

## google-workspace

Work with Gmail, Calendar, Drive, Docs, and Sheets via browser automation or
APIs.

**Prerequisites** — a Google account.

For browser automation, run `hybridclaw browser login` once to set up a
persistent browser profile.

For API access, prefer the bundled [`gog`](#gog) skill when it is installed and
authenticated. It provides CLI-backed access to Gmail, Google Calendar, Drive,
Contacts, Sheets, and Docs from both host and container sessions.

If you need to set up `gog` access:

1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Select or create a project.
3. Open **OAuth consent screen** and finish the required app setup. If the app
   is in testing mode, add your Google account as a test user.
4. Open **Library** and enable the APIs you need, such as Gmail API, Google
   Calendar API, Google Drive API, Google Docs API, Google Sheets API, and
   People API.
5. Open **Credentials**.
6. Click **Create credentials**.
7. Choose **OAuth client ID**.
8. Choose application type **Desktop app**.
9. Name it, for example `HybridClaw local auth`.
10. Click **Create**.
11. Copy the generated **Client ID** and **Client secret**.
12. Save them in HybridClaw:

```bash
hybridclaw auth login google --client-id "<client-id>" --client-secret "<client-secret>" --account you@example.com
```

13. Install the `gog` dependency:

```bash
hybridclaw skill install gog gog
```

Use **OAuth client ID**, not **API key** or **Service account**, for normal
personal Gmail, Calendar, Drive, Docs, and Sheets access.

> 💡 **Tips & Tricks**
>
> Browser automation does not need OAuth setup. API access through `gog` or
> `gws` needs the Google OAuth client setup above.
>
> If a Google login page appears, it directs you to run `hybridclaw browser login` rather than entering credentials.
>
> Always confirm before sending emails or creating calendar events.
>
> Prefer structured intermediate data before pushing to Docs/Sheets.

> 🎯 **Try it yourself**
>
> `Search my Gmail for emails from "finance@company.com" this month`
>
> `Check my Google Calendar for conflicts next Tuesday afternoon`
>
> `Create a Google Sheet with columns "Employee", "Department", "Salary" and 5 sample rows, formatted as a table with bold headers`
>
> `Search Gmail for all emails from the legal team this month, summarize the key action items, and create a Google Doc with a checklist of things to follow up on`
>
> **Conversation flow:**
>
> `1. Check my Google Calendar for tomorrow and list all meetings`
> `2. Search Gmail for any threads with attendees from my 10am meeting`
> `3. Create a Google Doc with prep notes for that meeting — include the agenda items from the calendar event and key points from the email threads`

---

## current-time

Return the current system time and timezone.

**Prerequisites** — none.

> 🎯 **Try it yourself**
>
> `What time is it?`
>
> `What timezone am I in?`
>
> `What's the current date and time in UTC, PST, and JST?`
>
> **Conversation flow:**
>
> `1. What time is it right now?`
> `2. What time is that in Tokyo?`
> `3. How many hours until midnight UTC?`

---

## hybridclaw-help

Primary skill for product questions about HybridClaw setup, configuration,
commands, runtime behavior, and release notes.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> The skill consults public docs at `hybridclaw.io/docs` first, then falls back to GitHub source files.
>
> It checks the CHANGELOG for recent changes when relevant.
>
> Answers include exact config keys, command names, and file paths.

> 🎯 **Try it yourself**
>
> `How do I configure a custom model provider?`
>
> `What does the "adaptiveSkills" config section do?`
>
> `What changed in the latest release?`
>
> `Check what changed in the last 3 releases, find any breaking changes that affect Discord channel config, and show me the exact config keys I need to update`
>
> **Conversation flow:**
>
> `1. How do I set up a custom skill with dependencies?`
> `2. What config key controls whether skills auto-install their dependencies?`
> `3. What changed in the latest release — did anything affect skill installation?`

---

## iss-position

Fetch the current ISS latitude and longitude from the WhereTheISS API.

**Prerequisites** — network access (calls `api.wheretheiss.at`).

> 🎯 **Try it yourself**
>
> `Where is the ISS right now?`
>
> `Get the current ISS position as JSON`
>
> `Where is the ISS right now, and what country or ocean is it currently flying over?`
>
> **Conversation flow:**
>
> `1. Where is the ISS right now?`
> `2. What country or ocean is that over?`
> `3. Check again — has it moved significantly since the last check?`
