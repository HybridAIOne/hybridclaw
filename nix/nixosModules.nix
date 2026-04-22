# nix/nixosModules.nix — NixOS service module for HybridClaw.
#
# Exposes `services.hybridclaw` which provisions:
#   - a system user/group owning $stateDir (default /var/lib/hybridclaw)
#   - a systemd service running `hybridclaw gateway start --foreground`
#   - HYBRIDCLAW_HOME pointed at $stateDir/.hybridclaw so the gateway's
#     data, sessions and skills persist across upgrades
#   - optional declarative config.json rendered from a Nix attrset
#   - optional environment file loading for secrets (API keys, tokens)
#
# Usage:
#   services.hybridclaw = {
#     enable = true;
#     settings = {
#       gateway = { host = "127.0.0.1"; port = 9090; };
#       provider = "hybridai";
#     };
#     environmentFiles = [ config.sops.secrets."hybridclaw/env".path ];
#   };
#
{ inputs, ... }:
{
  flake.nixosModules.default =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.services.hybridclaw;
      hybridclawPkg = inputs.self.packages.${pkgs.system}.default;

      # Deep-merge attrset type so multiple modules can contribute to
      # services.hybridclaw.settings without clobbering each other.
      deepConfigType = lib.types.mkOptionType {
        name = "hybridclaw-config-attrs";
        description = "HybridClaw config (attrset), merged via lib.recursiveUpdate.";
        check = builtins.isAttrs;
        merge = _loc: defs: lib.foldl' lib.recursiveUpdate { } (map (d: d.value) defs);
      };

      generatedConfigFile = pkgs.writeText "hybridclaw-config.json" (
        builtins.toJSON cfg.settings
      );

      configFile = if cfg.configFile != null then cfg.configFile else generatedConfigFile;

      manageConfig = cfg.configFile != null || cfg.settings != { };

      # Port resolution: prefer an explicit cfg.port override, otherwise
      # derive from cfg.settings.gateway.port so openFirewall cannot drift
      # from the actual gateway listen port written into config.json.
      resolvedPort =
        if cfg.port != null then
          cfg.port
        else
          lib.attrByPath [ "gateway" "port" ] 9090 cfg.settings;
    in
    {
      options.services.hybridclaw = with lib; {
        enable = mkEnableOption "HybridClaw AI assistant gateway";

        package = mkOption {
          type = types.package;
          default = hybridclawPkg;
          defaultText = literalExpression "inputs.hybridclaw.packages.\${system}.default";
          description = "The hybridclaw package to use.";
        };

        user = mkOption {
          type = types.str;
          default = "hybridclaw";
          description = "System user running the gateway.";
        };

        group = mkOption {
          type = types.str;
          default = "hybridclaw";
          description = "System group running the gateway.";
        };

        createUser = mkOption {
          type = types.bool;
          default = true;
          description = "Create the service user and group automatically.";
        };

        stateDir = mkOption {
          type = types.str;
          default = "/var/lib/hybridclaw";
          description = "State directory. Contains .hybridclaw/ (HYBRIDCLAW_HOME) and workspace/.";
        };

        workingDirectory = mkOption {
          type = types.str;
          default = "${cfg.stateDir}/workspace";
          defaultText = literalExpression ''"''${cfg.stateDir}/workspace"'';
          description = "Working directory for the gateway process.";
        };

        openFirewall = mkOption {
          type = types.bool;
          default = false;
          description = "Open the gateway listen port in the firewall.";
        };

        port = mkOption {
          type = types.nullOr types.port;
          default = null;
          defaultText = literalExpression "cfg.settings.gateway.port or 9090";
          description = ''
            Gateway HTTP listen port used by openFirewall. When unset,
            derives from `settings.gateway.port` (falling back to 9090) so
            the firewall rule stays in sync with config.json.
          '';
        };

        # ── Declarative config ──────────────────────────────────────────────
        configFile = mkOption {
          type = types.nullOr types.path;
          default = null;
          description = ''
            Path to an existing config.json. If set, takes precedence over
            the declarative `settings` option.
          '';
        };

        settings = mkOption {
          type = deepConfigType;
          default = { };
          description = ''
            Declarative HybridClaw config (attrset). Rendered to config.json
            inside HYBRIDCLAW_HOME on each activation.
          '';
          example = literalExpression ''
            {
              gateway = { host = "127.0.0.1"; port = 9090; };
              provider = "hybridai";
              sandbox = { mode = "container"; };
            }
          '';
        };

        # ── Secrets / environment ────────────────────────────────────────────
        environmentFiles = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = ''
            Paths to environment files containing secrets (API keys, tokens).
            Loaded by systemd via EnvironmentFile=. Values in later files win.
            Use this for anything sensitive — the referenced files are read
            at unit start, so they can live outside the world-readable store.
          '';
        };

        environment = mkOption {
          type = types.attrsOf types.str;
          default = { };
          description = ''
            Non-secret environment variables passed to the gateway. Merged
            into the systemd unit's `Environment=` directive, so values do
            not need .env-style quoting but DO end up in unit state. Do NOT
            put secrets here — use `environmentFiles` for anything sensitive.
          '';
        };

        # ── Service behavior ────────────────────────────────────────────────
        extraArgs = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = "Extra arguments appended to `hybridclaw gateway start`.";
        };

        extraPackages = mkOption {
          type = types.listOf types.package;
          default = [ ];
          description = "Extra packages put on the gateway's PATH.";
        };

        restart = mkOption {
          type = types.str;
          default = "always";
          description = "systemd Restart= policy.";
        };

        restartSec = mkOption {
          type = types.int;
          default = 5;
          description = "systemd RestartSec= value.";
        };

        enableDocker = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Enable the Docker daemon and add the service user to the docker
            group. Required for the default container sandbox mode.
          '';
        };

        addToSystemPackages = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Add the hybridclaw CLI to environment.systemPackages so
            interactive users can invoke it directly and share state with
            the gateway (via HYBRIDCLAW_HOME).
          '';
        };
      };

      config = lib.mkIf cfg.enable (lib.mkMerge [

        # ── User / group ─────────────────────────────────────────────────
        (lib.mkIf cfg.createUser {
          users.groups.${cfg.group} = { };
          users.users.${cfg.user} = {
            isSystemUser = true;
            group = cfg.group;
            home = cfg.stateDir;
            createHome = true;
            shell = pkgs.bashInteractive;
            extraGroups = lib.optional cfg.enableDocker "docker";
          };
        })

        # ── Docker (sandbox backend) ─────────────────────────────────────
        (lib.mkIf cfg.enableDocker {
          virtualisation.docker.enable = lib.mkDefault true;
        })

        # ── Host CLI ─────────────────────────────────────────────────────
        (lib.mkIf cfg.addToSystemPackages {
          environment.systemPackages = [ cfg.package ];
          environment.variables.HYBRIDCLAW_HOME = "${cfg.stateDir}/.hybridclaw";
        })

        # ── Firewall ─────────────────────────────────────────────────────
        (lib.mkIf cfg.openFirewall {
          networking.firewall.allowedTCPPorts = [ resolvedPort ];
        })

        # ── Directories ──────────────────────────────────────────────────
        {
          systemd.tmpfiles.rules = [
            "d ${cfg.stateDir}              0750 ${cfg.user} ${cfg.group} - -"
            "d ${cfg.stateDir}/.hybridclaw  0750 ${cfg.user} ${cfg.group} - -"
            "d ${cfg.workingDirectory}      0750 ${cfg.user} ${cfg.group} - -"
          ];
        }

        # ── Activation: render config when Nix is managing it ───────────
        {
          system.activationScripts."hybridclaw-setup" = lib.stringAfter [ "users" ] ''
            mkdir -p ${cfg.stateDir}/.hybridclaw ${cfg.workingDirectory}
            chown ${cfg.user}:${cfg.group} ${cfg.stateDir} ${cfg.stateDir}/.hybridclaw ${cfg.workingDirectory}
            chmod 0750 ${cfg.stateDir} ${cfg.stateDir}/.hybridclaw ${cfg.workingDirectory}

            ${lib.optionalString manageConfig ''
              # Nix is authoritative — render config.json on each activation.
              # To manage config.json manually, set both
              # services.hybridclaw.configFile = null and settings = {}.
              install -o ${cfg.user} -g ${cfg.group} -m 0640 ${configFile} \
                ${cfg.stateDir}/.hybridclaw/config.json
            ''}
          '';
        }

        # ── systemd service ──────────────────────────────────────────────
        {
          systemd.services.hybridclaw = {
            description = "HybridClaw AI assistant gateway";
            wantedBy = [ "multi-user.target" ];
            after = [ "network-online.target" ] ++ lib.optional cfg.enableDocker "docker.service";
            wants = [ "network-online.target" ];
            requires = lib.optional cfg.enableDocker "docker.service";

            # Non-secret env goes through the unit's Environment= directive
            # so systemd handles quoting for us. Secrets live in
            # environmentFiles (EnvironmentFile=), which are not recorded
            # into the unit state and can live outside the Nix store.
            environment = {
              HOME = cfg.stateDir;
              HYBRIDCLAW_HOME = "${cfg.stateDir}/.hybridclaw";
              HYBRIDCLAW_MANAGED = "true";
              NODE_ENV = "production";
            } // cfg.environment;

            serviceConfig = {
              User = cfg.user;
              Group = cfg.group;
              WorkingDirectory = cfg.workingDirectory;

              EnvironmentFile = cfg.environmentFiles;

              ExecStart = lib.escapeShellArgs (
                [
                  "${cfg.package}/bin/hybridclaw"
                  "gateway"
                  "start"
                  "--foreground"
                ]
                ++ cfg.extraArgs
              );

              Restart = cfg.restart;
              RestartSec = cfg.restartSec;

              # Hardening — HybridClaw still needs docker.sock + workspace
              # writes, so we can't enable the full systemd sandbox lockdown.
              NoNewPrivileges = true;
              ProtectSystem = "strict";
              ProtectHome = true;
              ReadWritePaths = [ cfg.stateDir ];
              PrivateTmp = true;
            };

            path = [
              cfg.package
              pkgs.bash
              pkgs.coreutils
              pkgs.git
            ] ++ cfg.extraPackages;
          };
        }
      ]);
    };
}
