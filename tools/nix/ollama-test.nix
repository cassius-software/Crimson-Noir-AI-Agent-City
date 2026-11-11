# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
#
# Why does this file exist? flake.nix's checks.module proves what the Ollama option configures; this NixOS VM test
# proves the Ollama it configures runs. A VM imports the flake's own module (nixosModules.default, passed in as
# `module`), turns the option on with the CPU build and one extra origin, boots, and checks that ollama.service comes
# up, that its server process's only listening TCP socket is 127.0.0.1:11434 and nothing else listens on port 11434,
# that it starts with no models, that /api/tags answers the launcher's page (http://127.0.0.1:4180, which Ollama allows
# by itself) and the extra origin with 200 and their Access-Control-Allow-Origin, and any other page with 403, and that
# the running server has OLLAMA_ORIGINS; and, with the option's cloud left off, that the server has OLLAMA_NO_CLOUD=1,
# logs that Ollama's cloud is disabled, and, once its two startup jobs that would call ollama.com have run, that no line
# of its journal names ollama.com, apart from the default OLLAMA_REMOTES (allowed hosts, not a request) in the
# configuration Ollama logs as it starts (debug logging is on in this VM for that; only the journal is read, and no
# network traffic is captured). It runs the CPU build: CI's runner has no GPU, and the NixOS binary cache has that
# build. flake.nix exposes the test as vmTests.<system>.ollama, outside `checks`, so `nix flake check` never needs KVM;
# the nix workflow's vm job builds it.
# What breaks if it is removed? The option could configure an Ollama that never starts, listens on another address,
# refuses the city's page or logs a call to ollama.com as it starts, and only a NixOS machine would show it.
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
      # This VM only: Ollama's debug logging. Both jobs that would call ollama.com as Ollama starts say that they
      # stopped because cloud is disabled at debug level and nowhere else (server/model_recommendations.go:165,
      # server/model_show_cache.go:142), and the script asserts both lines. For the job that fetches the cloud models'
      # details that line is also the one sign that it has run, which the script waits for rather than for a fixed time
      # (the recommendations job's sign is its info line, "model recommendations cache sleep scheduled").
      services.ollama.environmentVariables.OLLAMA_DEBUG = "1";
      # curl and ss, which the test script runs (NixOS has both already; named so the script does not lean on that).
      environment.systemPackages = [
        pkgs.curl
        pkgs.iproute2
      ];
    };

  # What Ollama answers is read from its source at the version the flake's nixpkgs builds (0.40.3): envconfig/config.go
  # AllowedOrigins adds http://127.0.0.1:* and http://localhost:* to OLLAMA_ORIGINS's own list, and server/routes.go
  # hands that list to gin-contrib/cors 1.7.2, which echoes an allowed Origin in Access-Control-Allow-Origin and answers
  # any other Origin with 403 before the handler runs. What it logs with cloud off is read from the same source:
  # server/routes.go, server/model_caches.go, server/model_recommendations.go and server/model_show_cache.go.
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
    # The server itself: the unit runs `ollama serve` with Type=exec, unwrapped for the CPU build.
    pid = machine.succeed("systemctl show --property=MainPID --value ollama.service").strip()
    assert pid not in ("", "0"), f"ollama.service has no main process: {pid!r}"

    # Loopback only. Port 11434 has one listener, at 127.0.0.1 (not 0.0.0.0, not [::]).
    listeners = [line.split()[3] for line in machine.succeed("ss -Htln 'sport = :11434'").splitlines() if line.strip()]
    assert listeners == ["127.0.0.1:11434"], f"port 11434 has {listeners}"
    # And the server's every listening TCP socket, on any address or port, is that one. (A model's runner is a process
    # of its own, which this does not count.)
    own = sorted(line.split()[3] for line in machine.succeed("ss -Htlnp").splitlines() if f"pid={pid}," in line)
    assert own == ["127.0.0.1:11434"], f"Ollama's server (pid {pid}) listens on {own}"

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
    env = machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ").splitlines()
    assert f"OLLAMA_ORIGINS={EXTRA}" in env, env
    assert "OLLAMA_HOST=127.0.0.1:11434" in env, env
    # Ollama's cloud off, the option's default.
    assert "OLLAMA_NO_CLOUD=1" in env, env

    UNIT_LOG = "journalctl -b -u ollama.service -o cat --no-pager"


    def wait_logged(*texts: str) -> list[str]:
        """Wait, two minutes at most, until a line of the unit's journal holds one of these texts; return its lines."""
        wanted = " ".join(f"-e '{text}'" for text in texts)
        machine.wait_until_succeeds(f"{UNIT_LOG} | grep -qF {wanted}", timeout=120)
        return machine.succeed(UNIT_LOG).splitlines()


    # Ollama logs, at info level, as it starts (its socket already open, before its "Listening on" line), whether its
    # cloud is disabled.
    lines = wait_logged('msg="Ollama cloud disabled: ')
    said = [line for line in lines if 'msg="Ollama cloud disabled: ' in line]
    assert said and all(line.endswith('msg="Ollama cloud disabled: true"') for line in said), said

    # Once set up, the server starts two jobs that call ollama.com, each in a goroutine of its own: the model
    # recommendations, fetched as it starts, then about every four hours, and sooner (from about five minutes) after a
    # failed fetch, and the cloud models' details, fetched once as it starts. With cloud off, each returns before its
    # request, and says so only at debug level. Wait until each has run: the first logs, at info level, when it
    # schedules its next fetch, after the first attempt; the second logs only why it stopped, that cloud is disabled
    # (debug) or that the fetch failed (this VM has no network). A fetch that worked would log neither and the wait
    # would time out: a failure, never a pass.
    wait_logged('msg="model recommendations cache sleep scheduled"')
    lines = wait_logged(
        'msg="skipping model show cloud cache hydration because cloud is disabled"',
        'msg="model show cloud cache hydration failed"',
    )
    for skipped in (
        'msg="skipping model recommendations refresh because cloud is disabled"',
        'msg="skipping model show cloud cache hydration because cloud is disabled"',
    ):
        assert any(skipped in line for line in lines), f"no {skipped} in Ollama's journal"


    def names_ollama_com(line: str) -> bool:
        """Whether a line names ollama.com, past the default OLLAMA_REMOTES (the hosts remote models may come from,
        not a request) in the configuration Ollama logs as it starts."""
        if 'msg="server config"' in line:
            line = line.replace(" OLLAMA_REMOTES:[ollama.com] ", " ", 1)
        return "ollama.com" in line


    # And no line of the journal names ollama.com: no request logged at debug level, no failed one. This reads only what
    # Ollama logs and captures no traffic, so a request it made without logging one would pass.
    named = [line for line in lines if names_ollama_com(line)]
    assert named == [], f"Ollama's journal names ollama.com: {named}"
  '';
}
