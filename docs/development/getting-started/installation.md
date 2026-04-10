---
title: Installation
description: Prerequisites and install flows for npm users and source checkouts.
sidebar_position: 2
---

# Installation

## Install From npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

Prerequisites:

- Node.js 22
- npm
- Docker when you want the default container sandbox

The published package installs the packaged container runtime dependencies
automatically during `npm install -g`.

## Install From a Source Checkout

Use this flow when you are developing HybridClaw locally or want to run from
the repo:

```bash
npm install
npm run setup
```

Optional validation and build steps:

```bash
npm run build
npm run typecheck
npm run test:unit
```

`npm run setup` installs the container package dependencies used by the default
sandbox image build and related local workflows.

## After Installation

Next steps:

1. Run [Authentication](./authentication.md) if you have not onboarded yet.
2. Follow [Quick Start](./quickstart.md) to launch the gateway and surfaces.
3. Follow [Channel Setup](./channels.md) if you plan to connect Discord,
   Telegram, email, WhatsApp, iMessage, or Microsoft Teams.
