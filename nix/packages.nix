# nix/packages.nix — HybridClaw package built with buildNpmPackage
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      packageJson = builtins.fromJSON (builtins.readFile ../package.json);

      # Keep the source tree lean — strip the heavy stuff so every edit
      # doesn't rebuild the world.
      src = pkgs.lib.cleanSourceWith {
        src = ../.;
        filter =
          path: type:
          let
            rel = pkgs.lib.removePrefix (toString ../. + "/") (toString path);
          in
          !(
            pkgs.lib.hasInfix "/node_modules/" rel
            || pkgs.lib.hasPrefix "node_modules/" rel
            || pkgs.lib.hasPrefix "dist/" rel
            || pkgs.lib.hasPrefix "console/dist/" rel
            || pkgs.lib.hasPrefix "container/dist/" rel
            || pkgs.lib.hasPrefix "container/node_modules/" rel
            || pkgs.lib.hasPrefix "console/node_modules/" rel
            || pkgs.lib.hasPrefix ".git/" rel
            || pkgs.lib.hasPrefix ".claude/" rel
            || pkgs.lib.hasPrefix "tests/" rel
            || pkgs.lib.hasSuffix ".test.ts" rel
            || pkgs.lib.hasInfix "/.cache/" rel
          );
      };

      # Runtime tools the hybridclaw CLI expects on PATH.
      # Docker is looked up dynamically at runtime (not baked in) because
      # the sandbox mode is configurable and some deployments run without it.
      runtimeDeps = with pkgs; [
        nodejs_22
        git
        ripgrep
        openssh
      ];

      runtimePath = pkgs.lib.makeBinPath runtimeDeps;

      hybridclaw = pkgs.buildNpmPackage {
        pname = "hybridclaw";
        version = packageJson.version;

        inherit src;

        # npmDepsHash covers every workspace in the root package-lock.json
        # (root + console + container). Update with:
        #   nix build .#hybridclaw --rebuild
        # and copy the "got:" hash into here.
        npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

        # Native modules (better-sqlite3, node-pty) compile from source when
        # no prebuild matches — the Nix sandbox has no network, so prebuild
        # downloads would fail anyway.
        nativeBuildInputs =
          (with pkgs; [
            python3
            pkg-config
            nodePackages.node-gyp
            makeWrapper
          ])
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];

        buildInputs =
          (with pkgs; [ stdenv.cc.cc.lib ])
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.glibc ];

        # Skip Playwright browser download (the container runs in Docker with
        # its own playwright install) and any puppeteer/electron fetches.
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        PUPPETEER_SKIP_DOWNLOAD = "1";
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

        makeCacheWritable = true;

        # Strip scripts that don't belong in a Nix build:
        #   - postinstall bootstraps container/ deps via `npm install` at
        #     install time; with workspaces enabled here, container deps are
        #     already installed. Running it would try to hit the network.
        #   - prepare runs husky, which needs .git and isn't useful here.
        postPatch = ''
          ${pkgs.nodejs_22}/bin/node -e '
            const fs = require("node:fs");
            const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
            delete pkg.scripts.postinstall;
            delete pkg.scripts.prepare;
            fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
          '
        '';

        # buildNpmPackage defaults to `npm run build`, which runs:
        #   prebuild:   npm run build:console  (vite build)
        #   build:      npm --prefix container run build && tsc && chmod +x dist/cli.js
        # That is what we want.

        # Prune devDeps and testing-only stuff before the install phase copies
        # node_modules into $out. Mirrors the Dockerfile's prune step.
        preInstall = ''
          npm prune --omit=dev || true
          npm --prefix container prune --omit=dev || true
        '';

        installPhase = ''
          runHook preInstall

          export INSTALL_DIR="$out/lib/node_modules/@hybridaione/hybridclaw"
          mkdir -p "$INSTALL_DIR" "$out/bin"

          # Files that mirror the published npm tarball layout so
          # resolveInstallRoot() walks up to the correct package.json.
          cp -r package.json package-lock.json "$INSTALL_DIR/"
          cp -r dist "$INSTALL_DIR/dist"
          cp -r node_modules "$INSTALL_DIR/node_modules"
          cp -r scripts "$INSTALL_DIR/scripts"

          # Console SPA (served by the gateway)
          mkdir -p "$INSTALL_DIR/console"
          cp console/package.json "$INSTALL_DIR/console/"
          cp -r console/dist "$INSTALL_DIR/console/dist"

          # Container runtime — the gateway spawns this either as a Docker
          # image or directly on the host when sandbox mode is disabled.
          mkdir -p "$INSTALL_DIR/container"
          cp container/package.json container/package-lock.json container/Dockerfile container/.dockerignore "$INSTALL_DIR/container/" 2>/dev/null || true
          cp -r container/dist "$INSTALL_DIR/container/dist"
          cp -r container/shared "$INSTALL_DIR/container/shared"
          cp -r container/src "$INSTALL_DIR/container/src"
          [ -d container/node_modules ] && cp -r container/node_modules "$INSTALL_DIR/container/node_modules"

          # Runtime asset trees
          for d in skills community-skills templates presets docs plugins; do
            [ -d "$d" ] && cp -r "$d" "$INSTALL_DIR/$d"
          done

          # Plugin SDK + metadata consumed at runtime
          cp plugin-sdk.js plugin-sdk.d.ts "$INSTALL_DIR/" 2>/dev/null || true
          cp README.md LICENSE SECURITY.md TRUST_MODEL.md AGENTS.md CHANGELOG.md config.example.json "$INSTALL_DIR/" 2>/dev/null || true

          # Make the CLI entry executable and expose it on PATH via a wrapper
          # that injects Node + runtime tools.
          chmod +x "$INSTALL_DIR/dist/cli.js"

          makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/hybridclaw" \
            --add-flags "$INSTALL_DIR/dist/cli.js" \
            --suffix PATH : "${runtimePath}"

          runHook postInstall
        '';

        # Skip autoPatchelf of prebuilt native modules that aren't needed at
        # runtime (platform-specific optional deps for other archs).
        autoPatchelfIgnoreMissingDeps = true;

        meta = with pkgs.lib; {
          description = "Enterprise-ready self-hosted AI assistant runtime";
          homepage = "https://github.com/HybridAIOne/hybridclaw";
          license = licenses.mit;
          mainProgram = "hybridclaw";
          platforms = platforms.unix;
        };
      };
    in
    {
      packages = {
        default = hybridclaw;
        hybridclaw = hybridclaw;
      };
    };
}
