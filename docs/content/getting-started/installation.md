---
title: Installation
description: Prerequisites and install flows for npm users and source checkouts.
sidebar_position: 2
---

# Installation

## Install With the One-Line Script

The quickest path on Linux and macOS is the bootstrap installer. It ensures a
compatible Node.js 22 and npm, installs the `hybridclaw` CLI from npm, checks
for Docker, and offers to run onboarding:

```bash
curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash
```

Pass options through the pipe with `-s --`, for example to pin a version and
skip the interactive onboarding step:

```bash
curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh \
  | bash -s -- --version 0.21.0 --no-onboarding
```

For automation, preview the plan with `--dry-run` (changes nothing), run
headless with `--no-prompt`, and smoke-test the result with `--verify`
(`hybridclaw --version` plus `hybridclaw doctor`). Each flag also has an
environment-variable form (`HYBRIDCLAW_DRY_RUN=1`, `HYBRIDCLAW_NO_PROMPT=1`,
`HYBRIDCLAW_VERIFY_INSTALL=1`) for CI runners that cannot pass arguments
through the pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh \
  | bash -s -- --no-prompt --verify
```

The script never uses `sudo`: when no Node.js 22 is present it installs a
user-local copy under `~/.hybridclaw/node` (verified against nodejs.org's
published SHA-256 checksum), and it falls back to a user-writable npm prefix if
the global one is not writable. Windows users should run it inside WSL2. On
Alpine or other musl-based distros, install Node 22 with your package manager
(`apk add nodejs npm`) and pass `--skip-node`, since nodejs.org ships glibc
builds only. Review `scripts/install.sh` before piping it to a shell if you
prefer; the steps below cover each install method manually.

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
