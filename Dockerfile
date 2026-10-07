# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# (The one name that check matches is NET_PRINT_TOKEN, a 0/1 switch; no secret is ever an ARG or ENV here.)
# Why does this file exist? It builds the container image of the authoritative host (src/10_Network/replication.node.ts:
# the Phase 12 room and the Phase 14 ledger door), kept as small as the host allows. It holds Node and the 27 files
# the host runs, and nothing else: no shell, no package manager, no page code. deploy/compose.yaml runs it behind the
# TLS proxy (deploy/nginx.conf).
# - The base images are pinned by digest, so a build gets the same bytes until someone moves the pin on purpose.
# - The host's one package is installed from package-lock.json (its integrity hashes) with no install scripts run.
# - tools/net/closure.mjs follows the host's imports the way Node does and copies exactly those files.
# - /app belongs to root and is read-only to the host, which runs as the distroless image's nonroot user (65532).
# - The image's own Node starts the host from /app alone before the image can exist (tools/net/image-check.mjs).
# - In the image the host listens on 127.0.0.1 (the compose file moves it to an internal network the proxy shares), it
#   prints no token (its logs are kept: mint tokens with tools/net/mint-token.mjs), and SIGINT stops it cleanly.
# Build: docker build -t crimson-noir-host .
# What breaks if it is removed? The host can still run with `npm run serve:net`, but it has no image to deploy.

ARG BUILD_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

# 1. The production dependencies, installed from the lockfile, with no install scripts run. Behind a proxy that inspects
#    TLS, pass its CA as a build secret (docker build --secret id=build_ca,src=ca.pem); it is never kept in a layer.
FROM ${BUILD_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# 2. Exactly the files the host and the token tool run, copied into /app with the lock and the licences.
FROM ${BUILD_IMAGE} AS closure
WORKDIR /src
COPY --from=deps /src/node_modules ./node_modules
COPY LICENSE NOTICE.md ./
COPY src ./src
COPY tools/net/closure.mjs tools/net/mint-token.mjs ./tools/net/
COPY crimson_noir_os/containment.lock ./crimson_noir_os/
RUN node --no-warnings tools/net/closure.mjs src/10_Network/replication.node.ts tools/net/mint-token.mjs --into /app \
 && cp LICENSE NOTICE.md /app/ \
 && mkdir -p /app/crimson_noir_os && cp crimson_noir_os/containment.lock /app/crimson_noir_os/ \
 && printf '{ "private": true, "type": "module" }\n' > /app/package.json

# 3. The host: Node and /app.
FROM ${RUNTIME_IMAGE} AS host
COPY --from=closure /app /app
WORKDIR /app
ENV NET_HOST=127.0.0.1 \
    NET_PORT=8787 \
    NET_PRINT_TOKEN=0 \
    NET_LEDGER_LOCK=/app/crimson_noir_os/containment.lock
USER 65532:65532
STOPSIGNAL SIGINT
# A plain request is answered 426 (Upgrade Required) and costs the host nothing: that answer is health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "require('node:http').get({host:'127.0.0.1',port:process.env.NET_PORT||8787,path:'/',timeout:4000},r=>process.exit(r.statusCode===426?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"]
LABEL org.opencontainers.image.title="crimson-noir-host" \
      org.opencontainers.image.description="The authoritative host of Crimson Noir AI Agent City: the room and the ledger door" \
      org.opencontainers.image.source="https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City" \
      org.opencontainers.image.licenses="LicenseRef-ONYX"
CMD ["src/10_Network/replication.node.ts"]

# 4. The proof: the image as built starts the host, opens its ledger door on the lock, and mints a token.
FROM host AS checked
COPY tools/net/image-check.mjs /tmp/image-check.mjs
RUN ["/nodejs/bin/node", "/tmp/image-check.mjs"]

# 5. The image as shipped: the host, reached only through the proof (whose start-up lines it keeps).
FROM host
COPY --from=checked /tmp/image-checked /app/.image-checked
