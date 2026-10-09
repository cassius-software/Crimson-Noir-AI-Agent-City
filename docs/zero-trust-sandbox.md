# The zero-trust sandbox of the self-healing agent

The one place in this repository where an agent runs code it did not write is the self-healing loop
(`.github/workflows/selfheal.yml`, `tools/selfheal/agent.mjs`): a patch the planner formulated, from a model or from
a built-in remedy, is applied to a copy of the tree and the checks are run on that copy. Everything that copy
contains, and everything the checks build and run from it (build scripts, tests, npm scripts, the modules under
test), is untrusted. This document says what contains it, how each claim is verified, and what is only argued.

## The containment

`tools/selfheal/sandbox.mjs` is the one definition (`CONTAINMENT`); `tools/selfheal/Dockerfile.sandbox` is the image.

| Vector | The containment | Verified by |
| --- | --- | --- |
| Egress | `--network none`: a network namespace of the container's own, with the loopback interface only. No interface, no route, no DNS, no proxy (the proxy variables are passed empty). Not a filtered network, not a proxy: there is no path. | `net.interfaces`, `net.route`, `net.dns`, `net.tcp`, `net.udp`, `net.http`, `net.node`, `net.proxy` probes; `--network none` held by the unit test |
| Host filesystem | No bind mount at all. The tree arrives as a tar stream on stdin; `/work` and `/tmp` are tmpfs with `noexec,nosuid,nodev`; the root is read-only; `/build` is an anonymous volume docker creates empty for the container and removes with it. | `mount.binds`, `mount.work.flags`, `mount.tmp.flags`, `mount.root` probes; the unit test holds that the arguments carry no `-v` and no `type=bind` |
| Daemon sockets | Nothing is mounted, so the Docker, containerd, podman and D-Bus sockets are absent; a private network namespace puts the host's abstract sockets out of reach; no `DOCKER_HOST`, no session bus. | `sock.daemons`, `sock.any` probes |
| Malicious workspace file | A file a check or a patch writes to `/work` or `/tmp` cannot be executed (ELF or script), mapped executable (`mmap PROT_EXEC`) or made a device node; a setuid or file-capability binary raises nothing (`no-new-privileges`). | `exec.work.*`, `exec.tmp.*`, `exec.setuid` probes |
| Privilege | The image's `sandbox` user (uid 10001); `--cap-drop ALL`; docker's default seccomp profile; private pid, ipc and cgroup namespaces; memory and process bounds. No user, mount or network namespace can be created; no mount; no device; the kernel's switches and log are out of reach. | `priv.uid`, `priv.caps`, `priv.userns`, `priv.mountns`, `priv.netns`, `priv.mount`, `priv.sysrq`, `priv.sysfs`, `priv.kmsg`, `priv.disk`, `priv.pidns` probes |
| Credential harvesting | The container's environment is built from an allowlist (`ENV_ALLOWED`); a credential-shaped name (`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `AUTH`, ...) is refused whoever asks; the agent's own environment, where `ANTHROPIC_API_KEY` and the workflow token live, never reaches the container. The tree is sent without `.git` (the runner's checkout keeps the token there), `node_modules` or build output. | `cred.env`, `cred.init`, `cred.files`, `cred.shadow` probes; the unit test holds the allowlist and the refusal, and the tar's exclusions |

## How it is verified

`node tools/sandbox/verify.mjs`, run by `ci.yml`'s `sandbox` job on every pull request, is three experiments:

1. **Contained.** `tools/sandbox/probe.sh` runs inside the sandbox through the very code path and arguments the
   agent uses. Every one of its escape attempts must be denied. Each attempt is one JSON line; the run is kept as
   an artifact (`sandbox-evidence-<run>`, `report.json`).
2. **The control.** The same image and the same probes, started with the containment taken away (root, the host's
   network and pid namespaces, a writable workspace, a planted key file, a token-shaped variable). The probes the
   containment exists to deny (`MUST_FLIP` in `verify.mjs`) must now report an escape. A probe that cannot tell
   the difference fails the job. This is what makes "all probes denied" evidence rather than a vacuous pass.
3. **The checks, contained.** A page build and the native crates' tests run in the sandbox and must pass: the
   containment is one the checks can live in.

The unit tests (`tools/selfheal/sandbox.test.mjs`, in the `page` job) hold the argument list, the environment
allowlist, the tar's exclusions and the entry script without docker, and run the probe on the unconfined runner
as a second control (it must find escapes and exit 1).

## What is proved, what is tested, what is argued

Honestly, in three tiers:

- **Proved (by construction, checked by test):** no host path is mounted (the argument list has none; the
  `mount.binds` probe reads `/proc/mounts` from inside). The container's environment is a function of an allowlist
  and cannot carry a credential-shaped name (`envArgs` throws; the unit test holds it for the known secrets).
- **Tested empirically, every pull request:** every row of the table above, inside the real container, with a
  control that shows the probes detect the escape when the containment is absent.
- **Argued, not proved:** the Linux kernel's namespace, seccomp, capability and mount-flag semantics, and docker's
  implementation of them, are the trusted computing base. No proof in this repository covers the kernel. The
  `noexec` flag stops `execve` and `PROT_EXEC` mappings of files on the mount; it does not stop an interpreter the
  image carries (sh, node, python, cargo) from reading and running a workspace file as *data*, and it cannot: that
  is what the checks are. What the containment bounds is what such code can reach: nothing off the machine,
  nothing of the host, no daemon, no privilege, no persistence past `--rm`.

## What is out of scope here

- The agent process itself (`agent.mjs`) runs on the runner with the network and the workflow token, because it
  pushes the `selfheal-*` branch and opens the pull request. It executes no tree code; it reads the sandbox's
  output. A patch from the model is tested only in the sandbox and never merged (the workflow has no permission
  to; branch protection on `main` should require a review).
- The production host (`deploy/docker-compose.yml`) is a different containment with its own document; the
  `NET_TRUST_PROXY` there is the public web host's reverse proxy, not an agent egress path.
- The page's in-browser air gap (`src/02_Define_The_Rules/airgap.ts`) and the WebAssembly air gap
  (`tools/verify/wasm_airgap.py`) are documented in `zero-trust-audit.md` and `MANUAL.md`.

## Running it by hand

```sh
# the whole experiment (builds the image; ten minutes the first time)
node tools/sandbox/verify.mjs --out /tmp/sandbox && cat /tmp/sandbox/report.json
# the probes alone, in the sandbox, through the agent's own runner
node -e 'import("./tools/selfheal/sandbox.mjs").then((s) => console.log(s.runChecks(".", ["sandbox-probe"], { kind: "docker" }).output))'
# the probes on this machine (the control: they should find escapes and exit 1)
sh tools/sandbox/probe.sh
```
