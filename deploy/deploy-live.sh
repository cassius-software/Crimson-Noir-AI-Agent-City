#!/bin/bash
# Why does this file exist? It is the one-touch deployment of the authoritative host on a plain Ubuntu (or Debian)
# server: the packages, the secret, the certificate, the two containers (docker-compose.yml), and the renewal that
# keeps the certificate alive. Run it again whenever you like: every step checks before it acts.
#   sudo ./deploy-live.sh ledger.example.com admin@example.com            # a public name, Let's Encrypt
#   sudo ./deploy-live.sh ledger.example.com admin@example.com --staging  # Let's Encrypt's staging CA, for a rehearsal
#   sudo ./deploy-live.sh --self-signed                                   # a local or test machine, no public name
# What it does, in order:
# 1. Installs docker, the compose plugin, openssl and (for a public name) certbot from the distribution's own
#    packages: nothing is fetched from a third-party repository or piped into a shell.
# 2. Keeps this directory to root (0700): the secret and the key are owned by the containers' users, uids that may
#    belong to unrelated accounts on this machine, and those accounts cannot enter it.
# 3. Makes the host's HMAC secret once (secrets/net_secret, uid 65532, 0400). It never goes into an environment variable.
# 4. Gives the proxy a certificate to start with: the real one if it is already there, else a self-signed one.
# 5. Opens 80 and 443 in ufw when ufw is active, and starts the containers.
# 6. For a public name: asks Let's Encrypt for the certificate through the running proxy (the ACME webroot on port
#    80), installs it for the proxy's user, reloads the proxy, and installs a renewal hook so certbot's own timer keeps
#    it renewed and the proxy reloaded. A name that does not resolve here yet leaves the self-signed certificate in
#    place; run the script again once DNS points at this machine.
# Behind a proxy that inspects TLS, set BUILD_CA_FILE=/path/to/its-ca.pem: the image is then built here with that CA
# as a build secret (compose cannot pass one). No secret or token is ever printed.
# What breaks if it is removed? Nothing; deploy/README.md has the steps by hand.
set -euo pipefail

usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 2; }

DOMAIN=''
EMAIL=''
STAGING=''
SELF_SIGNED=''
for arg in "$@"; do
    case "$arg" in
        --staging) STAGING='--staging' ;;
        --self-signed) SELF_SIGNED=1 ;;
        -h|--help) usage ;;
        -*) echo "unknown option $arg" >&2; usage ;;
        *) if [ -z "$DOMAIN" ]; then DOMAIN=$arg; elif [ -z "$EMAIL" ]; then EMAIL=$arg; else usage; fi ;;
    esac
done
if [ -n "$SELF_SIGNED" ]; then
    [ -z "$EMAIL" ] || usage
    DOMAIN=${DOMAIN:-localhost}
else
    [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || usage
    case "$DOMAIN" in *[!A-Za-z0-9.-]*|-*|.*|*..*) echo "'$DOMAIN' is not a host name" >&2; exit 2 ;; esac
fi
[ "$(id -u)" -eq 0 ] || { echo "run this as root (sudo): it installs packages and owns the secrets" >&2; exit 2; }
command -v apt-get > /dev/null || { echo "this script installs from apt; on another distribution follow README.md" >&2; exit 2; }

# The deploy directory is where this script really lives (a symlink to it is followed), and it must hold the stack's
# files before anything here is owned or locked: a copy of the script in a PATH directory must not lock that directory.
DEPLOY=$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)
[ -f "$DEPLOY/docker-compose.yml" ] && [ -f "$DEPLOY/nginx.conf" ] || { echo "$DEPLOY is not the deploy directory (no docker-compose.yml and nginx.conf there)" >&2; exit 2; }
COMPOSE=(docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml")
say() { printf '\n== %s\n' "$*"; }

# 1. Packages, from the distribution.
say "packages"
needed=()
command -v docker > /dev/null || needed+=(docker.io)
docker compose version > /dev/null 2>&1 || needed+=(docker-compose-v2)
command -v openssl > /dev/null || needed+=(openssl)
if [ -z "$SELF_SIGNED" ] && ! command -v certbot > /dev/null; then needed+=(certbot); fi
if [ "${#needed[@]}" -gt 0 ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q --no-install-recommends "${needed[@]}"
else
    echo "already installed"
fi
if [ -d /run/systemd/system ] && command -v systemctl > /dev/null; then
    systemctl enable --now docker > /dev/null 2>&1 || true
fi
docker info > /dev/null 2>&1 || { echo "the docker daemon is not running; start it and run this again" >&2; exit 1; }
docker compose version > /dev/null 2>&1 || { echo "'docker compose' is missing: install the compose plugin, then run this again" >&2; exit 1; }

# 2. This directory is root's.
say "permissions"
chown root:root "$DEPLOY"
chmod 0700 "$DEPLOY"
mkdir -p "$DEPLOY/secrets" "$DEPLOY/tls" "$DEPLOY/acme"
# A mounted directory keeps its own mode inside the container, so tls/ and acme/ must let the proxy's user in;
# this directory's 0700 is what keeps the machine's other accounts out of them.
chmod 0700 "$DEPLOY/secrets"
chmod 0755 "$DEPLOY/tls" "$DEPLOY/acme"
echo "$DEPLOY is 0700, root only"

# 3. The secret, once.
say "secret"
if [ ! -s "$DEPLOY/secrets/net_secret" ]; then
    (umask 077 && openssl rand -hex 32 > "$DEPLOY/secrets/net_secret")
    echo "made secrets/net_secret"
else
    echo "secrets/net_secret is kept (change it to end every token at once)"
fi
chown 65532:65532 "$DEPLOY/secrets/net_secret"
chmod 0400 "$DEPLOY/secrets/net_secret"

# The certificate files as the proxy's user reads them.
install_cert() {
    install -m 0444 "$1" "$DEPLOY/tls/fullchain.pem"
    install -o 101 -g 101 -m 0400 "$2" "$DEPLOY/tls/privkey.pem"
}

# 4. A certificate to start with.
say "certificate to start with"
LINEAGE="/etc/letsencrypt/live/$DOMAIN"
if [ -z "$SELF_SIGNED" ] && [ -s "$LINEAGE/fullchain.pem" ] && [ -s "$LINEAGE/privkey.pem" ]; then
    install_cert "$LINEAGE/fullchain.pem" "$LINEAGE/privkey.pem"
    rm -f "$DEPLOY/tls/.self-signed"
    echo "installed the Let's Encrypt certificate already issued for $DOMAIN"
elif [ -s "$DEPLOY/tls/fullchain.pem" ] && [ -s "$DEPLOY/tls/privkey.pem" ] && [ ! -e "$DEPLOY/tls/.self-signed" ]; then
    chown 101:101 "$DEPLOY/tls/privkey.pem"
    chmod 0400 "$DEPLOY/tls/privkey.pem"
    chmod 0444 "$DEPLOY/tls/fullchain.pem"
    echo "tls/ already holds a certificate; kept"
else
    tmp=$(mktemp -d)
    san="DNS:$DOMAIN"
    [ "$DOMAIN" = localhost ] && san="DNS:localhost,IP:127.0.0.1"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=$san" -keyout "$tmp/privkey.pem" -out "$tmp/fullchain.pem" 2> /dev/null
    install_cert "$tmp/fullchain.pem" "$tmp/privkey.pem"
    rm -rf "$tmp"
    : > "$DEPLOY/tls/.self-signed"
    echo "a self-signed certificate for $DOMAIN, good for 30 days, so the proxy can start"
fi

# 5. The firewall, and the containers.
say "containers"
if command -v ufw > /dev/null && ufw status 2> /dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp > /dev/null
    ufw allow 443/tcp > /dev/null
    echo "ufw: 80 and 443 allowed"
fi
if [ -n "${BUILD_CA_FILE:-}" ]; then
    docker build --secret "id=build_ca,src=$BUILD_CA_FILE" -t crimson-noir-host:local "$DEPLOY/.."
    "${COMPOSE[@]}" up -d --no-build
else
    "${COMPOSE[@]}" up -d --build
fi
# Where the proxy was published (the compose file's port, whatever it is), then the two cuts the compose file cannot
# make by itself: the host's network must not reach this machine's own listeners (an engine older than 28 ignores
# the gateway_mode option), and the proxy's network must not start connections out (its resolver still forwards).
published=$("${COMPOSE[@]}" port proxy 8443 2> /dev/null | tail -n 1)
port=${published##*:}
[ -n "$port" ] || port=443
if command -v iptables > /dev/null; then
    backend=$(docker network inspect "$(basename "$DEPLOY")_backend" -f '{{.Id}}' 2> /dev/null | cut -c1-12 || true)
    edge=$(docker network inspect "$(basename "$DEPLOY")_edge" -f '{{.Id}}' 2> /dev/null | cut -c1-12 || true)
    # Compose names its networks after the project, which the compose file sets to crimson-noir.
    backend=$(docker network inspect crimson-noir_backend -f '{{.Id}}' 2> /dev/null | cut -c1-12 || echo "$backend")
    edge=$(docker network inspect crimson-noir_edge -f '{{.Id}}' 2> /dev/null | cut -c1-12 || echo "$edge")
    if [ -n "$backend" ]; then
        iptables -C INPUT -i "br-$backend" -j DROP 2> /dev/null || iptables -I INPUT -i "br-$backend" -j DROP
    fi
    if [ -n "$edge" ]; then
        # The proxy's network starts no connection into this machine's own stack (inbound published traffic is
        # forwarded, not delivered here, and the embedded resolver lives inside the container's namespace)...
        iptables -C INPUT -i "br-$edge" -m conntrack --ctstate NEW -j DROP 2> /dev/null || iptables -I INPUT -i "br-$edge" -m conntrack --ctstate NEW -j DROP
        # ...nor out to the internet (the network does not masquerade; this also closes the resolver's forwarding).
        if iptables -L DOCKER-USER -n > /dev/null 2>&1; then
            iptables -C DOCKER-USER -i "br-$edge" -m conntrack --ctstate NEW ! -d 172.16.0.0/12 -j DROP 2> /dev/null \
                || iptables -I DOCKER-USER -i "br-$edge" -m conntrack --ctstate NEW ! -d 172.16.0.0/12 -j DROP
        fi
    fi
    echo "firewall: neither container's network reaches a listener of this machine; the proxy's starts no connection out"
fi
ready=''
for _ in $(seq 1 60); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --noproxy '*' "https://127.0.0.1:$port/" 2> /dev/null || true)
    if [ "$code" = 426 ]; then ready=1; break; fi
    sleep 2
done
if [ -z "$ready" ]; then
    echo "the proxy did not answer on $port within two minutes:" >&2
    "${COMPOSE[@]}" ps >&2
    "${COMPOSE[@]}" logs --tail 40 >&2
    exit 1
fi
echo "the proxy answers on $port (426 to a plain request: the door is a WebSocket upgrade)"

# 6. Let's Encrypt, through the running proxy, and its renewal.
if [ -z "$SELF_SIGNED" ]; then
    say "Let's Encrypt for $DOMAIN"
    HOOK=/etc/letsencrypt/renewal-hooks/deploy/crimson-noir.sh
    mkdir -p "$(dirname "$HOOK")"
    cat > "$HOOK" <<EOF
#!/bin/sh
# Installed by deploy-live.sh: after certbot renews $DOMAIN, the proxy gets the new files and reloads.
set -eu
[ "\$(basename "\$RENEWED_LINEAGE")" = "$DOMAIN" ] || exit 0
install -m 0444 "\$RENEWED_LINEAGE/fullchain.pem" "$DEPLOY/tls/fullchain.pem"
install -o 101 -g 101 -m 0400 "\$RENEWED_LINEAGE/privkey.pem" "$DEPLOY/tls/privkey.pem"
docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml" exec -T proxy nginx -s reload
EOF
    chmod 0755 "$HOOK"
    if certbot certonly --webroot -w "$DEPLOY/acme" -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive \
        --keep-until-expiring $STAGING; then
        install_cert "$LINEAGE/fullchain.pem" "$LINEAGE/privkey.pem"
        rm -f "$DEPLOY/tls/.self-signed"
        "${COMPOSE[@]}" exec -T proxy nginx -s reload
        echo "the proxy serves the Let's Encrypt certificate; certbot's timer renews it and $HOOK reloads the proxy"
    else
        echo "certbot could not issue a certificate for $DOMAIN (DNS not pointing here yet, or port 80 unreachable)." >&2
        echo "The proxy is up with a self-signed certificate. Run this script again once $DOMAIN resolves to this machine." >&2
        exit 1
    fi
fi

say "done"
"${COMPOSE[@]}" ps
cat <<EOF

Mint a token per player or OS runtime (only the token goes to standard output):
  docker compose --project-directory $DEPLOY exec host /nodejs/bin/node tools/net/mint-token.mjs NAME [HOURS]
Clients connect through bridge-tunnel.conf on their own machine (see README.md here).
EOF
