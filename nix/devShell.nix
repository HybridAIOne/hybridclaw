# nix/devShell.nix — Development shell for HybridClaw contributors.
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          nodejs_22.pkgs.npm
          python3
          pkg-config
          biome
          git
          ripgrep
          openssh
          docker-client
        ];

        # Native-module compile requires a working toolchain.
        shellHook = ''
          echo "HybridClaw dev shell (node $(node --version))"
          if [ ! -d node_modules ]; then
            echo "hybridclaw: run 'npm install' to fetch dependencies."
          fi
        '';
      };
    };
}
