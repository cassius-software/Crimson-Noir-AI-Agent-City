# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It packages the launcher (tools/web/launch.mjs) around the built page: a
# `crimson-noir-agent-city` command that serves the page on http://127.0.0.1:4180 and opens it in Chromium as an app
# window with WebGPU on Vulkan, an app-menu entry and an icon. It is what `nix run` runs and what the NixOS module
# installs. CHROME and AGENT_CITY_DIST are defaults only, so CHROME=google-chrome-stable or another page still win.
# The launcher is MIT; the page it serves is not (tools/nix/page.nix).
# What breaks if it is removed? `nix run` and the module have no command to start the city.
{
  lib,
  stdenvNoCC,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  nodejs_24,
  chromium,
  page,
}:

let
  root = ../..;
in
stdenvNoCC.mkDerivation {
  pname = "crimson-noir-agent-city";
  inherit (page) version;
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/tools/web/launch.mjs")
      (root + "/tools/browser/cdp.mjs")
      (root + "/src-tauri/icons/icon.png")
    ];
  };
  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];
  desktopItems = [
    (makeDesktopItem {
      name = "crimson-noir-agent-city";
      desktopName = "Crimson Noir: Agent City";
      comment = "The city in one WebGPU page, opened in Chromium";
      exec = "crimson-noir-agent-city";
      icon = "crimson-noir-agent-city";
      categories = [
        "Game"
        "Simulation"
      ];
      startupWMClass = "crimson-noir-agent-city";
    })
    # Under Wayland Chromium ignores --class and names the app window by its address and profile folder (the launcher's
    # PROFILE_NAME); a desktop shell finds a window's icon and name by a desktop file of that name, so this hidden one
    # gives the window the city's.
    (makeDesktopItem {
      name = "chrome-127.0.0.1__-AgentCity";
      desktopName = "Crimson Noir: Agent City";
      exec = "crimson-noir-agent-city";
      icon = "crimson-noir-agent-city";
      noDisplay = true;
    })
  ];
  # The launcher imports ../browser/cdp.mjs, so the two keep the tree's layout under libexec.
  installPhase = ''
    runHook preInstall
    install -Dm444 tools/web/launch.mjs $out/libexec/crimson-noir-agent-city/web/launch.mjs
    install -Dm444 tools/browser/cdp.mjs $out/libexec/crimson-noir-agent-city/browser/cdp.mjs
    install -Dm444 src-tauri/icons/icon.png $out/share/icons/hicolor/512x512/apps/crimson-noir-agent-city.png
    makeWrapper ${lib.getExe nodejs_24} $out/bin/crimson-noir-agent-city \
      --add-flags $out/libexec/crimson-noir-agent-city/web/launch.mjs \
      --set-default AGENT_CITY_DIST ${page}/share/crimson-noir-agent-city \
      --set-default CHROME ${lib.getExe chromium}
    runHook postInstall
  '';
  passthru = { inherit page chromium; };
  meta = {
    description = "Crimson Noir: Agent City, served on this machine and opened in Chromium with WebGPU";
    homepage = "https://github.com/cassius-software/Crimson-Noir-AI-Agent-City";
    mainProgram = "crimson-noir-agent-city";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
