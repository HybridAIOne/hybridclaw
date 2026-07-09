---
title: Secret Threat Model
description: Threat model and PR checklist for features that touch credentials and other secrets.
sidebar_position: 7
---

# Threat Model For Features Touching Secrets

HybridClaw treats credentials as a user-owned boundary. Features that read,
store, transform, inject, display, or delete secrets must preserve Manifesto
Principle V: a trusted coworker never holds your keys.

This document is the shared review baseline for credential work, including
issues #4, #6, and future features that touch tokens, API keys, cookies, OAuth
flows, service accounts, or private configuration.

## Review Triggers

Use this threat model when a change touches any of these surfaces:

- runtime secret storage, lookup, migration, rotation, deletion, or backup
- provider credentials, OAuth access or refresh tokens, service-account keys, or
  channel bot tokens
- HTTP request helpers that inject bearer tokens, API keys, cookies, basic auth,
  signed URLs, or webhook secrets
- prompt, transcript, audit, telemetry, debug, crash, or support-log paths that
  may contain sensitive values
- browser authentication flows, password managers, session cookies, or local
  profile state
- workspace bootstrap files, templates, examples, docs, or tests that mention
  credential handling

If a change is plausibly secret-adjacent, apply the checklist and document why
the feature is out of scope if no mitigation is needed.

## Secret Classes

| Class | Examples | Required posture |
| --- | --- | --- |
| Long-lived user credentials | API keys, bot tokens, personal access tokens, SMTP passwords | Store only in the runtime secret store or user-approved external store. Never copy into prompts, memory, docs examples, or general workspace files. |
| OAuth material | access tokens, refresh tokens, authorization codes, device codes | Keep tokens scoped to the provider, account, host, and requested operation. Treat refresh tokens as high impact and avoid exposing them to model/tool output. |
| Service-account credentials | private keys, client secrets, delegated-user subjects | Split and bind fields where possible. Inject only into the approved exchange path and avoid logging upstream error bodies that may echo inputs. |
| Session credentials | cookies, browser profiles, magic links, signed URLs | Treat as bearer credentials. Bind to the target origin, expire aggressively, and avoid reuse outside the explicit user-directed flow. |
| Webhook and channel secrets | Discord, Slack, LINE, Telegram, email, voice, webhook signing keys | Validate destination and caller identity before use. Redact from setup output and persisted channel configuration. |
| Derived or captured secrets | response fields captured into secret storage, exchanged access tokens, temporary bearer tokens | Mark source and sink, bind to the host or provider that produced them, and scan output for accidental disclosure. |
| Local secret-bearing files | `.env`, cloud config, SSH keys, npm tokens, credentials JSON, browser profiles | Keep outside mounted workspaces by default. Require explicit approval for reads or writes and redact path-sensitive output. |
| Sensitive non-secret data | NDA data, customer data, personal identifiers, internal business records | Apply confidential-info filtering where configured. Do not downgrade this class into ordinary context just because it is not a token. |

## Assets And Boundaries

- The user owns all credentials. HybridClaw may broker access, but it should not
  make credentials visible to the model unless there is no safer structured API.
- The gateway is the preferred place to resolve and inject secrets because it can
  enforce policy, bind sinks, audit access, and redact logs.
- Container tool execution receives only the minimum material required for the
  approved action. Workspace files, tool output, and model output are untrusted.
- Audit logs should prove that secret access happened without storing the secret
  value itself.
- Operator configuration is a security boundary. Do not silently broaden mounts,
  approval tiers, domains, or secret-name patterns.

## Attacker Scenarios

### Prompt Or Tool-Output Injection

An attacker places instructions in a repository file, web page, document, email,
or tool result that asks the agent to reveal credentials or move them to a new
location.

Mitigations:

- Treat file, web, and tool content as untrusted input.
- Keep secret values behind structured secret handles or gateway APIs.
- Require explicit approval for direct reads of secret-bearing files.
- Reject string coercion or serialization of secret references.

### Confused Deputy Secret Injection

A benign feature injects a bearer token or API key into an attacker-controlled
host because the destination URL, redirect, or captured token binding was not
validated.

Mitigations:

- Bind secrets to expected hosts, providers, accounts, and sink types.
- Validate redirects and final request URLs before injecting authorization.
- Deny unknown secret sinks by default.
- Store derived token bindings with the captured value.

### Credential Persistence Drift

A temporary token or pasted key is accidentally written to memory, transcripts,
templates, audit logs, crash reports, screenshots, or docs examples.

Mitigations:

- Redact secrets before persistence and before user-visible debug output.
- Use neutral placeholders in tests and docs.
- Keep temporary exchanges in process memory unless durable storage is required.
- Scan audit and transcript paths when adding new persistence.

### Overbroad Workspace Or Container Access

A feature mounts a directory that contains host credentials or makes a secret
file readable from container tools without a narrow reason.

Mitigations:

- Preserve deny-by-default mount allowlists and workspace fences.
- Avoid mounting home-directory credential paths into workspaces.
- Require red-tier approval for high-impact secret file access.
- Test rejected paths as well as allowed paths.

### Cross-Account Or Cross-Session Leakage

One user's token, memory, transcript, or channel session is reused for another
identity because session routing or credential lookup keys are too broad.

Mitigations:

- Scope credentials by provider, account, channel, peer identity, and workspace
  where the feature semantics require it.
- Keep direct-message continuity isolated unless the operator explicitly links
  identities.
- Reject malformed session keys at boundaries.
- Include multi-user and wrong-account tests for routing changes.

### Supply-Chain Or Runtime Compromise

Install-time scripts, third-party packages, browser extensions, MCP servers, or
external tools try to read or exfiltrate available credentials.

Mitigations:

- Keep npm supply-chain controls and lockfile review intact.
- Do not add git, tarball, or non-registry dependencies for secret work without
  explicit security review.
- Prefer least-privilege tokens and short-lived credentials.
- Limit environment variables available to child processes and containers.

### Support, Telemetry, And Observability Exposure

Logs, OpenTelemetry attributes, exception messages, or diagnostics include raw
credentials, authorization headers, cookies, URLs with secret query parameters,
or provider error bodies.

Mitigations:

- Redact before logging, tracing, or returning diagnostics.
- Record secret identifiers, source, sink, and decision metadata instead of
  values.
- Treat upstream error bodies as sensitive if the request included credentials.
- Add tests for log and error redaction when changing observability paths.

## Model-Leakage Paths

Secrets can reach a model through more than explicit prompt text. Review these
paths before merging credential-adjacent work:

- user messages that paste keys, recovery codes, magic links, or `.env` content
- tool output from shell commands, HTTP responses, browser automation, logs, or
  file reads
- serialized tool arguments or results that contain authorization headers,
  cookies, signed URLs, or secret placeholders expanded too early
- memory, session summaries, compaction payloads, and transcript replay
- audit, debug, trace, crash, and CI output copied into prompts for diagnosis
- document, spreadsheet, image, or browser screenshots that visually reveal
  secret material
- test fixtures, examples, docs snippets, and generated PR descriptions

Preferred controls:

- pass stable secret references or handles instead of raw values
- resolve and inject secrets at the gateway boundary closest to the destination
- redact before prompting, summarizing, compacting, persisting, or displaying
- keep model-facing error messages generic when a credential was involved
- add regression tests for the exact leak path the change creates or modifies

## Required Mitigations

Credential-adjacent features must answer these questions in design notes, PR
description, tests, or code comments close to the boundary:

1. What secret classes can enter this code path?
2. Who or what can trigger the path?
3. What host, provider, account, session, and workspace is each secret bound to?
4. Can untrusted model, file, web, or tool output influence the destination?
5. Where can the value be persisted, logged, traced, displayed, or summarized?
6. How does the user approve or revoke access?
7. What happens when validation fails?

Baseline controls:

- use least privilege and shortest practical lifetime
- validate at system boundaries and fail closed
- keep secrets out of model-visible text wherever a structured API can do the job
- redact by default in logs, traces, audit records, errors, and UI text
- preserve hash-chain audit integrity without storing secret values
- bind captured or derived secrets to their origin and intended sink
- include negative tests for denied hosts, invalid secret names, and redaction
- document any deliberate exception and its operator-facing risk

## PR Checklist

For PRs labeled `security`, `auth`, `credentials`, `secrets`, `integrations`, or
for any PR that touches the review triggers above:

- [ ] Secret classes are identified, or the PR explains why none apply.
- [ ] Raw secret values stay out of prompts, memory, transcripts, audit logs,
      telemetry, screenshots, docs examples, and tests.
- [ ] Secret resolution happens at the narrowest boundary and is bound to the
      intended host, provider, account, session, or workspace.
- [ ] Untrusted model, file, web, and tool output cannot redirect secrets to a
      new sink without validation and approval.
- [ ] Failure modes deny access and avoid echoing credential-bearing request or
      response bodies.
- [ ] Tests cover both allowed behavior and at least one relevant denied or
      redacted path.
