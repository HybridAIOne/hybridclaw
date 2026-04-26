---
title: The Trusted Coworker Manifesto
description: The product principles HybridClaw is built around — what we will and will not ship.
sidebar_position: 2
---

# The Trusted Coworker Manifesto

*HybridClaw is not an AI assistant. It is the coworker your team trusts with keys, clients, and calendar.*

That belief steers every line of code we write — and every line we refuse to write.

---

### I. A coworker is a person, not a prompt
Our coworkers ship with a name, a face, a voice, and a `CV.md`. They have skill scores, a track record, references. You don't *configure* them — you onboard them, evaluate them, promote them, retire them.
**We will never ship a generic chatbot panel.** If a user can't picture saying *"Lena, take care of this,"* we haven't done our job.

### II. A coworker lives where work happens
Email. Web chat. Slack. Teams. WhatsApp. The phone. Your CRM. We meet your team in the tools they already pay for — never the other way around.

Apps are for the *operator*, not the user: one-click deployment, one place to manage the fleet. It's how you hire your coworker — not where you talk to them.
**We will never make end users open our app to talk to their coworker.**

### III. A coworker is hired, not installed
Sixty seconds, from a browser, from anywhere. The central admin is remote-first: fleet dashboard, kanban board, channel wiring, evals — reachable from a phone on the train.
**We will not ship features that require a terminal to operate.**

### IV. Coworkers work in teams
Real work is collaborative. Coworkers delegate, hand off, escalate, ask for help. Agent-to-agent communication is a first-class primitive, not a hack on top.
**We will not optimize for the lone-agent scenario at the cost of the team scenario.**

### V. A trusted coworker never holds your keys
Credentials are encrypted at rest. The model only ever sees a placeholder; the host injects real tokens at request time, then forgets them. PII and business secrets are masked on the way in and validated on the way out — your coworker is under NDA from minute one.
**We will never ship a feature that requires the model to see a real secret.** Convenience is not a justification.

### VI. A trusted coworker shows their work
Every action is appended to a hash-chain audit log. *"What did Lena do this week?"* gets an answer your auditor, your client, and your accountant will accept.
**We will not add features that bypass the audit log to look faster.**

### VII. A trusted coworker is undoable
Configs, agent files, skills, knowledge — all versioned. Rollback is one click. The cost of a bad change is a click, not a week.
**We will not ship state-mutating features without a rollback path.**

### VIII. A trusted coworker doesn't break overnight
When a new model ships, we re-run your tuned skills and knowledge against your real workflows. Regressions land in our dashboard, not your client's inbox.
**We will not let provider churn become customer churn.**

### IX. A coworker thinks before they spend
Concierge routing picks the model by urgency and complexity — not by default. Sensitive work stays local. Premium reasoning happens only when the work is worth it.
**We will not bill our customers for thinking harder than the task required.**

### X. A coworker actually does the work
Opinionated, ready-on-day-one skills for the systems your business runs on: Salesforce, HubSpot, SAP, GA4, plus natural-language SQL on your warehouse. Not a "build your own" toolkit.
**We will not ship a runtime and call it a coworker.** The skills are the product.

---

*All of the Claw. None of the chaos.*
