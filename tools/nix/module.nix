# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It is the NixOS side of the flake: `programs.crimson-noir-agent-city.enable = true;`
# installs the launcher and its app-menu entry, turns on the Vulkan driver Chromium's WebGPU needs
# (hardware.graphics.enable, Mesa's radv on an AMD GPU), and lets the signed-in user's browser open a DualSense over
# WebHID (its trigger resistance, rumble and light bar need the raw HID node; the plain gamepad works without it). The
# package is built from the system's own nixpkgs, so the browser and the Vulkan driver come from one set of libraries
# (Chromium from an older nixpkgs can fail to load a newer system's driver). The page is marked unfree (LICENSE, section
# 1), so the configuration allows it by name: nixpkgs.config.allowUnfreePredicate (MANUAL.md, On NixOS). A
# configuration without flakes can import this file directly.
# What breaks if it is removed? A NixOS machine still runs the city with `nix run`, but has to turn on the graphics
# driver and the controller's access itself.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.crimson-noir-agent-city;
  # uaccess has to be tagged before systemd's 73-seat-late.rules applies it, so the rules go in a 70- file of their own
  # (services.udev.extraRules would land in 99-local.rules, too late).
  dualsense = pkgs.writeTextFile {
    name = "crimson-noir-dualsense-udev-rules";
    destination = "/etc/udev/rules.d/70-crimson-noir-dualsense.rules";
    text = ''
      # DualSense (054c:0ce6) and DualSense Edge (054c:0df2), over USB and Bluetooth: the raw HID node for the
      # signed-in user, so the browser's WebHID can drive the triggers, rumble and light bar.
      KERNEL=="hidraw*", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0ce6", TAG+="uaccess"
      KERNEL=="hidraw*", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0df2", TAG+="uaccess"
      KERNEL=="hidraw*", KERNELS=="*054C:0CE6*", TAG+="uaccess"
      KERNEL=="hidraw*", KERNELS=="*054C:0DF2*", TAG+="uaccess"
    '';
  };
in
{
  options.programs.crimson-noir-agent-city = {
    enable = lib.mkEnableOption "Crimson Noir: Agent City, its launcher and its app-menu entry";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./app.nix { page = pkgs.callPackage ./page.nix { }; };
      defaultText = lib.literalExpression "pkgs.callPackage ./app.nix { page = pkgs.callPackage ./page.nix { }; }";
      description = ''
        The launcher package (its page and its browser come with it). The page is unfree: allow
        "crimson-noir-agent-city-page" in nixpkgs.config.allowUnfreePredicate.
      '';
    };
    dualsense = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Give the signed-in user the DualSense's raw HID node, for WebHID's triggers, rumble and light bar.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    hardware.graphics.enable = lib.mkDefault true;
    services.udev.packages = lib.mkIf cfg.dualsense [ dualsense ];
  };
}
