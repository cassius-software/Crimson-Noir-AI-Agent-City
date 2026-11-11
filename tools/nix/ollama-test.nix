# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? flake.nix's checks.module proves what the Ollama option configures; this NixOS VM test
# proves the Ollama it configures runs. A VM imports the flake's own module (nixosModules.default, passed in as
# `module`), turns the option on with the CPU build and one extra origin, boots, and checks that ollama.service comes
# up and listens on 127.0.0.1:11434 and nowhere else, that it starts with no models, that /api/tags answers the
# launcher's page (http://127.0.0.1:4180, which Ollama allows by itself) and the extra origin with 200 and their
# Access-Control-Allow-Origin, and any other page with 403, and that the running server has OLLAMA_ORIGINS. It runs
# the CPU build: CI's runner has no GPU, and the NixOS binary cache has that build. flake.nix exposes the test as
# vmTests.<system>.ollama, outside `checks`, so `nix flake check` never needs KVM; the nix workflow's vm job builds it.
# What breaks if it is removed? The option could configure an Ollama that never starts, listens on another address or
# refuses the city's page, and only a NixOS machine would show it.
{ module }:
let
  extra = "https://cassius-software.github.io";
in
{
  name = "crimson-noir-ollama";
  # QEMU stops with an error when /dev/kvm is missing or the build user cannot open it, instead of falling back to
  # software emulation; a hung boot or service fails the build after ten minutes.
  qemu.forceAccel = true;
  globalTimeout = 600;

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ module ];
      programs.crimson-noir-agent-city.ollama = {
        enable = true;
        acceleration = "cpu";
        extraOrigins = [ extra ];
      };
      # curl and ss, which the test script runs (NixOS has both already; named so the script does not lean on that).
      environment.systemPackages = [
        pkgs.curl
        pkgs.iproute2
      ];
    };

  # What Ollama answers is read from its source at the version the flake's nixpkgs builds (0.40.3): envconfig/config.go
  # AllowedOrigins adds http://127.0.0.1:* and http://localhost:* to OLLAMA_ORIGINS's own list, and server/routes.go
  # hands that list to gin-contrib/cors 1.7.2, which echoes an allowed Origin in Access-Control-Allow-Origin and answers
  # any other Origin with 403 before the handler runs.
  testScript = ''
    import json

    LAUNCHER = "http://127.0.0.1:4180"
    EXTRA = "${extra}"
    STRANGER = "https://example.com"


    def ask(origin: str) -> tuple[str | None, str | None]:
        """GET /api/tags as a page at origin would: the status, and Access-Control-Allow-Origin or None."""
        out = machine.succeed(
            "curl -sS -o /dev/null -D - -w 'status=%{http_code}\\n' "
            + f"-H 'Origin: {origin}' http://127.0.0.1:11434/api/tags"
        )
        status: str | None = None
        allowed: str | None = None
        for line in out.splitlines():
            name, _, value = line.partition(":")
            if line.startswith("status="):
                status = line.removeprefix("status=").strip()
            elif name.strip().lower() == "access-control-allow-origin":
                allowed = value.strip()
        return status, allowed


    machine.wait_for_unit("ollama.service")
    machine.wait_for_open_port(11434, "127.0.0.1")

    # Loopback only: one listener on 11434, at 127.0.0.1 (not 0.0.0.0, not [::]).
    listeners = [line.split()[3] for line in machine.succeed("ss -Htln 'sport = :11434'").splitlines() if line.strip()]
    assert listeners == ["127.0.0.1:11434"], f"Ollama listens on {listeners}"

    # No model was asked for, so it starts empty.
    tags = json.loads(machine.succeed("curl -sSf http://127.0.0.1:11434/api/tags"))
    assert tags == {"models": []}, tags

    # The launcher's page, with nothing in OLLAMA_ORIGINS for it; the extra origin, through OLLAMA_ORIGINS.
    for origin in (LAUNCHER, EXTRA):
        got = ask(origin)
        assert got == ("200", origin), f"{origin}: {got}"
    # Any other page is refused, with no Access-Control-Allow-Origin.
    got = ask(STRANGER)
    assert got == ("403", None), f"{STRANGER}: {got}"

    # The running server's own environment, not only the unit file.
    pid = machine.succeed("systemctl show --property=MainPID --value ollama.service").strip()
    env = machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ").splitlines()
    assert f"OLLAMA_ORIGINS={EXTRA}" in env, env
    assert "OLLAMA_HOST=127.0.0.1:11434" in env, env
  '';
}
