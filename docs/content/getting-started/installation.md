---
title: Installation
description: Prerequisites and install flows for npm users and source checkouts.
sidebar_position: 2
---

# Installation

## Launch On HybridAI Cloud

The fastest managed path is the HybridAI Cloud offering for HybridClaw:

```text
https://hybridclaw.io
```

Use it when you want a hosted HybridClaw environment running in a few minutes
without preparing a local Node.js, npm, or Docker setup first.

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
  | bash -s -- --version 0.25.3 --no-onboarding
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
published SHA-256 checksum), and if the global npm prefix is not writable it
automatically switches npm to a user-writable prefix
(`~/.hybridclaw/npm-global`) rather than escalating. That fallback persists
`prefix=~/.hybridclaw/npm-global` in `~/.npmrc` so later global installs and
`hybridclaw update` keep working; undo it with `npm config delete prefix`
(nvm refuses to run while a prefix is set there).
Windows users should run it inside WSL2. On
Alpine or other musl-based distros, install Node 22 with your package manager
(`apk add nodejs npm`, which needs Alpine 3.21+ — older releases ship Node 20)
and pass `--skip-node`, since nodejs.org ships glibc
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
automatically during `npm install -g`. Installs that skip lifecycle scripts
(`npm install -g --ignore-scripts`, or pnpm, which blocks dependency scripts
by default) miss that step; complete it afterwards with:

```bash
# npm installs (pnpm: substitute "$(pnpm root -g)"):
node "$(npm root -g)/@hybridaione/hybridclaw/scripts/postinstall-container.mjs"
```

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

A Homebrew formula is drafted at [packaging/homebrew/hybridclaw.rb](https://github.com/HybridAIOne/hybridclaw/blob/main/packaging/homebrew/hybridclaw.rb).
It installs the published npm tarball (no local build) and will ship through
a dedicated tap (`hybridaione/hybridclaw`). Once the tap exists:

```bash
brew tap hybridaione/hybridclaw
brew install hybridclaw
```

Until then, most macOS users should stick to npm or the Nix flake.

## Install The Apple Desktop App

Signed and notarized macOS desktop builds are distributed as GitHub Release
assets. For the current Apple Silicon desktop build, use the latest release
page:

```text
https://github.com/HybridAIOne/hybridclaw/releases/latest
```

Open the DMG, drag `HybridClaw.app` into `/Applications`, and launch it. For
future desktop builds and architectures, use the latest release page:

```text
https://github.com/HybridAIOne/hybridclaw/releases/latest
```

The desktop app is a native wrapper around the same local gateway, chat, agents,
and admin surfaces. From a source checkout, use `npm run desktop` instead. For
maintainer packaging, signing, notarization, and upload steps, see
[Desktop Release Builds](../developer-guide/desktop-release.md).

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
