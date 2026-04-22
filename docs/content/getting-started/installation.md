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

## Install From Nix (Flake)

HybridClaw ships a multi-arch Nix flake (`x86_64-linux`, `aarch64-linux`,
`aarch64-darwin`, `x86_64-darwin`). With flakes enabled:

```bash
# Run without installing
nix run github:HybridAIOne/hybridclaw -- onboarding

# Install into your profile
nix profile install github:HybridAIOne/hybridclaw
```

The flake also exposes a NixOS module. In your system flake:

```nix
{
  inputs.hybridclaw.url = "github:HybridAIOne/hybridclaw";

  outputs = { self, nixpkgs, hybridclaw, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        hybridclaw.nixosModules.default
        {
          services.hybridclaw = {
            enable = true;
            openFirewall = true;
            settings = {
              gateway = { host = "127.0.0.1"; port = 9090; };
            };
            environmentFiles = [ "/run/secrets/hybridclaw.env" ];
          };
        }
      ];
    };
  };
}
```

The module provisions a system user, runs the gateway under systemd, points
`HYBRIDCLAW_HOME` at `/var/lib/hybridclaw/.hybridclaw`, and enables Docker
so the default container sandbox works out of the box.

## Install From Homebrew (Preview)

A Homebrew formula is drafted at [packaging/homebrew/hybridclaw.rb](https://github.com/HybridAIOne/hybridclaw/blob/main/packaging/homebrew/hybridclaw.rb)
and will ship through a dedicated tap (`hybridaione/hybridclaw`) once the
first signed release tarball is published. The formula is currently
**HEAD-only** — the stable `brew install hybridclaw` command will fail
until a release artifact and its checksum are published.

In the meantime, early adopters can build from `main`:

```bash
brew install --HEAD hybridaione/hybridclaw/hybridclaw
```

Most macOS users should stick to npm or the Nix flake for now.

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
3. Follow [Connect Your First Channel](./first-channel.md) to pick one
   transport and verify the first successful setup.
