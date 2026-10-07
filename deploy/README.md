# Deploying the authoritative host

This folder runs the Phase 12/14 host (the room for `net join`, and the ledger door for Crimson Noir OS runtimes) on a
server, behind TLS. The bootable OS image is not part of this: it has no network code, and its configuration refuses one.

| File | What it is |
|---|---|
| `../Dockerfile` | The host's image: distroless Node 24 and the 27 files the host runs, about 55 MB compressed |
| `compose.yaml` | The host and an nginx TLS proxy; only the proxy is reachable, and the host has no route out |
| `nginx.conf` | The proxy: `wss://` in, `ws://` to the host, with an origin check and per-client limits |
| `bridge-tunnel.conf` | For an OS runtime's machine: carries its loopback-only bridge to the proxy over verified TLS |

## Topology

```
browser / OS runtime ──wss:443──▶ proxy (nginx, uid 101) ──ws:8787, internal network──▶ host (node, uid 65532)
                                  networks: edge + backend                              network: backend only
```

- **The `backend` network is `internal`.** It has no published port and no route out. The host can answer the proxy
  and reach nothing else: a DNS lookup or a connection out from the host fails.
- **Why not one shared network namespace?** A shared namespace would keep the host on 127.0.0.1. But if the
  namespace's owner restarts, the other container is silently cut off.
- **Both containers are locked down:**
  - a read-only root filesystem;
  - all capabilities dropped and `no-new-privileges`;
  - pids and memory limits;
  - rotated logs.
- **The host's files belong to root** and are read-only to it.

## First start

On a Linux server with Docker Engine and the compose plugin, from this folder:

```sh
# 1. The secret every token is signed with. It is readable by the host's user only and is never an environment
#    variable, so `docker inspect` cannot show it.
mkdir -p secrets && openssl rand -hex 32 > secrets/net_secret
sudo chown 65532:65532 secrets/net_secret && sudo chmod 0400 secrets/net_secret

# 2. The certificate for the proxy's name (for example from Let's Encrypt), readable by the proxy's user.
mkdir -p tls acme
sudo cp /etc/letsencrypt/live/ledger.example.com/fullchain.pem tls/fullchain.pem
sudo cp /etc/letsencrypt/live/ledger.example.com/privkey.pem tls/privkey.pem
sudo chown 101:101 tls/privkey.pem && sudo chmod 0400 tls/privkey.pem

# 3. Build and start. Behind a proxy that inspects TLS, the build needs its CA: see the Dockerfile.
docker compose up -d --build
docker compose ps          # the host turns "healthy", then the proxy starts
```

**Renewals:** `certbot certonly --webroot -w ./acme -d ledger.example.com` works through port 80. After a renewal,
copy the files again and run `docker compose exec proxy nginx -s reload`.

**Logs:** `secrets/`, `tls/` and `acme/` are ignored by git. The host prints no token here (`NET_PRINT_TOKEN=0`): its
logs are kept, and a token in a log is a credential.

## Tokens

A token names one subject, and a second connection under the same subject replaces the first. Mint one per player
and one per OS runtime:

```sh
docker compose exec host /nodejs/bin/node tools/net/mint-token.mjs alice        # 24 h
docker compose exec host /nodejs/bin/node tools/net/mint-token.mjs os-runtime 8  # 8 h (at most 168)
```

Only the token goes to standard output. A token cannot be revoked early. Changing `secrets/net_secret` and restarting
the host (`docker compose restart host`) ends every token at once.

## Clients

- **The game (`dist/index.html`):** `net join wss://ledger.example.com <token>`. A page opened as a file sends
  `Origin: null`, which the proxy admits. If you serve the page from a site, add that origin to the map in
  `nginx.conf`.
- **A Crimson Noir OS runtime:** its bridge speaks `ws://` to its own machine only, with no TLS and no name lookups.
  On the runtime's machine:
  1. Put the proxy's name into `bridge-tunnel.conf` (twice).
  2. Run it with nginx, for example
     `docker run -d --network host -v "$PWD/bridge-tunnel.conf:/etc/nginx/nginx.conf:ro" nginxinc/nginx-unprivileged:stable-alpine`.
  3. Then run:
     ```sh
     CRIMSON_TOKEN=<token> cargo run -- bridge ws://127.0.0.1:8787
     ```

  The tunnel checks the proxy's certificate against the system's roots and its name. The token stays the only
  credential, end to end.

## What was checked

Run against this compose file, with a test CA:

- **Proxy status codes:**
  - a plain GET gets 426, another path 404, a POST 405;
  - a foreign `Origin` gets 403;
  - `Origin: null` and no Origin reach the host, which answers 401 without a token;
  - port 80 redirects to https and serves the ACME path.
- **TLS:** TLS 1.1 is refused, TLS 1.3 is negotiated, the certificate verifies, and HSTS is sent.
- **The room:** a minted token joins over `wss://`, and the welcome's seal verifies.
- **The OS runtime, through `bridge-tunnel.conf`:**
  - its scripted run's ledger (3,576 entries) verifies;
  - a fresh runtime adopts the weights bit-exact;
  - four tampered ledgers are refused.
- **Rate limits:** 40 bad upgrades in a burst got 429s, from nginx's per-client limit and from the host's own.
- **Restarts:** after `docker compose restart host`, a join works again.
- **The host container:**
  - its DNS and a connection to an outside address both fail;
  - it runs as uid 65532 on a read-only root;
  - the proxy runs as uid 101, and `nginx -t` passes.
