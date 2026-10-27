# Share one checked Node derivation across the package builder and dev shell.
# The minimum pin is generated from package.json by npm run version:sync.
{ pkgs }:
let
  minimum = pkgs.lib.removeSuffix "\n" (builtins.readFile ../.node-version);
  major = pkgs.lib.versions.major minimum;
  nodejs = pkgs."nodejs_${major}";
  supported =
    pkgs.lib.versionAtLeast nodejs.version minimum
    && pkgs.lib.versions.major nodejs.version == major;
in
assert pkgs.lib.assertMsg supported
  "HybridClaw requires Node ${minimum} or newer within major ${major}; update nixpkgs.";
nodejs
