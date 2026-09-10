---
title: HybridAI Destination Contract
description: Client protocol for binding a model offer to an advertised processing destination.
---

# HybridAI Destination Contract

Phase 1 introduces a client-side destination protocol. It requires a matching
HybridAI server implementation before an offer can be treated as contracted.
Protocol acknowledgement verifies agreement with the server; it does not
independently verify the operator's hosting or retention claims.

Discovery at `/models` or `/v1/models` can advertise:

```json
{
  "id": "example-eu-model",
  "zone": "region",
  "destination": {
    "protocol": "hybridai-destination-v1",
    "id": "example-eu",
    "zone": "region",
    "operator": "Example operator",
    "region": "EU",
    "retention": "none",
    "fallback": "deny",
    "apiBaseUrl": "https://api.example.com"
  }
}
```

Zones are `hai` for approved self-hosted GPUs, `region` for EU offers, and
`cloud` for global offers. The native service owns `local`. This contract uses
`region: "EU"` for the requested EU layer. An EU model brand alone does not
establish an EU processing destination. The API base URL must exactly match
the discovery origin/base path after trailing-slash normalization.

For an exact contracted catalog ID, the client sends:

```text
X-HybridAI-Destination-Protocol: hybridai-destination-v1
X-HybridAI-Destination-ID: example-eu
X-HybridAI-Destination-Zone: region
X-HybridAI-Destination-Fallback: deny
```

The backend must bind those constraints **before processing the payload**, reject
an unavailable destination, prohibit downstream fallback, and echo the four
headers on successful responses, including SSE. The client refuses redirects
and rejects a missing or changed acknowledgement. Rejection after a response
cannot undo disclosure; correct server-side enforcement is a prerequisite.
Discovery failures or withdrawn contracts cannot turn an already-contracted
model into an unbound request within the running gateway.

Legacy discovery `zone` fields remain available as display/routing metadata;
they are not upgraded into a verified contract. Phase 2 must require the
appropriate contract and policy at all sensitive egress paths, including
fallbacks and auxiliary work. A gateway restart does not substitute for durable
operator policy or backend assurance.

Gateway and container transports share `container/shared/hybridai-destination.js`.
Tests cover strict metadata validation, exact IDs, origin mismatch, discovery
failure and response acknowledgement. No deployed HybridAI backend was changed
or certified by this repository change.
