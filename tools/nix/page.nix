# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? It builds the city's page from source the way `npm run build` does, inside Nix's sandbox:
# the same lockfile, no network during the build, and a dist/index.html byte for byte the same as npm's (CI's nix
# workflow compares the two). importNpmLock fetches the packages this platform installs by the integrity hashes
# package-lock.json already carries, so no second hash has to follow the lockfile. The source is every file git keeps:
# Tailwind scans the whole tree for class names, so a narrower source would build a different page, and a wider one (a
# checkout's secrets, local AI tooling, builds) must never reach the store, which every user of the machine can read.
# The page and the app icon it installs beside it are the proprietary core (LICENSE; the icon is Reserved Material,
# NOTICE.md) and say so in meta.license; this file is MIT.
# What breaks if it is removed? The flake and the NixOS module have no page to serve.
{
  lib,
  stdenv,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
}:

let
  root = ../..;
  pkg = lib.importJSON (root + "/package.json");

  # What .gitignore ignores, by name at any depth, and what must never leave a developer's machine: local AI tooling
  # (tools/selfheal/sandbox.mjs AI_TOOLING; src/zeroTrust.test.ts holds this list to it), environment files and
  # package-manager credentials.
  ignored = [
    "node_modules"
    ".git"
    ".direnv"
    "dist"
    "dist-ssr"
    "dist-pilot"
    "dist-web"
    "result"
    "logs"
    "__pycache__"
    ".vscode"
    ".idea"
    ".DS_Store"
    ".npmrc"
    ".netrc"
    ".claude"
    ".cursor"
    ".continue"
    ".codeium"
    ".windsurf"
    ".aider.conf.yml"
    ".aider.chat.history.md"
    ".aider.input.history"
    ".aider.tags.cache.v3"
    ".mcp.json"
    "CLAUDE.local.md"
  ];
  # The Rust build folders .gitignore names, by their place in the tree.
  targets = [
    "crimson_noir_os/target"
    "src-tauri/target"
  ];
  keep =
    path: _type:
    let
      rel = lib.removePrefix "${toString root}/" (toString path);
      base = baseNameOf path;
    in
    !(
      lib.elem base ignored
      || lib.hasPrefix "result-" base
      || lib.hasPrefix ".env" base
      || builtins.match ".*\\.(log|local|suo|njsproj|sln|sw.)" base != null
      || builtins.match ".*\\.ntvs.*" base != null
      || builtins.match "(npm-debug|yarn-debug|yarn-error|pnpm-debug|lerna-debug)\\.log.*" base != null
      || lib.elem rel targets
      || builtins.match "native/[^/]+/target" rel != null
    );
  # In a git checkout outside the store (a configuration that imports the module from one): the files git tracks, the
  # set a flake gets. The checkout must belong to the user who evaluates it (git's ownership rule; `sudo` passes the
  # user on). Elsewhere (the flake's own copy, which is already that set; a `path:` copy, which carries .git along; an
  # unpacked archive): all but what `keep` drops.
  src =
    if builtins.pathExists (root + "/.git") && !lib.hasPrefix "${builtins.storeDir}/" (toString root) then
      lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.gitTracked root;
      }
    else
      lib.cleanSourceWith {
        name = "crimson-noir-agent-city-source";
        src = root;
        filter = keep;
      };

  # npm's names for the platform npm runs on (the build platform: the page itself is the same HTML everywhere), as
  # package.json's os, cpu and libc fields spell them; null for a CPU this file does not know.
  npmCpu =
    {
      x86_64 = "x64";
      aarch64 = "arm64";
    }
    .${stdenv.buildPlatform.parsed.cpu.name} or null;
  npmLibc = if stdenv.buildPlatform.isMusl then "musl" else "glibc";
  fits =
    want: list:
    list == [ ]
    || ((lib.elem want list || lib.all (x: lib.hasPrefix "!" x) list) && !(lib.elem "!${want}" list));
  usable = p: fits "linux" (p.os or [ ]) && fits npmCpu (p.cpu or [ ]) && fits npmLibc (p.libc or [ ]);
  # The lockfile, less the downloads this platform never installs: the other systems' and CPUs' builds of the native
  # tools (Tauri's CLI, oxlint, rolldown, lightningcss, Tailwind's scanner) keep their entries but lose their tarballs,
  # and npm passes over them by their os, cpu and libc fields as it would anywhere. Without this, the first build
  # fetches about 445 MB of packages, 356 MB of them for other platforms. On a CPU not named above, the whole lockfile.
  lock = lib.importJSON (root + "/package-lock.json");
  packageLock = if npmCpu == null then lock else lock // {
    packages = lib.mapAttrs (
      _: p:
      if usable p then
        p
      else
        removeAttrs p [
          "resolved"
          "integrity"
        ]
    ) lock.packages;
  };
in
buildNpmPackage {
  pname = "crimson-noir-agent-city-page";
  inherit (pkg) version;
  inherit src;
  nodejs = nodejs_24;
  npmDeps = importNpmLock {
    package = pkg;
    inherit packageLock;
  };
  npmConfigHook = importNpmLock.npmConfigHook;
  # The single-file page, not the web copy: the web copy's service worker answers from its cache first, so after an
  # update the launcher's address would show the old page once.
  npmBuildScript = "build";
  installPhase = ''
    runHook preInstall
    install -Dm444 dist/index.html $out/share/crimson-noir-agent-city/index.html
    install -Dm444 src-tauri/icons/icon.png $out/share/icons/hicolor/512x512/apps/crimson-noir-agent-city.png
    runHook postInstall
  '';
  meta = {
    description = "The page of Crimson Noir: Agent City, built from source (one self-contained WebGPU HTML file), and its icon";
    homepage = "https://github.com/cassius-software/Crimson-Noir-AI-Agent-City";
    # LICENSE, section 1: the core is All Rights Reserved. Marked unfree, so a NixOS configuration that keeps unfree
    # packages out keeps the module's package out too until it allows this one by name (MANUAL.md, On NixOS). The
    # flake's own packages output (`nix run`, or a configuration that lists that package itself) allows it already.
    license = {
      shortName = "LicenseRef-CrimsonNoir-Proprietary";
      fullName = "Crimson Noir proprietary core, All Rights Reserved (LICENSE, section 1)";
      url = "https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/blob/main/LICENSE";
      free = false;
      redistributable = false;
    };
    platforms = lib.platforms.linux;
  };
}
