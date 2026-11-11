# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It makes the city one command on NixOS:
#   nix run github:cassius-software/Crimson-Noir-AI-Agent-City
# builds the page from source (tools/nix/page.nix), serves it on http://127.0.0.1:4180 and opens it in Chromium with
# WebGPU on Vulkan (tools/nix/app.nix, tools/web/launch.mjs). nixosModules.default installs it built from the system's
# own nixpkgs, so its Chromium can load the system's GPU driver, and turns on what a NixOS desktop needs
# (tools/nix/module.nix); vmTests boots that module's Ollama option in a NixOS VM (tools/nix/ollama-test.nix). Another
# Linux with Nix runs it too, but Nix's Chromium cannot load that system's GPU driver: there CHROME names the
# distribution's own browser (MANUAL.md, On NixOS). `nix develop` gives the tools a contributor
# runs (Node, Chromium for the browser smoke, rustup for the native crates, Python's z3 for `npm run verify -- smt`).
# nixpkgs comes from the NixOS 26.05 channel's tarball, pinned in flake.lock. Flakes are still an experimental Nix
# feature: a stock NixOS needs nix.settings.experimental-features = [ "nix-command" "flakes" ], or
# --extra-experimental-features on the command.
# What breaks if it is removed? Nix users build and serve the page by hand (npm ci, npm run build, a server with the
# isolation headers, Chrome's WebGPU switches); CI's nix workflow has nothing to check.
{
  description = "Crimson Noir: Agent City, built from source and opened in Chromium with WebGPU";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      # The page is marked unfree (LICENSE, section 1). Running this flake's own outputs is the choice to run it, so
      # their package set allows that one package by name and nothing else; a NixOS configuration allows it itself.
      allowPage = pkg: lib.getName pkg == "crimson-noir-agent-city-page";
      forAll =
        f:
        lib.genAttrs systems (
          system:
          f system (
            import nixpkgs {
              inherit system;
              config.allowUnfreePredicate = allowPage;
            }
          )
        );
    in
    {
      packages = forAll (
        _: pkgs: rec {
          page = pkgs.callPackage ./tools/nix/page.nix { };
          crimson-noir-agent-city = pkgs.callPackage ./tools/nix/app.nix { inherit page; };
          default = crimson-noir-agent-city;
        }
      );

      devShells = forAll (
        _: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.chromium
              pkgs.rustup
              (pkgs.python3.withPackages (ps: [ ps.z3-solver ]))
              pkgs.git
            ];
            # tools/browser/cdp.mjs reads CHROME: the browser smoke then drives this shell's Chromium.
            CHROME = lib.getExe pkgs.chromium;
          };
        }
      );

      nixosModules.default = ./tools/nix/module.nix;

      # The module's Ollama option booted in a NixOS VM on the CPU build (tools/nix/ollama-test.nix). Not in checks: it
      # needs KVM and `nix flake check` must not (that command warns it does not know this output and leaves it alone).
      # CI's nix workflow builds the x86-64 one in a job of its own: nix build -L .#vmTests.x86_64-linux.ollama
      vmTests = forAll (
        _: pkgs: {
          ollama = pkgs.testers.runNixOSTest (
            import ./tools/nix/ollama-test.nix { module = self.nixosModules.default; }
          );
        }
      );

      checks = forAll (
        system: pkgs: {
          inherit (self.packages.${system}) page crimson-noir-agent-city;
          # The module evaluated on a minimal system: the launcher installed, the graphics driver on, the DualSense
          # rules in place, the package's derivation evaluated once the page is allowed and refused while it is not;
          # and its Ollama option alone: on loopback at 11434, the Vulkan build unless another is chosen, the graphics
          # driver for Vulkan and CUDA only, CUDA refused until unfree packages are allowed, origins, models and the
          # integrated GPU only when asked for, Ollama's cloud off (OLLAMA_NO_CLOUD=1) unless asked for, the system's
          # own settings winning; no warning for the default or cloud = true, the cloud one for each OLLAMA_NO_CLOUD
          # tried below that goes against `cloud` and for none of the others tried, the origins one with its value or
          # unset, both read from ollama.service's environment (its own over systemd's global one) and only while the
          # service runs, and three for the system's own host, port and origins; the option's variables kept on the
          # unit whatever the system does to services.ollama.environmentVariables as a whole.
          # Only the configuration is evaluated; no system is built and nothing runs.
          module =
            let
              eval =
                extra:
                lib.nixosSystem {
                  modules = [
                    self.nixosModules.default
                    extra
                    {
                      nixpkgs.hostPlatform = system;
                      boot.loader.grub.enable = false;
                      fileSystems."/" = {
                        device = "none";
                        fsType = "tmpfs";
                      };
                      system.stateVersion = "26.05";
                    }
                  ];
                };
              city =
                extra:
                (eval {
                  imports = [ extra ];
                  programs.crimson-noir-agent-city.enable = true;
                }).config;
              config = city { nixpkgs.config.allowUnfreePredicate = allowPage; };
              refused = city { };
              names = map (p: p.pname or p.name) config.environment.systemPackages;
              rules = map (p: p.name) config.services.udev.packages;
              llm =
                extra:
                eval {
                  imports = [ extra ];
                  programs.crimson-noir-agent-city.ollama.enable = true;
                };
              plain = llm { };
              full = llm {
                programs.crimson-noir-agent-city.ollama = {
                  models = [ "qwen3-vl:4b" ];
                  extraOrigins = [ "https://cassius-software.github.io" ];
                };
              };
              # A system default below the option's, so a module that ignored "cpu" would leave the Vulkan build.
              cpu = llm (
                { pkgs, ... }:
                {
                  programs.crimson-noir-agent-city.ollama.acceleration = "cpu";
                  services.ollama.package = lib.mkOverride 1500 pkgs.ollama-vulkan;
                }
              );
              rocm = llm { programs.crimson-noir-agent-city.ollama.acceleration = "rocm"; };
              none = llm { programs.crimson-noir-agent-city.ollama.acceleration = null; };
              igpu = llm { programs.crimson-noir-agent-city.ollama.integratedGpu = true; };
              cloud = llm { programs.crimson-noir-agent-city.ollama.cloud = true; };
              # The system's own OLLAMA_NO_CLOUD in services.ollama.environmentVariables: it wins over the option's
              # default on the unit, and the warning says so when Ollama reads it as false (envconfig's Bool, after its
              # white space and quotes go: empty and Go's false spellings, "0", "f", "F", "false", "False" and "FALSE";
              # "no" is true to Ollama), each one tried below; set with lib.mkDefault, it wins too, with no conflict.
              ownNoCloud = v: llm { services.ollama.environmentVariables.OLLAMA_NO_CLOUD = v; };
              ownDefaultNoCloud = llm { services.ollama.environmentVariables.OLLAMA_NO_CLOUD = lib.mkDefault "0"; };
              # The system's whole environment given as a default: kept, with every one of the option's variables in
              # use beside it, or its own OLLAMA_NO_CLOUD winning.
              setDefault = llm {
                programs.crimson-noir-agent-city.ollama = {
                  extraOrigins = [ "https://a.example" ];
                  integratedGpu = true;
                };
                services.ollama.environmentVariables = lib.mkDefault { OLLAMA_CONTEXT_LENGTH = "8192"; };
              };
              setDefaultOwn = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                services.ollama.environmentVariables = lib.mkDefault { OLLAMA_NO_CLOUD = "0"; };
              };
              cloudStillOff = llm {
                programs.crimson-noir-agent-city.ollama.cloud = true;
                services.ollama.environmentVariables.OLLAMA_NO_CLOUD = "1";
              };
              # The whole of services.ollama.environmentVariables replaced: the option's variables are on the unit, so
              # they stay.
              envReplaced = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                services.ollama.environmentVariables = lib.mkForce { };
              };
              # The warnings read the unit's own environment, over systemd's global one: set there, or taken out with
              # null, the variable is what Ollama reads, whatever services.ollama.environmentVariables says.
              unitOff = llm {
                programs.crimson-noir-agent-city.ollama.cloud = true;
                systemd.services.ollama.environment.OLLAMA_NO_CLOUD = "1";
              };
              globalOff = llm {
                programs.crimson-noir-agent-city.ollama.cloud = true;
                systemd.globalEnvironment.OLLAMA_NO_CLOUD = "1";
              };
              # The unit's own value over a global one: no warning, as Ollama reads "1".
              globalUnder = llm { systemd.globalEnvironment.OLLAMA_NO_CLOUD = "0"; };
              unitNull = llm { systemd.services.ollama.environment.OLLAMA_NO_CLOUD = lib.mkForce null; };
              unitWins = llm {
                services.ollama.environmentVariables.OLLAMA_NO_CLOUD = lib.mkForce "0";
                systemd.services.ollama.environment.OLLAMA_NO_CLOUD = lib.mkForce "1";
              };
              # The unit's own OLLAMA_ORIGINS, the option's, over a global one: no warning.
              globalOrigins = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                systemd.globalEnvironment.OLLAMA_ORIGINS = "https://b.example";
              };
              unitOrigins = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                systemd.services.ollama.environment.OLLAMA_ORIGINS = lib.mkForce "https://b.example";
              };
              # extraOrigins with the unit's OLLAMA_ORIGINS taken out: unset.
              originsGone = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                systemd.services.ollama.environment.OLLAMA_ORIGINS = lib.mkForce null;
              };
              originsWarning =
                seen:
                "OLLAMA_ORIGINS in ollama.service's environment is ${seen}, so programs.crimson-noir-agent-city.ollama.extraOrigins is not used";
              cloudWarning =
                seen: state: cloud:
                "OLLAMA_NO_CLOUD in ollama.service's environment is ${seen}, which ${state} Ollama's cloud features off although programs.crimson-noir-agent-city.ollama.cloud is ${cloud}";
              # The service off: neither warning, though its unit, and so both variables, are gone.
              off = llm {
                programs.crimson-noir-agent-city.ollama.extraOrigins = [ "https://a.example" ];
                services.ollama.enable = false;
              };
              ownPackage = llm ({ pkgs, ... }: { services.ollama.package = pkgs.ollama-cpu; });
              ownDefault = llm { services.ollama.host = lib.mkDefault "0.0.0.0"; };
              cuda = llm { programs.crimson-noir-agent-city.ollama.acceleration = "cuda"; };
              cudaAllowed = llm {
                programs.crimson-noir-agent-city.ollama.acceleration = "cuda";
                nixpkgs.config.allowUnfree = true;
              };
              theirs = llm {
                programs.crimson-noir-agent-city.ollama = {
                  extraOrigins = [ "https://a.example" ];
                  models = [ "a" ];
                };
                services.ollama = {
                  host = "0.0.0.0";
                  port = 11500;
                  environmentVariables.OLLAMA_ORIGINS = "https://b.example";
                  loadModels = [ "b" ];
                };
              };
              env = e: e.config.systemd.services.ollama.environment;
              ours = e: lib.filter (w: lib.hasInfix "ollama" w) e.config.warnings;
              failed = e: lib.filter (a: !a.assertion) e.config.assertions;
            in
            assert config.hardware.graphics.enable;
            assert lib.elem "crimson-noir-agent-city" names;
            assert lib.elem "crimson-noir-dualsense-udev-rules" rules;
            assert lib.isString config.programs.crimson-noir-agent-city.package.drvPath;
            assert !(builtins.tryEval refused.programs.crimson-noir-agent-city.package.drvPath).success;
            assert !config.services.ollama.enable;
            assert plain.config.services.ollama.enable;
            assert (env plain).OLLAMA_HOST == "127.0.0.1:11434";
            assert plain.config.services.ollama.package.drvPath == plain.pkgs.ollama-vulkan.drvPath;
            assert plain.config.hardware.graphics.enable;
            assert !((env plain) ? OLLAMA_ORIGINS) && !((env plain) ? OLLAMA_IGPU_ENABLE);
            assert !(plain.config.systemd.services ? ollama-model-loader);
            assert ours plain == [ ] && failed plain == [ ];
            assert !(lib.elem "crimson-noir-agent-city" (map (p: p.pname or p.name) plain.config.environment.systemPackages));
            assert (env full).OLLAMA_ORIGINS == "https://cassius-software.github.io";
            assert full.config.services.ollama.loadModels == [ "qwen3-vl:4b" ];
            assert full.config.systemd.services ? ollama-model-loader;
            assert cpu.config.services.ollama.package.drvPath == cpu.pkgs.ollama-cpu.drvPath;
            assert none.config.services.ollama.package.drvPath == none.pkgs.ollama.drvPath;
            assert !cpu.config.hardware.graphics.enable && !rocm.config.hardware.graphics.enable;
            assert !none.config.hardware.graphics.enable && cuda.config.hardware.graphics.enable;
            assert (env igpu).OLLAMA_IGPU_ENABLE == "1";
            assert (env plain).OLLAMA_NO_CLOUD == "1";
            assert !((env cloud) ? OLLAMA_NO_CLOUD) && ours cloud == [ ];
            assert map (v: (env (ownNoCloud v)).OLLAMA_NO_CLOUD) [ "0" "true" ] == [ "0" "true" ];
            assert lib.all (v: ours (ownNoCloud v) == [ (cloudWarning "\"${v}\"" "does not turn" "false") ]) [ "0" "f" "F" "false" "False" "FALSE" "" " 'False' " ];
            assert lib.all (v: ours (ownNoCloud v) == [ ]) [ "1" "true" "no" ];
            assert ours cloudStillOff == [ (cloudWarning "\"1\"" "turns" "true") ];
            assert (env envReplaced).OLLAMA_NO_CLOUD == "1" && (env envReplaced).OLLAMA_ORIGINS == "https://a.example" && ours envReplaced == [ ];
            assert (env ownDefaultNoCloud).OLLAMA_NO_CLOUD == "0" && ours ownDefaultNoCloud == [ (cloudWarning "\"0\"" "does not turn" "false") ];
            assert
              lib.attrsets.getAttrs [ "OLLAMA_CONTEXT_LENGTH" "OLLAMA_NO_CLOUD" "OLLAMA_ORIGINS" "OLLAMA_IGPU_ENABLE" ] (env setDefault)
              == {
                OLLAMA_CONTEXT_LENGTH = "8192";
                OLLAMA_NO_CLOUD = "1";
                OLLAMA_ORIGINS = "https://a.example";
                OLLAMA_IGPU_ENABLE = "1";
              }
              && ours setDefault == [ ];
            assert (env setDefaultOwn).OLLAMA_NO_CLOUD == "0" && ours setDefaultOwn == [ (cloudWarning "\"0\"" "does not turn" "false") ];
            assert ours full == [ ];
            assert ours unitOff == [ (cloudWarning "\"1\"" "turns" "true") ] && ours globalOff == ours unitOff;
            assert ours unitNull == [ (cloudWarning "unset" "does not turn" "false") ] && ours unitWins == [ ] && ours globalUnder == [ ];
            assert ours unitOrigins == [ (originsWarning "\"https://b.example\"") ];
            assert (env globalOrigins).OLLAMA_ORIGINS == "https://a.example" && ours globalOrigins == [ ];
            assert ours off == [ ] && !(off.config.systemd.services ? ollama);
            assert
              (env originsGone).OLLAMA_ORIGINS == null
              && ours originsGone == [ (originsWarning "unset") ];
            assert !(builtins.tryEval cuda.config.services.ollama.package.drvPath).success;
            assert lib.isString cudaAllowed.config.services.ollama.package.drvPath;
            assert (env theirs).OLLAMA_HOST == "0.0.0.0:11500";
            assert (env theirs).OLLAMA_ORIGINS == "https://b.example";
            assert lib.length (ours theirs) == 3 && lib.elem (originsWarning "\"https://b.example\"") (ours theirs);
            assert lib.sort lib.lessThan theirs.config.services.ollama.loadModels == [ "a" "b" ];
            assert ownPackage.config.services.ollama.package.drvPath == ownPackage.pkgs.ollama-cpu.drvPath;
            assert (env ownDefault).OLLAMA_HOST == "0.0.0.0:11434";
            assert !off.config.services.ollama.enable;
            pkgs.runCommand "crimson-noir-module-check" { } "touch $out";
        }
      );
    };
}
