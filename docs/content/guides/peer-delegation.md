---
title: Peer Delegation (Hierarchical Swarm)
description: Let one HybridClaw instance delegate tasks to another over HTTP — agency HQ → per-client instances, or peer-to-peer fan-out.
sidebar_position: 12
---

# Peer Delegation (Hierarchical Swarm)

Two HybridClaw instances can pass tasks to each other over HTTP. The dispatching
agent calls the `delegate_to_peer` tool, the gateway forwards the request to a
configured peer with a bearer token, and the peer runs the task and returns the
result synchronously. This unlocks agency / multi-tenant topologies where an
agency HQ instance fans out work to per-client instances that hold the client's
own credentials, files, and audit log.

## Trust model

There is no central registry. Each instance maintains:

- **`outbound`** — peers it is allowed to call, with the bearer token to
  present. Tokens are stored on the dispatching side only.
- **`inboundTokens`** — bearer tokens accepted on `/api/peer/delegate`. Each
  token has a local label that is recorded in the audit log when a request
  arrives.

If both lists are empty (or `enabled: false`), no peer traffic is accepted or
dispatched.

The receiving instance runs the requested agent in its own sandbox, with its
own approval policy, mount allowlist, and audit chain. **Approvals do not flow
back across the boundary** in this iteration: if the peer would need an
approval, it returns a `pendingApprovalSummary` and the dispatching agent
surfaces it to its operator instead.

## Configuration

Add a `peers` section to `~/.hybridclaw/config.json` on each instance.

### HQ (dispatching) instance

```json
{
  "peers": {
    "enabled": true,
    "instanceId": "hq-main",
    "instanceName": "Agency HQ",
    "outbound": [
      {
        "id": "client-acme",
        "baseUrl": "https://acme.hc.example/",
        "token": "<bearer the client instance accepts>",
        "description": "ACME client tenant",
        "allowedAgentIds": ["client-main"],
        "timeoutMs": 60000
      }
    ],
    "inboundTokens": [],
    "defaultOutboundTimeoutMs": 60000,
    "inboundMaxConcurrent": 4
  }
}
```

### Client (receiving) instance

```json
{
  "peers": {
    "enabled": true,
    "instanceId": "client-acme",
    "instanceName": "ACME Client Workspace",
    "outbound": [],
    "inboundTokens": [
      {
        "id": "hq-main",
        "token": "<same bearer the HQ outbound entry sends>",
        "allowedAgentIds": ["client-main"]
      }
    ]
  }
}
```

The `id` on the receiving side is purely a label for audit and does not need to
match the dispatcher's `instanceId`.

## Endpoints

Three HTTP endpoints are exposed by every peer-enabled gateway:

| Method | Path                                   | Auth                       | Purpose                                                |
|--------|----------------------------------------|----------------------------|--------------------------------------------------------|
| GET    | `/.well-known/hybridclaw-peer.json`    | none (public)              | Agent card: instance id, name, exposed agents, version |
| POST   | `/api/peer/delegate`                   | bearer in `inboundTokens`  | Run a delegated task and return the result             |
| POST   | `/api/peer/proxy`                      | gateway API token          | Container-side: forward a `delegate_to_peer` call      |

The agent card lets you confirm a peer is reachable without sharing tokens:

```bash
curl https://acme.hc.example/.well-known/hybridclaw-peer.json
```

## Using `delegate_to_peer` from an agent

Once peers are configured, the orchestrator agent can dispatch a task with the
`delegate_to_peer` tool:

```json
{
  "peerId": "client-acme",
  "agentId": "client-main",
  "content": "Summarize this week's invoices and flag anything over $5,000.\n\nWorkspace: /workspace/acme/invoices/2026-W17/\nReturn a markdown table."
}
```

The tool returns synchronously with the peer's final answer. The brief must be
**self-contained** — the peer has none of the local session's context, files,
or memory.

## Audit linkage

Both ends of a peer call are recorded in `wire.jsonl`:

- Dispatching side writes `peer.delegate.sent` and `peer.delegate.acknowledged`
  events with `taskId`, `peerId`, and the peer's returned `peerInstanceId` /
  `peerRunId`.
- Receiving side writes `peer.delegate.received` and `peer.delegate.completed`
  with the inbound peer's local id and the caller's `parentRunId` /
  `parentSessionId` for forensic correlation.

There is no shared hash chain; each instance retains its own integrity. The
`taskId` and `parentRunId` fields are what tie the two halves together when
you replay an incident.

## Limits and caveats

- **Synchronous only**: the dispatcher waits for the peer to finish (capped by
  `timeoutMs`). For very long tasks consider running them on the peer side
  via the scheduler and pulling results separately.
- **No approval forwarding**: when peer-side work would need an approval, the
  receiver returns `status: "rejected"` with the prompt in
  `pendingApprovalSummary` (instead of forwarding the prompt over the wire).
  The `delegate_to_peer` tool surfaces this as a failure on the dispatcher so
  the dispatching agent escalates to its own operator; the approval still has
  to be completed on the peer side before the call can succeed on retry.
- **No nested peer hops by default**: peer-delegated sub-agents run with the
  base sub-agent toolset (no `delegate_to_peer`) to prevent unbounded
  cross-instance fan-out.
- **TLS is on you**: there is no transport encryption built in. Put each peer
  behind HTTPS (Caddy, nginx, Tailscale + cert) before exchanging tokens.
