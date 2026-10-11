# Deploying the authoritative host

This folder runs the Phase 12/14 host on a server, behind TLS: the room the game joins with `net join`, and the ledger
door Crimson Noir OS runtimes sync with. The bootable OS image is not part of this: it has no network code, and its
configuration refuses one.

| File | What it is |
|---|---|
| `../Dockerfile` | The host's image: distroless Node 24 and the 27 files the host runs, about 55 MB compressed |
| `docker-compose.yml` | The host and an nginx TLS proxy; only the proxy is reachable, and the host has no route out |
| `deploy-live.sh` | The one-touch start on an Ubuntu or Debian server: packages, secret, certificate, containers, renewals |
| `nginx.conf` | The proxy: `wss://` in, `ws://` to the host, with per-client limits and an origin check |
| `bridge-tunnel.conf` | For each client machine: carries its loopback-only connection to the proxy over verified TLS |

## Topology

```
client machine                                   server
game page / OS runtime ─ws:8787─▶ tunnel ═wss:443═▶ proxy (nginx, uid 101) ─ws:8787─▶ host (node, uid 65532)
      (127.0.0.1 only)            (nginx)            networks: edge + backend         network: backend only
```

- **Clients connect to 127.0.0.1 only, by design.**
  - The game page's loopback gate and content policy refuse every other address.
  - An OS runtime's bridge has no TLS and looks up no names.
  - So each client machine runs `bridge-tunnel.conf`: a local nginx that carries the connection to the proxy over
    TLS, checking the certificate.
- **The `backend` network is `internal`, with an isolated gateway.** It has no published port and no route out, and
  its gateway address is not the server's own stack (`gateway_mode_ipv4: isolated`, Docker 28+; `deploy-live.sh`
  adds the same cut with iptables for an older engine): the host can answer the proxy and reach nothing else, not
  even a service the server binds on 0.0.0.0.
  - A shared network namespace would keep the host on 127.0.0.1. But when the namespace's owner restarts, the other
    container is silently cut off.
- **The proxy has no route out either, nor into the server.** Its network does not masquerade, so nothing started
  inside the proxy reaches the internet; `deploy-live.sh` also closes the embedded resolver's path and new
  connections from the proxy into the server's own stack at the firewall. Its upstream is the host on `backend`, and
  the ACME challenge comes in.
- **Both containers are locked down:**
  - a read-only root (the proxy's `/tmp` is a 64 MB tmpfs);
  - all capabilities dropped and `no-new-privileges`;
  - pids, memory (swap included) and CPU limits;
  - rotated logs.
- **The host's files belong to root** and are read-only to it.

## One-touch start (`deploy-live.sh`)

On a plain Ubuntu or Debian server, as root, from this folder:

```sh
sudo ./deploy-live.sh ledger.example.com admin@example.com            # a public name: Let's Encrypt
sudo ./deploy-live.sh ledger.example.com admin@example.com --staging  # a rehearsal against the staging CA
sudo ./deploy-live.sh --self-signed                                   # a local or test machine
```

The script does every step below itself, and checks before each one, so it can be run again at any time:
1. It installs docker, the compose plugin, openssl and certbot from the distribution's own packages. Nothing is
   fetched from a third-party repository or piped into a shell.
2. It keeps this folder root-only (0700). The secret and the key are owned by the containers' users, uids that may
   belong to unrelated accounts on the server, and those accounts cannot enter the folder. (The mounted `tls/` and
   `acme/` folders themselves are 0755: a mounted folder keeps its own mode inside the container, and the proxy's
   user must be able to enter them.)
3. It makes the host's secret once (`secrets/net_secret`, uid 65532, 0400).
4. It gives the proxy a certificate to start with: the Let's Encrypt one if it already exists, else a self-signed one
   good for 30 days.
5. It opens 80 and 443 in ufw when ufw is active, builds the image and starts the containers, and waits until the
   proxy answers 426 on 443.
6. For a public name, it asks Let's Encrypt for the certificate through the running proxy (the ACME webroot on
   port 80), installs it, reloads the proxy, and installs `/etc/letsencrypt/renewal-hooks/deploy/crimson-noir.sh`,
   so certbot's own timer renews it and reloads the proxy. If the name does not resolve to the server yet, the
   self-signed certificate stays, and the script says to run again once DNS points there.

Behind a proxy that inspects TLS, set `BUILD_CA_FILE=/path/to/its-ca.pem`: compose cannot pass a build secret, so
the script builds the image itself with that CA.

**What was checked:** the script ran three times here: in self-signed mode; in Let's Encrypt mode with a stand-in
`certbot` on PATH that issues a test CA's certificate (the issuance, install, reload and hook paths all ran, and the
hook was then run by hand with `RENEWED_LINEAGE` set: it installed the files and reloaded the proxy, and ignored
another lineage); and again, idempotently. A real Let's Encrypt issuance needs a public name and was not run here.

## By hand

The same steps, for another distribution or for reading:

```sh
# 1. The secret every token is signed with. It is readable by the host's user only and is never an environment
#    variable, so `docker inspect` cannot show it.
mkdir -p secrets && openssl rand -hex 32 > secrets/net_secret
chown 65532:65532 secrets/net_secret && chmod 0400 secrets/net_secret

# 2. The first certificate, while nothing listens on port 80, then a copy readable by the proxy's user.
certbot certonly --standalone -d ledger.example.com
mkdir -p tls acme && chmod 0755 tls acme
install -m 0444 /etc/letsencrypt/live/ledger.example.com/fullchain.pem tls/fullchain.pem
install -o 101 -g 101 -m 0400 /etc/letsencrypt/live/ledger.example.com/privkey.pem tls/privkey.pem

# 3. Build and start.
docker compose up -d --build
docker compose ps          # the host turns "healthy", then the proxy starts
```

Keep the checkout in a directory only root can enter (`chmod 0700`). **Renewals:** once the proxy is up, it serves the
ACME challenge on port 80. Switch certbot to the webroot, with a hook that copies the files and reloads the proxy:

```sh
certbot certonly --webroot -w /srv/crimson-noir/deploy/acme -d ledger.example.com --deploy-hook \
  'install -m 0444 "$RENEWED_LINEAGE/fullchain.pem" /srv/crimson-noir/deploy/tls/fullchain.pem &&
   install -o 101 -g 101 -m 0400 "$RENEWED_LINEAGE/privkey.pem" /srv/crimson-noir/deploy/tls/privkey.pem &&
   docker compose -f /srv/crimson-noir/deploy/docker-compose.yml exec -T proxy nginx -s reload'
```

A reload closes the old workers' WebSockets within 10 s (`worker_shutdown_timeout`), and clients reconnect.

**Ignored by git:** `secrets/`, `tls/` and `acme/`.

## Tokens

A token names one subject, and a second connection under the same subject replaces the first. Mint one per player and
one per OS runtime:

```sh
docker compose exec host /nodejs/bin/node tools/net/mint-token.mjs alice        # 24 h
docker compose exec host /nodejs/bin/node tools/net/mint-token.mjs os-runtime 8  # 8 h (at most 168)
```

- Only the token goes to standard output.
- The host prints none at start-up (`NET_PRINT_TOKEN=0`): its logs are kept, and a token in a log is a credential.
- A token cannot be revoked early. Changing `secrets/net_secret` and restarting the host
  (`docker compose restart host`) ends every token at once.

## The fleet's weights

The host keeps, for the fleet, only the ledger of the configuration's own scripted run: its seal (head, count and
weights digest) is pinned in `crimson_noir_os/containment.seal`, which the image carries (`NET_LEDGER_SEAL`). Any
other ledger that holds under the containment rules is answered `verified` with `kept: false`, so no token-holder can
replace what runtimes fetch. `cargo run -- seal` regenerates the file when `containment.nix` changes; a Rust test
holds the file equal to the run.

## Clients

On each client machine:

1. Put the proxy's name into `bridge-tunnel.conf` (twice).
2. Start it. The file's header has the commands for nginx, Docker on Linux, and Docker Desktop.
3. Connect through it:
   - **The game** (`dist/index.html`, opened as a file): `net join ws://127.0.0.1:8787 <token>`. A server that
     serves the file instead should send `Cross-Origin-Opener-Policy: same-origin` and
     `Cross-Origin-Embedder-Policy: require-corp` (what `npm run preview` sends), so the page is cross-origin
     isolated and shares its physics memory bridge with the worker (docs/zero-copy-bridge.md); the page loads
     nothing cross-origin, so the headers cost it nothing.
   - **A Crimson Noir OS runtime:** read the token without leaving it in the shell's history, then run the bridge:
     ```sh
     read -rs CRIMSON_TOKEN && export CRIMSON_TOKEN
     cargo run -- bridge ws://127.0.0.1:8787
     ```

## Limits to know

- **Per-client limits need clients' own addresses.** compose publishes IPv4 only, because Docker would hand every
  IPv6 client to nginx from one gateway address. Publish no AAAA record, or give the `edge` network IPv6 and nginx
  `[::]` listeners. Behind a load balancer, follow the real-IP comment in `nginx.conf`.
- **The host's own throttle keys on the address the proxy forwards.** `NET_TRUST_PROXY=1` (set in the compose file)
  makes the host read the client's address from the `X-Forwarded-For` header nginx writes, so one client's bad tokens
  throttle only that client. Set it only on a host every connection reaches through the proxy, as here: a client that
  could reach the host directly would name any address it liked. Good tokens are always admitted either way, and the
  proxy's access log has each client's real address.
- **The tunnel looks up the proxy's name once**, when it starts. Restart it if the server's address changes.
- **A host that crashes is restarted** by its policy; one stopped by hand (`docker stop`, `docker kill`) stays stopped
  until `docker compose up -d`, which is Docker's own rule.
- **Port 80's redirect reflects the request's Host header** (nginx's documented idiom). No client uses port 80, and a
  browser sends its own host, so nobody can be steered through it; it is noted here, not changed.

## What was checked

Run against this compose file with a throwaway CA, after the Phase 16 audit's fixes (eight attack agents and a
skeptic for each; `agent_handoff_state.md` lists every finding and its verdict):

- **Proxy status codes:**
  - a plain GET gets 426 with `Upgrade: websocket`;
  - another path gets 404, a POST 405, a foreign `Origin` 403;
  - `Origin: null` and no Origin reach the host, which answers 401 without a token;
  - port 80 redirects to https and serves the ACME path.
- **TLS:** 1.0 and 1.1 refused, 1.2 with a forward-secret AEAD cipher, 1.3 negotiated; tickets off, no compression,
  no early data, no HTTP/2; the certificate verifies and HSTS is sent.
- **The door under attack:** path, method, header and Origin variants, duplicate and smuggled headers, oversized
  and slow headers, an ACME traversal, an h2 preface, an SNI mismatch: each refused; no token in any log, and
  control bytes in a path or Origin are escaped in the access log.
- **The room:** a minted token joins over `wss://` and through the tunnel, and the welcome's seal verifies.
- **The OS runtime, through `bridge-tunnel.conf`:**
  - its scripted run's ledger (3,576 entries) verifies, and the host keeps it (the pinned run);
  - a fresh runtime adopts the weights bit-exact;
  - four tampered ledgers over the wire, and eight more from the audit, are refused;
  - an empty but lawful ledger is answered `verified` with `kept: false`, and the fetch after it still returns the
    pinned run.
- **A hostile host against the runtime's bridge:** every handshake, frame, JSON, seal, protocol and fetch attack
  ends the bridge with a reason within seconds; a ping flood, a dripped frame and an unbounded weights stream are
  cut by its message deadline and pool bound; host text reaches the terminal escaped.
- **Rate limits:** a burst of bad upgrades gets 429s, from nginx's per-client limit and from the host's own.
- **Restarts:** after a host restart, a join works again. A proxy stop finishes within its grace period.
- **The host container:**
  - uid 65532, every capability set empty, `no-new-privileges`, seccomp, a read-only root; its files are root's;
  - DNS and connections to the outside fail, and a listener on the server's own 0.0.0.0 is unreachable from it;
  - the image holds the 27 host files, the lock, the seal and the licences, and nothing else; no secret in any layer.
- **The proxy container:** uid 101, a read-only root, no connection out (`nc` to the internet is blocked) and none
  into a listener on the server's own 0.0.0.0, while its DNS and the published ports still work; `nginx -t` passes.
- **`deploy-live.sh`:** ran in self-signed mode, in Let's Encrypt mode with a stand-in certbot (issuance, install,
  reload and the renewal hook), and again unchanged; it refuses to act outside the deploy directory.
