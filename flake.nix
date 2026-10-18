# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It makes the city one command on NixOS:
#   nix run github:cassius-software/Crimson-Noir-AI-Agent-City
# builds the page from source (tools/nix/page.nix), serves it on http://127.0.0.1:4180 and opens it in Chromium with
# WebGPU on Vulkan (tools/nix/app.nix, tools/web/launch.mjs). nixosModules.default installs it built from the system's
# own nixpkgs, so its Chromium can load the system's GPU driver, and turns on what a NixOS desktop needs
# (tools/nix/module.nix). Another Linux with Nix runs it too, but Nix's Chromium cannot load that system's GPU driver:
# there CHROME names the distribution's own browser (MANUAL.md, On NixOS). `nix develop` gives the tools a contributor
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

      checks = forAll (
        system: pkgs: {
          inherit (self.packages.${system}) page crimson-noir-agent-city;
          # The module evaluated on a minimal system: the launcher installed, the graphics driver on, the DualSense
          # rules in place, the package's derivation evaluated once the page is allowed and refused while it is not.
          # Only the configuration is evaluated; no system is built.
          module =
            let
              system' =
                extra:
                (lib.nixosSystem {
                  modules = [
                    self.nixosModules.default
                    extra
                    {
                      nixpkgs.hostPlatform = system;
                      programs.crimson-noir-agent-city.enable = true;
                      boot.loader.grub.enable = false;
                      fileSystems."/" = {
                        device = "none";
                        fsType = "tmpfs";
                      };
                      system.stateVersion = "26.05";
                    }
                  ];
                }).config;
              config = system' { nixpkgs.config.allowUnfreePredicate = allowPage; };
              refused = system' { };
              names = map (p: p.pname or p.name) config.environment.systemPackages;
              rules = map (p: p.name) config.services.udev.packages;
            in
            assert config.hardware.graphics.enable;
            assert lib.elem "crimson-noir-agent-city" names;
            assert lib.elem "crimson-noir-dualsense-udev-rules" rules;
            assert lib.isString config.programs.crimson-noir-agent-city.package.drvPath;
            assert !(builtins.tryEval refused.programs.crimson-noir-agent-city.package.drvPath).success;
            pkgs.runCommand "crimson-noir-module-check" { } "touch $out";
        }
      );
    };
}
