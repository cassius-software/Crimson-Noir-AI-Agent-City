#!/bin/sh
# Why does this file exist? It is the escape attempt. Run inside the self-healing agent's sandbox (tools/selfheal/
# sandbox.mjs; `sh tools/selfheal/checks.sh sandbox-probe`), it tries, from the position of a malicious check or a
# planted workspace file, every escape vector the containment claims to close: egress (an interface, a route, DNS,
# a TCP connection, HTTP, a proxy, node's fetch), the host's daemons (the Docker and D-Bus sockets, any socket at
# all), execution of a file written to the workspace or /tmp (an ELF, a script, an executable mapping, a setuid
# gain), privilege (root, a capability, a user namespace, a mount, a device node, the kernel's switches, the host's
# processes) and credentials (the environment, the usual files, the init process's environment). Each attempt is
# expected to be denied; one that succeeds is an escape, and the script exits 1. Every attempt is one JSON line on
# stdout (`{"probe","expect","observed","detail"}`) and the last line is the summary, so tools/sandbox/verify.mjs
# can read the run as data and keep it as evidence. The script is plain POSIX sh with python3, the image's
# tools; it writes only under /work and /tmp and removes what it wrote.
# Run on an unconfined host (or in the weakened control container verify.mjs starts) the same probes report
# "escaped": that is the control that shows the probes are live, not vacuous.
# What breaks if it is removed? The containment is a list of flags nobody has tried to get past.
set -u
escaped=0
total=0

# json STRING: the string as a JSON literal (quotes, backslashes and control characters escaped).
json() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'; }

# report NAME OBSERVED DETAIL
report() {
  total=$((total + 1))
  [ "$2" = denied ] || escaped=$((escaped + 1))
  printf '{"probe":%s,"expect":"denied","observed":%s,"detail":%s}\n' "$(json "$1")" "$(json "$2")" "$(json "$3")"
}

# deny NAME DETAIL CMD...: the command is the escape attempt; it must fail (non-zero) for the probe to be denied.
deny() {
  name=$1; detail=$2; shift 2
  out=$("$@" 2>&1); s=$?
  if [ "$s" -ne 0 ]; then report "$name" denied "$detail: refused ($s) $(printf '%s' "$out" | head -c 160 | tr '\n' ' ')"
  else report "$name" escaped "$detail: SUCCEEDED $(printf '%s' "$out" | head -c 160 | tr '\n' ' ')"; fi
}

# ---- egress ----------------------------------------------------------------------------------------------------
ifaces=$(ls /sys/class/net 2>/dev/null | grep -v '^lo$' | tr '\n' ' ')
if [ -z "$ifaces" ]; then report net.interfaces denied "only lo in /sys/class/net"; else report net.interfaces escaped "interfaces besides lo: $ifaces"; fi

routes=$(awk 'NR > 1' /proc/net/route 2>/dev/null | wc -l | tr -d ' ')
if [ "$routes" = 0 ]; then report net.route denied "no IPv4 route"; else report net.route escaped "$routes route(s) in /proc/net/route"; fi

deny net.dns "resolve github.com" getent hosts github.com

deny net.tcp "TCP connect to 1.1.1.1:443" python3 -c '
import socket
s = socket.socket(); s.settimeout(3); s.connect(("1.1.1.1", 443)); print("connected")'

deny net.udp "UDP send to 8.8.8.8:53" python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b"x", ("8.8.8.8", 53)); print("sent")'

if command -v curl > /dev/null 2>&1; then deny net.http "HTTPS GET api.anthropic.com" curl -sS --max-time 5 -o /dev/null https://api.anthropic.com/; fi

if command -v node > /dev/null 2>&1; then
  deny net.node "node fetch https://github.com" node -e 'fetch("https://github.com", { signal: AbortSignal.timeout(5000) }).then(() => { console.log("fetched"); process.exit(0) }, (e) => { console.error(String(e.cause ?? e)); process.exit(1) })'
fi

proxies=$(env | grep -iE '^(https?|all)_proxy=.+' | cut -d= -f1 | tr '\n' ' ')
if [ -z "$proxies" ]; then report net.proxy denied "no proxy variable set"; else report net.proxy escaped "proxy configured: $proxies"; fi

# ---- the host's daemons ----------------------------------------------------------------------------------------
present=""
for s in /var/run/docker.sock /run/docker.sock /run/dbus/system_bus_socket /var/run/dbus/system_bus_socket /run/containerd/containerd.sock /run/podman/podman.sock; do
  [ -e "$s" ] && present="$present $s"
done
[ -n "${DOCKER_HOST:-}" ] && present="$present DOCKER_HOST=$DOCKER_HOST"
[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && present="$present DBUS_SESSION_BUS_ADDRESS"
[ -n "${DBUS_SYSTEM_BUS_ADDRESS:-}" ] && present="$present DBUS_SYSTEM_BUS_ADDRESS"
[ -d /run/user ] && present="$present /run/user"
if [ -z "$present" ]; then report sock.daemons denied "no Docker, containerd, podman or D-Bus socket, no DOCKER_HOST, no session bus"; else report sock.daemons escaped "reachable:$present"; fi

# Four levels deep (every daemon socket lives at two or three: /run/x.sock, /var/run/x/y.sock, /tmp/.X11-unix/X0); an
# unbounded walk of a host's disk is minutes, and this probe also runs on the unconfined host as a control.
socks=$(find / -xdev -maxdepth 4 -type s -not -path '/proc/*' 2>/dev/null | head -n 20 | tr '\n' ' ')
if [ -z "$socks" ]; then report sock.any denied "no unix socket within four levels of the root"; else report sock.any escaped "sockets: $socks"; fi

# ---- execution of what a check or a patch can write ------------------------------------------------------------
for dir in /work /tmp; do
  n=$(printf '%s' "$dir" | tr -d /)
  cp /bin/true "$dir/.probe-elf" 2>/dev/null && chmod 755 "$dir/.probe-elf"
  deny "exec.$n.elf" "run an ELF copied to $dir" "$dir/.probe-elf"
  printf '#!/bin/sh\necho ran\n' > "$dir/.probe-sh" && chmod 755 "$dir/.probe-sh"
  deny "exec.$n.script" "run a shell script written to $dir" "$dir/.probe-sh"
  deny "exec.$n.mmap" "map a file in $dir executable" python3 -c "
import mmap
f = open('$dir/.probe-elf', 'rb'); m = mmap.mmap(f.fileno(), 64, prot=mmap.PROT_READ | mmap.PROT_EXEC); print('mapped')"
  deny "exec.$n.mknod" "make a device node in $dir" mknod "$dir/.probe-dev" c 1 3
  rm -f "$dir/.probe-elf" "$dir/.probe-sh" "$dir/.probe-dev"
done

nnp=$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)
if [ "$nnp" = 1 ]; then report exec.setuid denied "NoNewPrivs is set: a setuid or file-capability binary raises nothing"; else report exec.setuid escaped "NoNewPrivs is ${nnp:-unset}"; fi

# ---- mounts ----------------------------------------------------------------------------------------------------
flags_of() { awk -v p="$1" '$2 == p { print $4; exit }' /proc/mounts; }
for m in /work /tmp; do
  f=$(flags_of "$m"); missing=""
  for fl in noexec nosuid nodev; do printf ',%s,' "$f" | grep -q ",$fl," || missing="$missing $fl"; done
  n="mount.$(printf '%s' "$m" | tr -d /).flags"
  if [ -z "$f" ]; then report "$n" escaped "$m is not a mount of its own"
  elif [ -z "$missing" ]; then report "$n" denied "$m is $f"
  else report "$n" escaped "$m is $f: missing$missing"; fi
done
root=$(flags_of /)
case ",$root," in *,ro,*) report mount.root denied "/ is $root" ;; *) report mount.root escaped "/ is $root" ;; esac
# Every mount whose source is a path of the host (a bind) is a piece of host trust; docker's own three files
# (/etc/hosts, /etc/hostname, /etc/resolv.conf) are the ones a container always has.
binds=$(awk '$2 !~ "^/(proc|sys|dev)(/|$)" && $2 != "/" && $2 !~ "^/(work|tmp|build)$" && $2 !~ "^/etc/(hosts|hostname|resolv.conf)$" { print $2 }' /proc/mounts | tr '\n' ' ')
if [ -z "$binds" ]; then report mount.binds denied "no mount of a host path"; else report mount.binds escaped "mounts beyond the containment: $binds"; fi

# ---- privilege -------------------------------------------------------------------------------------------------
uid=$(id -u)
if [ "$uid" != 0 ]; then report priv.uid denied "uid $uid"; else report priv.uid escaped "running as root"; fi

caps=$(awk '/^Cap(Eff|Prm|Bnd|Inh|Amb):/ { printf "%s%s ", $1, $2 }' /proc/self/status)
if awk '/^Cap(Eff|Prm|Bnd|Inh|Amb):/ { print $2 }' /proc/self/status | grep -qE '[1-9a-f]'; then report priv.caps escaped "capabilities held: $caps"; else report priv.caps denied "every capability set is empty"; fi

deny priv.userns "unshare a user namespace" unshare -Ur true
deny priv.mountns "unshare a mount namespace" unshare -m true
deny priv.netns "unshare a network namespace" unshare -n true
deny priv.mount "mount a tmpfs" mount -t tmpfs none /mnt
deny priv.sysrq "write /proc/sysrq-trigger" sh -c 'echo h > /proc/sysrq-trigger'
deny priv.sysfs "write under /sys" sh -c 'echo 1 > /sys/kernel/mm/transparent_hugepage/enabled'
deny priv.kmsg "read the kernel log" sh -c 'test -e /dev/kmsg && head -c 1 /dev/kmsg'
deny priv.disk "open a block device" sh -c 'ls /dev/sd* /dev/vd* /dev/nvme* /dev/dm-* 2>/dev/null | grep -q .'

pids=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l | tr -d ' ')
if [ "$pids" -lt 64 ]; then report priv.pidns denied "$pids processes visible: a pid namespace of its own"; else report priv.pidns escaped "$pids processes visible: the host's pid namespace"; fi

# ---- credentials -----------------------------------------------------------------------------------------------
cred='TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE'
names=$(env | cut -d= -f1 | grep -iE "$cred" | tr '\n' ' ')
if [ -z "$names" ]; then report cred.env denied "no credential-shaped name in the environment"; else report cred.env escaped "environment carries: $names"; fi

if [ -r /proc/1/environ ]; then
  pid1=$(tr '\0' '\n' < /proc/1/environ | cut -d= -f1 | grep -iE "$cred" | tr '\n' ' ')
  if [ -z "$pid1" ]; then report cred.init denied "the init process's environment carries no credential-shaped name"; else report cred.init escaped "pid 1 carries: $pid1"; fi
else report cred.init denied "the init process's environment is not readable"; fi

found=""
for f in /root/.ssh /root/.netrc /root/.docker/config.json /root/.aws /root/.config/gh /root/.npmrc /root/.git-credentials \
         "$HOME/.ssh" "$HOME/.netrc" "$HOME/.docker/config.json" "$HOME/.aws" "$HOME/.config/gh" "$HOME/.npmrc" "$HOME/.git-credentials" \
         /run/secrets /var/run/secrets /work/.git /work/.env /work/.npmrc /home/runner /github /host /mnt/host \
         "${CARGO_HOME:-/usr/local/cargo}/credentials" "${CARGO_HOME:-/usr/local/cargo}/credentials.toml"; do
  [ -e "$f" ] && found="$found $f"
done
if [ -z "$found" ]; then report cred.files denied "no key, token, netrc, registry login, checkout history or runner path"; else report cred.files escaped "present:$found"; fi

deny cred.shadow "read /etc/shadow" sh -c 'head -c 1 /etc/shadow'

# ---- the summary -----------------------------------------------------------------------------------------------
printf '{"summary":true,"total":%d,"denied":%d,"escaped":%d}\n' "$total" "$((total - escaped))" "$escaped"
[ "$escaped" -eq 0 ]
