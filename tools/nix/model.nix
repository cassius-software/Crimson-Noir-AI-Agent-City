# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It is Sloane's model for the NixOS package, so the city a Nix user starts can talk from the
# first launch with nothing to find or download by hand: Qwen2.5 1.5B Instruct at Q4_K_M (Apache-2.0), the same file the
# Windows installer carries (src/09_Cognition/siteModel.ts APP_MODEL; src/desktopLauncher.test.ts holds this file's pin
# to it). fetchurl gets it once, from Hugging Face at the pinned revision, and refuses any other bytes (the SHA-256
# below). This folder puts it beside its LICENSE and NOTICE (third_party/qwen2.5-1.5b-instruct/) and the manifest the
# page reads, which says what tools/web/siteModel.mjs writes for the web copy. The launcher (tools/web/launch.mjs)
# serves the folder beside the page at models/, and the page copies the model into its own storage once the city is on
# screen, checking its size and SHA-256 on every byte. The model is linked from its fetch's store path, not copied, so
# the store holds it once.
# What breaks if it is removed? The NixOS package carries no model, and Sloane waits for one the person has to find.
{
  lib,
  fetchurl,
  runCommand,
}:

let
  file = "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf";
  bytes = 986048768;
  sha256 = "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370";
  repo = "bartowski/Qwen2.5-1.5B-Instruct-GGUF";
  revision = "9eadc66189c7641e1ddd226b8267a9119b2ce2d4";
  # Named for the file, so CI can put the same bytes in the store before the build (`nix-store --add-fixed sha256` gives
  # the path this fetch would) and nothing is fetched twice.
  gguf = fetchurl {
    url = "https://huggingface.co/${repo}/resolve/${revision}/${file}";
    name = file;
    inherit sha256;
  };
  # The page reads it as JSON (siteModel.ts parseManifest), so the order of its keys is not part of it.
  manifest = builtins.toJSON {
    v = 1;
    inherit file bytes sha256;
  };
in
runCommand "crimson-noir-agent-city-model"
  {
    passthru = {
      inherit
        file
        bytes
        sha256
        gguf
        ;
    };
    meta = {
      description = "Sloane's model for Crimson Noir: Agent City (Qwen2.5 1.5B Instruct, Q4_K_M GGUF), with its licence and NOTICE";
      homepage = "https://huggingface.co/${repo}";
      license = lib.licenses.asl20;
      platforms = lib.platforms.all;
    };
  }
  ''
    dir=$out/share/crimson-noir-agent-city/models
    mkdir -p $dir
    ln -s ${gguf} $dir/${file}
    test "$(stat -L -c %s $dir/${file})" = ${toString bytes}
    install -m444 ${../../third_party/qwen2.5-1.5b-instruct/LICENSE} $dir/LICENSE
    install -m444 ${../../third_party/qwen2.5-1.5b-instruct/NOTICE} $dir/NOTICE
    printf '%s\n' ${lib.escapeShellArg manifest} > $dir/manifest.json
  ''
