# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It is the NixOS side of the flake: `programs.crimson-noir-agent-city.enable = true;`
# installs the launcher and its app-menu entry, turns on the Vulkan driver Chromium's WebGPU needs
# (hardware.graphics.enable, Mesa's radv on an AMD GPU), and lets the signed-in user's browser open a DualSense over
# WebHID (its trigger resistance, rumble and light bar need the raw HID node; the plain gamepad works without it).
# `programs.crimson-noir-agent-city.ollama.enable = true;` runs Ollama as a service on this machine's loopback, where the
# city's auto provider finds it, with a GPU build of Ollama (Vulkan unless told otherwise) and, unless `ollama.cloud =
# true;`, its cloud features off (OLLAMA_NO_CLOUD=1), so it does not call ollama.com by itself. The
# package is built from the system's own nixpkgs, so the browser and the Vulkan driver come from one set of libraries
# (Chromium from an older nixpkgs can fail to load a newer system's driver). The page is marked unfree (LICENSE, section
# 1), so the configuration allows it by name: nixpkgs.config.allowUnfreePredicate (MANUAL.md, On NixOS). A
# configuration without flakes can import this file directly.
# What breaks if it is removed? A NixOS machine still runs the city with `nix run`, but has to turn on the graphics
# driver, the controller's access and Ollama itself.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.crimson-noir-agent-city;
  llm = cfg.ollama;
  # nixpkgs 26.05 names one Ollama package per backend (ollama-cpu, -vulkan, -cuda, -rocm) and has removed
  # services.ollama.acceleration, so the choice is made by package; null leaves services.ollama.package alone.
  llmPackage = if llm.acceleration == null then null else "ollama-${llm.acceleration}";
  origins = lib.concatStringsSep "," llm.extraOrigins;
  # Whether Ollama reads an OLLAMA_NO_CLOUD value as true (envconfig/config.go, Var and Bool, Ollama 0.40.3): white
  # space, then quotes, trimmed from both ends; empty is false, as are strconv.ParseBool's false spellings; anything
  # else, even "no", is true. lib.trim takes only space, tab, CR and LF; Go's TrimSpace also takes vertical tab, form
  # feed and the Unicode spaces (U+0085, a no-break space and others), which this does not.
  noCloud =
    value:
    let
      quote = c: c == "\"" || c == "'";
      dropQuotes = cs: if cs != [ ] && quote (lib.head cs) then dropQuotes (lib.tail cs) else cs;
      chars = lib.reverseList (dropQuotes (lib.reverseList (dropQuotes (lib.stringToCharacters (lib.trim value)))));
      s = lib.concatStrings chars;
    in
    s != "" && !(lib.elem s [ "0" "f" "F" "false" "FALSE" "False" ]);
  # The environment ollama.service gets, which is what Ollama reads: systemd-lib.nix writes the unit's `environment`
  # over systemd.globalEnvironment, and nixpkgs' services.ollama puts environmentVariables in `environment`. An
  # EnvironmentFile or serviceConfig.Environment is not looked at. A variable missing, or null (systemd then leaves it
  # out), is unset: with cloud = true or extraOrigins empty, or once a configuration sets the unit's to null.
  unitEnv = config.systemd.globalEnvironment // (config.systemd.services.ollama.environment or { });
  unitValue =
    name:
    let
      v = unitEnv.${name} or null;
    in
    if v == null then null else toString v;
  noCloudValue = unitValue "OLLAMA_NO_CLOUD";
  originsValue = unitValue "OLLAMA_ORIGINS";
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
    ollama = {
      enable = lib.mkEnableOption ''
        Ollama for the city's agents: services.ollama on this machine's loopback (127.0.0.1:11434), where the city's
        auto provider finds it. It does not need `programs.crimson-noir-agent-city.enable`, so a machine can serve
        models without the city'';
      acceleration = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "cpu"
            "vulkan"
            "cuda"
            "rocm"
          ]
        );
        default = "vulkan";
        description = ''
          Which nixpkgs build of Ollama runs it: pkgs.ollama-<this>. "vulkan" runs on discrete AMD, Intel and NVIDIA
          GPUs through the graphics driver (an integrated one only with integratedGpu); "rocm" is AMD's compute stack
          (a card ROCm does not list may need services.ollama.rocmOverrideGfx); "cuda" is NVIDIA's, unfree, so it has
          to be allowed in nixpkgs.config, needs NVIDIA's driver (services.xserver.videoDrivers = [ "nvidia" ], or
          hardware.nvidia.datacenter.enable) and is not in the NixOS binary
          cache; "cpu" uses no GPU. hardware.graphics.enable is turned on for "vulkan" and "cuda", which load the
          driver from it. null leaves services.ollama.package as it is.
        '';
      };
      integratedGpu = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Let Ollama use an integrated GPU (a Ryzen's Radeon, Intel graphics): OLLAMA_IGPU_ENABLE=1. Ollama leaves
          them out by default (under Vulkan, all of them), so on a machine whose only GPU is integrated it runs on the
          processor unless this is on. On a machine with a discrete GPU too, the integrated one may then share the
          model with it.
        '';
      };
      models = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "qwen3-vl:4b" ];
        description = "Models Ollama pulls once it has started, added to services.ollama.loadModels. Without one, Ollama starts empty.";
      };
      cloud = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Let Ollama use its cloud features, which reach ollama.com: cloud models (inference on Ollama's servers), web
          search and web fetch, and what it fetches by itself, unasked: model recommendations (as it starts, then about
          every four hours, and sooner, from about five minutes, after a failed fetch) and the details of the cloud
          models (as it starts). false, the default, sets OLLAMA_NO_CLOUD=1 in ollama.service's environment
          (systemd.services.ollama.environment) with lib.mkDefault, so a value from
          services.ollama.environmentVariables, set in any way, or one set on the unit plainly or with lib.mkForce,
          wins (a different one set on the unit with lib.mkDefault conflicts); true leaves it unset (Ollama's own
          disable_ollama_cloud, in .ollama/server.json under services.ollama.home, still turns them off). Neither
          changes pulls: `models`, and `ollama pull`, still download from Ollama's registry.
        '';
      };
      extraOrigins = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "https://cassius-software.github.io" ];
        description = ''
          Page addresses besides this machine's own that Ollama answers (OLLAMA_ORIGINS). Ollama allows
          http://127.0.0.1 and http://localhost on any port by itself, so the launcher's page needs nothing here;
          the web copy, or the city opened from another address, does.
        '';
      };
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      environment.systemPackages = [ cfg.package ];
      hardware.graphics.enable = lib.mkDefault true;
      services.udev.packages = lib.mkIf cfg.dualsense [ dualsense ];
    })

    (lib.mkIf llm.enable {
      assertions = [
        {
          assertion = llmPackage == null || pkgs ? ${llmPackage};
          message = "programs.crimson-noir-agent-city.ollama.acceleration: this nixpkgs has no pkgs.${toString llmPackage}";
        }
      ];
      warnings =
        lib.optional (!lib.elem config.services.ollama.host [ "127.0.0.1" "localhost" "::1" "[::1]" ])
          "services.ollama.host is ${config.services.ollama.host}: Ollama then answers other machines too, and the city needs only this one"
        ++ lib.optional (config.services.ollama.port != 11434)
          "services.ollama.port is ${toString config.services.ollama.port}: the city's auto provider looks at 11434, so type ask connect ollama http://localhost:${toString config.services.ollama.port} at its console"
        # These two are worded by what Ollama will read (unitEnv), not by where it came from, and only when the service
        # runs.
        ++ lib.optional (config.services.ollama.enable && llm.extraOrigins != [ ] && originsValue != origins)
          "OLLAMA_ORIGINS in ollama.service's environment is ${
            if originsValue == null then "unset" else lib.strings.escapeNixString originsValue
          }, so programs.crimson-noir-agent-city.ollama.extraOrigins is not used"
        # Worded by what the variable does: Ollama's cloud is also off when disable_ollama_cloud is set in its own
        # .ollama/server.json under services.ollama.home, a file of Ollama's that is not read here.
        ++ lib.optional (config.services.ollama.enable && noCloud (if noCloudValue == null then "" else noCloudValue) == llm.cloud)
          "OLLAMA_NO_CLOUD in ollama.service's environment is ${
            if noCloudValue == null then "unset" else lib.strings.escapeNixString noCloudValue
          }, which ${
            if llm.cloud then "turns" else "does not turn"
          } Ollama's cloud features off although programs.crimson-noir-agent-city.ollama.cloud is ${lib.boolToString llm.cloud}";
      # Vulkan's loader finds its drivers, and the CUDA build NVIDIA's libcuda, under /run/opengl-driver, which only
      # the graphics stack provides.
      hardware.graphics.enable = lib.mkIf (lib.elem llm.acceleration [
        "vulkan"
        "cuda"
      ]) (lib.mkDefault true);
      # host and port stay nixpkgs' own defaults (127.0.0.1 and 11434, where auto looks), so a configuration's own
      # value, plain or mkDefault, wins; the flake check proves the address.
      services.ollama = {
        enable = lib.mkDefault true;
        package = lib.mkIf (llmPackage != null && pkgs ? ${llmPackage}) (lib.mkDefault pkgs.${llmPackage});
        loadModels = lib.mkIf (llm.models != [ ]) llm.models;
      };
      # The option's variables are defaults on the unit, not in services.ollama.environmentVariables: any definition
      # there outranks, and so drops, a configuration's own whole set given as `environmentVariables = lib.mkDefault
      # { ... }`. nixpkgs already defines the unit's environment plainly, so these drop nothing more, and a value from
      # environmentVariables, however it was set, reaches the unit as a plain value and wins. The condition sits on
      # systemd.services, so no ollama unit appears while the service is off.
      systemd.services = lib.mkIf config.services.ollama.enable {
        ollama.environment = lib.mkMerge [
          (lib.mkIf (llm.extraOrigins != [ ]) { OLLAMA_ORIGINS = lib.mkDefault origins; })
          (lib.mkIf llm.integratedGpu { OLLAMA_IGPU_ENABLE = lib.mkDefault "1"; })
          (lib.mkIf (!llm.cloud) { OLLAMA_NO_CLOUD = lib.mkDefault "1"; })
        ];
      };
    })
  ];
}
