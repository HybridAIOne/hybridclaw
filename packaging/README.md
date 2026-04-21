# Packaging

This directory holds distribution artefacts for HybridClaw that are not npm
tarballs or Docker images.

## Layout

- `homebrew/hybridclaw.rb` — Formula draft for the future
  `homebrew-hybridclaw` tap. See the comment block at the top of the file
  for publication steps.

## Nix flake

The Nix flake lives at the repository root (`flake.nix` + `nix/`). See
[docs/content/getting-started/installation.md](../docs/content/getting-started/installation.md)
for user-facing install docs and [nix/](../nix/) for the per-file notes:

- `nix/packages.nix` — HybridClaw package built with `buildNpmPackage`.
  Multi-arch: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`,
  `x86_64-darwin`.
- `nix/nixosModules.nix` — NixOS service module exposing
  `services.hybridclaw`.
- `nix/devShell.nix` — Contributor dev shell with Node 22, Biome, Python 3,
  ripgrep, git and Docker client.

## Updating the npm deps hash

Whenever `package-lock.json` (root) changes, the `npmDepsHash` in
`nix/packages.nix` needs to be refreshed. Run:

```bash
nix build .#hybridclaw --rebuild 2>&1 | tee /tmp/hybridclaw-build.log
# copy the "got: sha256-…" line into nix/packages.nix
```

Or let a future CI workflow do it automatically — see
`hermes-agent/nix/lib.nix` in the reference repo for the
`prefetch-npm-deps`-based auto-update pattern.
