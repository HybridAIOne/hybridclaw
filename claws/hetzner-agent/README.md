# Hetzner Agent (`.claw` package source)

A ready-to-run HybridClaw agent that operates **Hetzner Cloud servers, DNS zones,
and Storage Boxes** from chat. This directory is the unpacked `.claw` source —
`pack.sh` zips it (bundling the three Hetzner skills) into an installable
`hetzner-agent.claw`.

On first session start the agent fires a proactive greeting (driven by
`workspace/OPENING.md`) that introduces itself, suggests example prompts drawn
from the skill docs, and walks the user through the one-time API-token setup.

## Layout

```
manifest.json                 # formatVersion 1; presentation + bundled-skill manifest
workspace/
  OPENING.md                  # proactive first message (greeting + example prompts + token setup)
  IDENTITY.md                 # name, role, avatar
  assets/hetzner.png          # logo -> presentation.imageAsset
skills/                       # added by pack.sh from ../../skills:
  hetzner-cloud/              #   servers, types, locations, volumes, networks, snapshots, cost
  hetzner-dns/                #   zones + A/AAAA/CNAME/TXT records
  hetzner-storage-box/        #   storage boxes, snapshots, WebDAV files
```

The skill tutorials/docs travel with the skills (e.g.
`skills/hetzner-cloud/references/operator-setup.md`), so they are bundled
automatically — no separate docs section is needed.

## Pack

```bash
./pack.sh            # -> ./hetzner-agent.claw
```

## Install

```bash
hybridclaw agent inspect ./hetzner-agent.claw
hybridclaw agent install ./hetzner-agent.claw --id hetzner-agent --activate
```

## Credentials (one-time, never pasted into chat)

```bash
hybridclaw secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"   # Cloud + Storage Box
hybridclaw secret set HETZNER_DNS_API_TOKEN "<hetzner-dns-api-token>"   # DNS (separate API)
```

Use read-only scope for inventory and cost; use read-write only for a bounded
change window. See `skills/hetzner-cloud/references/operator-setup.md`.
