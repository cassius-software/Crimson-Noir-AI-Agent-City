# Deploying the authoritative host

This folder runs the Phase 12/14 host on a server, behind TLS: the room the game joins with `net join`, and the ledger
door Crimson Noir OS runtimes sync with. The bootable OS image is not part of this: it has no network code, and its
configuration refuses one.

| File | What it is |
|---|---|
| `../Dockerfile` | The host's image: distroless Node 24 and the 27 files the host runs, about 55 MB compressed |
| `compose.yaml` | The host and an nginx TLS proxy; only the proxy is reachable, and the host has no route out |
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
- **The `backend` network is `internal`.** It has no published port and no route out: the host can answer the proxy
  and reach nothing else.
  - A shared network namespace would keep the host on 127.0.0.1. But when the namespace's owner restarts, the other
    container is silently cut off.
- **Both containers are locked down:**
  - a read-only root;
  - all capabilities dropped and `no-new-privileges`;
  - pids and memory limits;
  - rotated logs.
- **The host's files belong to root** and are read-only to it.

## First start

On a Linux server with Docker Engine and the compose plugin. Keep the checkout in a directory only root can enter,
for example `/srv/crimson-noir` with mode 0700, and run these as root:

```sh
# 1. The secret every token is signed with. It is readable by the host's user only and is never an environment
#    variable, so `docker inspect` cannot show it.
mkdir -p secrets && openssl rand -hex 32 > secrets/net_secret
chown 65532:65532 secrets/net_secret && chmod 0400 secrets/net_secret

# 2. The first certificate, while nothing listens on port 80, then a copy readable by the proxy's user.
certbot certonly --standalone -d ledger.example.com
mkdir -p tls acme
install -m 0444 /etc/letsencrypt/live/ledger.example.com/fullchain.pem tls/fullchain.pem
install -o 101 -g 101 -m 0400 /etc/letsencrypt/live/ledger.example.com/privkey.pem tls/privkey.pem

# 3. Build and start.
docker compose up -d --build
docker compose ps          # the host turns "healthy", then the proxy starts
```

**Why the 0700 directory:** the files are owned by uid 65532 and uid 101, as the containers need, and those numbers
may belong to unrelated accounts on the server. The containers read the files through their mounts. Host accounts
cannot enter the directory.

**Building behind a proxy that inspects TLS:** compose cannot pass a build secret. Build the image first, then start
without building:

```sh
docker build --secret id=build_ca,src=/path/to/proxy-ca.pem -t crimson-noir-host:local ..
docker compose up -d --no-build
```

**Renewals:** once the proxy is up, it serves the ACME challenge on port 80. Switch certbot to the webroot, with a
hook that copies the files and reloads the proxy:

```sh
certbot certonly --webroot -w /srv/crimson-noir/deploy/acme -d ledger.example.com --deploy-hook \
  'install -m 0444 "$RENEWED_LINEAGE/fullchain.pem" /srv/crimson-noir/deploy/tls/fullchain.pem &&
   install -o 101 -g 101 -m 0400 "$RENEWED_LINEAGE/privkey.pem" /srv/crimson-noir/deploy/tls/privkey.pem &&
   docker compose -f /srv/crimson-noir/deploy/compose.yaml exec -T proxy nginx -s reload'
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

## Clients

On each client machine:

1. Put the proxy's name into `bridge-tunnel.conf` (twice).
2. Start it. The file's header has the commands for nginx, Docker on Linux, and Docker Desktop.
3. Connect through it:
   - **The game** (`dist/index.html`, opened as a file): `net join ws://127.0.0.1:8787 <token>`.
   - **A Crimson Noir OS runtime:** read the token without leaving it in the shell's history, then run the bridge:
     ```sh
     read -rs CRIMSON_TOKEN && export CRIMSON_TOKEN
     cargo run -- bridge ws://127.0.0.1:8787
     ```

## Limits to know

- **Per-client limits need clients' own addresses.** compose publishes IPv4 only, because Docker would hand every
  IPv6 client to nginx from one gateway address. Publish no AAAA record, or give the `edge` network IPv6 and nginx
  `[::]` listeners. Behind a load balancer, follow the real-IP comment in `nginx.conf`.
- **The host's own throttle sees one address.** Behind the proxy, every client arrives from the same address. So one
  client's bad tokens can turn other clients' bad tokens into 429s. Good tokens are always admitted, and the proxy's
  access log has each client's real address.
- **The tunnel looks up the proxy's name once**, when it starts. Restart it if the server's address changes.

## What was checked

Run against this compose file with a throwaway CA, after the adversarial review's fixes:

- **Proxy status codes:**
  - a plain GET gets 426 with `Upgrade: websocket`;
  - another path gets 404, a POST 405, a foreign `Origin` 403;
  - `Origin: null` and no Origin reach the host, which answers 401 without a token;
  - port 80 redirects to https.
- **TLS:** TLS 1.1 is refused, TLS 1.3 is negotiated, the certificate verifies, and HSTS is sent.
- **The room:** a minted token joins through the proxy, and the welcome's seal verifies.
- **The OS runtime, through `bridge-tunnel.conf`:**
  - the scripted run's ledger (3,576 entries) verifies;
  - a fresh runtime adopts the weights bit-exact;
  - four tampered ledgers are refused.
- **Rate limits:** a burst of bad upgrades gets 429s, from nginx's per-client limit and from the host's own.
- **Restarts:** after a host restart, a join works again. A proxy stop finishes within its grace period.
- **The host container:**
  - DNS and connections to the outside fail;
  - it runs as uid 65532 on a read-only root, and its files are owned by root;
  - the proxy runs as uid 101, and `nginx -t` passes.
- **The review's attacks were refused:** path, method, header and Origin variants, oversized and slow headers, an h2
  ALPN offer, and an SNI mismatch. Neither the proxy's nor the host's log ever holds a token.
