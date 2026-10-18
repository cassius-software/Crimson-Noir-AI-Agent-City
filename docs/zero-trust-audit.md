# Zero-trust containment: the audit

Phase 11.1, under the operator's order: "Ensure all API routing is mathematically locked to localhost. Sever any
arbitrary outbound fetch capabilities." This supersedes the Phase 8.3 and 10.2 orders that let the Claude provider and
`net join` leave the machine. File paths are relative to `src/`.

The question asked of every file in `02_Define_The_Rules` and `09_Cognition`, and of the operator `run` sandbox they
feed (`07_Execute_Actions/operator.ts`), was: through what could a prompt, a key, a token, a pose or anything else on
the page reach a server off this machine? For each vector: where it is, what it could reach, and what closes it.
The last section is honest about what cannot be closed from the page's scripts.

## The one principle

A script run by `run <skill>: <js>` is compiled with `new AsyncFunction(...)` (`operator.ts compile`). It therefore
runs in the page's own realm: it shares the page's global object, its `fetch`, its `WebSocket`, its `localStorage`,
its `document`. The facade it is handed as `sim` is frozen and narrow, but the facade is not the sandbox's boundary;
the global object is. `operator.ts exec` says so in its own comment ("the isolation here is structural ... not a
security boundary"). So no check inside a client, however careful, contains a script: a script need not call the
client. The containment therefore has to be at the global level, and that is what `02_Define_The_Rules/airgap.ts
installAirgap` does: it is called before anything else in `main.tsx` and in `physics.worker.ts`, on each global, and
it replaces and freezes the outbound primitives themselves.

## The gate

`02_Define_The_Rules/airgap.ts`:

- `loopbackOnly(url)`: the origin of an http, https, ws or wss URL whose host is `localhost`, `127.0.0.0/8` (any
  spelling the URL parser reduces to it, `http://2130706433` included) or `[::1]`, with no user name or password; null
  for anything else. `loopbackServer` (http(s) only, origin) and `netServer` (ws(s) only, href with its path) are
  defined through it. `09_Cognition/localCompute.ts`, `09_Cognition/claudeApi.ts` and `10_Network/netClient.ts`
  re-export those names from the gate; the structural test checks that none of them parses a URL of its own.
- `installAirgap(g)`: on the global `g`, `fetch` (strings, `URL` objects, `Request` objects through the `url`
  getter captured at install time, relative URLs against the page's base), `WebSocket`, `EventSource`,
  `XMLHttpRequest.prototype.open` and `importScripts` are replaced by versions that admit a loopback URL, the page's
  own origin (so a relative URL under `npm run preview` still works; a page opened from a file has none) or a
  `blob:` or `data:` URL the page made, and refuse everything else with one sentence (`refusal(url)`).
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `WebTransport` and `navigator.sendBeacon` are removed (deleted up
  the prototype chain, then shadowed by a frozen `undefined`). Every touched property is then non-writable and
  non-configurable; the guarded constructors share the originals' prototypes, and `prototype.constructor` is
  repointed, so the originals are unreachable through them. It installs once per global and reports what it did.
- `loopbackFetch(fetchFn)`: a fetch that rejects anything off this machine before calling `fetchFn`. `App.tsx` hands
  the model and speech clients `window.fetch` under it, so a prompt is held to loopback by the client's own check, by
  this wrapper, and by the installed guard.

`02_Define_The_Rules/airgap.test.ts` proves all of it on a fake global in Node. `10_Network/airgap.test.ts` reads the
source: no runtime file names an address off this machine; every file that names an outbound primitive is in an
allowlist (`App.tsx`: the two `window.fetch` hand-offs, under `loopbackFetch`; `netClient.ts`: the one `new
WebSocket`, after `netServer`, and a `typeof RTCPeerConnection` presence check); each allowlisted site's enclosing
function names the gate; the gate itself imports nothing and defines every alias and the guard's admission through
`loopbackOnly`; and `main.tsx` and `physics.worker.ts` import the gate first and call `installAirgap(globalThis)` as
their first statement.

## 02_Define_The_Rules

| File, function | What it could reach | What closes it |
|---|---|---|
| `laws.ts` (the Bouncer), `ring0.ts` (the audit), `civic.ts`, `collision.ts`, `degrees.ts` | Nothing. Pure functions over numbers and frozen tables; no import above 02, no I/O, no global. `ring0.ts` runs in the worker and never sees a URL. | Nothing to close. `collision.test.ts` and `ring0.test.ts` pin the shapes; `simCore.ts`'s import list is checked by `bootloader.test.ts`. |
| `ring0Panic.ts` | `console.error` and the hardware bus (`disconnect`), on a panic. No network. | Nothing to close. |
| `conduct.ts screen`, `AGENT_SYSTEM_PROMPT_CORE` | Nothing; a pure lexicon over normalised text. Its verdict decides whether a prompt reaches a client at all (`operator.ts gatedAsk`, `gatedSay`), so a weakened lexicon would let more text out, but only to where the clients can send it. | The clients can send only to loopback (below). `conduct.test.ts` pins the lexicon. |
| `airgap.ts` itself | It holds the originals of the primitives in closures. A script cannot read a closure. The guard admits the page's own origin: a page served from a host off this machine (not the shipped way; `dist/index.html` is opened from a file or `npm run preview` on localhost) could reach that host. | The origin exception is deliberate (the page's own resources); `installAirgap` reports `own`, and the structural test does not depend on it. A deployment off this machine would narrow it by serving a Content-Security-Policy (below). |

The 02 stage has no outbound vector. Its contribution is the gate.

## 09_Cognition

| File, function | What it could reach | What closes it |
|---|---|---|
| `claudeApi.ts claudeAnswer`, `claudeModels` | Before: any https host, with the operator's key in `x-api-key`, the system prompt (the tethered people's skills and memories) and the prompt in the body. `ask server https://any.host` was enough; so was a saved `claude.server` in local storage (`civic-simulation:cognition:v2`), which `router.ts` reads at boot. This was the one place a key could leave the machine by design. | `claudeServer` is `loopbackServer`: http or https to loopback only, origin only. The default server is `CLAUDE_GATEWAY`, `http://localhost:8089`, a reverse proxy the operator runs. A saved server off this machine is dropped at boot and the default used. The `fetch` the client is handed is `loopbackFetch(window.fetch)`, and `window.fetch` is the guard's. `claudeApi.test.ts` flips every former acceptance of `https://api.anthropic.com` and `https://gateway.example.com` to a refusal and checks nothing was sent. |
| `claudeApi.ts headers` | The `anthropic-dangerous-direct-browser-access` header is still sent, so a transparent gateway can forward the request unchanged. It names no address. | Nothing to close; a gateway that adds the key itself may strip it. |
| `localCompute.ts generate`, `chat`, `installedModels`, `diagnose` | A loopback origin plus the API's own path. `diagnose` makes a `no-cors` probe of `${server}/api/version`. Before Phase 11.1 the check was this file's own; a copy that drifted would have been a second definition of "this machine". | `loopbackServer` is the gate's, re-exported; the structural test fails if this file parses a URL itself. `localCompute.test.ts` keeps its full table of accepted and refused addresses, now run against the gate. |
| `localCompute.ts createLocalCompute setServer`, the saved `server` | Same: a saved or typed address. | Both go through `loopbackServer`; an off-machine one is refused with the sentence the console prints. |
| `localSpeech.ts speak`, `voices`, `createLocalSpeech` | A loopback origin, `/v1/audio/speech` and `/v1/audio/voices`, with the line to be said. | `loopbackServer` from `localCompute.ts` (the gate's); the fetch is `loopbackFetch(window.fetch)`. |
| `localSpeech.ts synthesizeEleven`, `elevenVoices` (`say provider elevenlabs`, off by default) | A loopback origin (`http://localhost:8090` by default), `/v1/text-to-speech/<voice>` and `/v1/voices`, with the line to be said and, only if one was typed to `say key`, an `xi-api-key` header. | The same `loopbackServer`, checked again on every request (a saved server off this machine is replaced by the default when the settings are read); the fetch is the same guarded one. The key is masked in every status line and setting and kept as dots in `history` (`redactForHistory`); `localSpeech.test.ts` checks a request to `https://api.elevenlabs.io` is refused before anything is sent. |
| `router.ts createMindRouter` | The chosen provider's settings. `setModel` takes a free string, sent in the body to a loopback origin only. The key is set and masked here. | `setServer` for the Claude provider refuses anything `claudeServer` refuses; the error names the rule. `router.test.ts` checks every provider's request URL is loopback. |
| The key in local storage (`App.tsx COGNITION_KEY`) | Any script on the page's origin can read it. With an outbound primitive it would leave; without one it cannot. | The installed guard leaves a script no `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `sendBeacon`, `WebTransport` or `RTCPeerConnection` that reaches off this machine. The vectors the guard does not close (last section) remain the way out, and the README's advice stands: treat it as a testing key and clear it with `ask key none`. |

## The operator `run` sandbox (`07_Execute_Actions/operator.ts`)

| Where | What it could reach | What closes it |
|---|---|---|
| `compile`: `new AsyncFunction('sim', 'console', 'sleep', 'signal', ...)` | The page's realm: `globalThis`, `window`, `document`, `localStorage` (the key, the net token), `indexedDB` (the swarm's memory), every constructor. The `"use strict"` prefix and the four named parameters narrow nothing of that. | Not closable in `operator.ts` without a second realm (an iframe or a worker with no access to the page), which would also take `sim` away. The containment is `installAirgap` on the global: by the time a script runs, the outbound primitives are the guarded ones and cannot be restored (frozen, originals in closures). |
| `scriptApi`, `deepFreeze` | Only the validated facade: numbers, two mode names, cloned snapshots. A structural test pins that no member reaches the laws, the Bouncer, the Sanctuary or the nudge. | Already closed; unchanged. |
| `exec`: `sleep`, `signal`, the timeout | Timers only. A script that outlives its lease loses `sim`; it keeps the realm. | The realm's primitives are guarded regardless of the lease. |
| `gatedAsk`, `gatedSay` | The router and the speech client, with a screened prompt. | Both clients are loopback-only (above). |
| `askSet('server', ...)`, the console's `ask server` and `say server` | A typed address. | The provider's own `setServer`, through the gate. |

## 10_Network (the client the cognition stage shares its rule with)

| Where | What it could reach | What closes it |
|---|---|---|
| `netClient.ts connect` → `open(href, protocols)` → `new WebSocket(href, protocols)` | Before: wss to any host, carrying the session token in the first frame and then the player's walking input every frame. Since Phase 12 the token also rides the upgrade as a subprotocol (`auth.<token>`), and the inputs are the realm's steps and the pose they reached. | `netServer` is the gate's ws rule: ws or wss to `localhost` or `127.0.0.1` only (`ROOM_HOSTS`, exactly the socket sources of the page's `connect-src`; `02_Define_The_Rules/airgap.test.ts` fails if the two part in either direction). The default `open` checks `netServer` again before constructing the socket, and the socket constructor is the guard's. `netClient.test.ts` flips `wss://rooms.example.net` to a refusal; the Node host tests still drive a real socket to `127.0.0.1`. An authoritative server elsewhere (Phase 12) is reached only through a local end on this machine (a tunnel or a proxy), so the token and the poses leave the machine only through what the operator runs. |
| `netClient.ts offerVoice` | A `RTCPeerConnection` would carry media to a peer directly, outside every URL-based rule (a Content-Security-Policy cannot see it either, short of CSP3's `webrtc 'block'`). The scaffold never constructs one. | `installAirgap` removes `RTCPeerConnection` from the global; the stub reports it absent. |
| `terminal/commands.ts net` | A `ws(s)://` syntax check only, then the bridge. The terminal imports only types, so it cannot import the gate's value. | The client decides (`netServer`), and its refusal is what the console prints. |
| `replication.node.ts`, `mirror.node.ts` | Node-only, never bundled; the host listens, it does not connect, and its mirror (Phase 12) is a physics world of its own on the server. The host upgrades no connection without a token whose HMAC and expiry hold (401 before any socket; 429 for an address that keeps failing). | `10_Network/airgap.test.ts`: no page source imports either (a `.node.ts` may import another), neither names an address off this machine or opens a connection of its own, and each imports only what its allowlist names. |

## The physics worker

`physics.worker.ts` has a global of its own, so the page's guard does not cover it. It now imports the gate first and
calls `installAirgap(globalThis)` before its own imports' module bodies have anything to do. Rapier's WASM is embedded
as bytes and instantiated from them (no `fetch`), and the crowd runs on WebGPU. The worker is created by `simClient.ts`
from the inlined build (`?worker&inline`, a `blob:` URL), which the guard does not touch: `Worker` is not an outbound
primitive, and a worker's own `fetch` is governed by its own guard.

## The API key

The Claude provider authenticates with an API key. Where it lives decides who can read it.

**Recommended: the gateway holds it, the page holds none.** The provider speaks only to a gateway on this machine
(`http://localhost:8089` by default). Run that gateway as a reverse proxy that listens on `127.0.0.1:8089`, forwards
`/v1/messages` and `/v1/models` to the Claude API over https, and adds the `x-api-key` header from its own
configuration, readable by the operator's account alone. With `ask key none` the page holds no key: it sends no
`x-api-key` header, and nothing in the browser can read a key that is not there. For example, with nginx (the key in
a file only the operator can read, included by the server block):

```
server {
  listen 127.0.0.1:8089;
  location /v1/ {
    proxy_pass https://api.anthropic.com;
    proxy_set_header Host api.anthropic.com;
    include /etc/nginx/claude-key.conf;   # proxy_set_header x-api-key "<key>";  (mode 600)
  }
}
```

The page sends `anthropic-dangerous-direct-browser-access: true`, so the API answers the browser's cross-origin
preflight through the proxy; a gateway that terminates CORS itself must allow the page's origin (`null` for a page
opened from a file) and the `anthropic-*` and `content-type` headers.

**Allowed: a key typed to the console.** `ask key <key>` keeps the key in this browser's local storage, in the
record `civic-simulation:cognition:v2` (`App.tsx COGNITION_KEY`, `09_Cognition/router.ts`), field `claude.key`, in
plain text. It is not encrypted: the key to decrypt it would have to sit on the same origin, readable by the same
scripts, so encryption would add no protection. What that means:

| Who | Can read the key? | Can send it off this machine? |
|---|---|---|
| The page's own code | Only `router.ts` reads it, to set the header on a request to the loopback gateway. The console shows it masked (first six and last four characters); `history` and the Up arrow never show the line that set it (`redactForHistory`); it is never sent to a local model server (`router.test.ts`). | No: the gate admits only loopback, the guard refuses every other address, and the Content-Security-Policy's `connect-src` names only loopback. |
| An operator `run` script, or any script injected into the page | Yes, from `localStorage`. The script sandbox shares the page's realm. | Not by `fetch`, `WebSocket`, `EventSource`, XHR, `sendBeacon` or WebRTC (guarded or removed), nor by an image, a stylesheet, a frame or a worker (the Content-Security-Policy). It could still navigate the tab to an address with the key in it: navigation has no CSP directive a single file can carry. |
| Another page opened from a file in the same browser profile | In Chromium-based browsers, yes: every page opened from a file shares one storage area. | That page is not under this page's guard or policy. |
| Another site on the web | No: storage is per origin. | |
| Anyone with the operator's browser profile on disk | Yes: local storage is a file in the profile. | |

**The speech provider's key works the same way.** `say provider elevenlabs` speaks to a gateway on this machine
(`http://localhost:8090` by default), never to ElevenLabs directly. Recommended again: the gateway holds the key and
the page holds none. The ElevenLabs API wants the key in `xi-api-key`; unlike the Claude API it has no header that
makes it answer a browser's preflight through a plain proxy, so this gateway answers CORS itself, for the page's own
origin only (a gateway that allowed any origin would let any site you visit spend your credits through it):

```
map $http_origin $speech_origin {
  default "";
  "http://127.0.0.1:4180" $http_origin;   # the Nix launcher (nix run)
  "http://localhost:4173" $http_origin;   # npm run preview; add "null" for a page opened from a file,
                                          # and the desktop app's origin if you use it
}
server {
  listen 127.0.0.1:8090;
  location /v1/ {
    if ($speech_origin = "") { return 403; }
    add_header Access-Control-Allow-Origin $speech_origin always;
    add_header Access-Control-Allow-Headers "content-type, accept, xi-api-key" always;
    add_header Access-Control-Allow-Methods "GET, POST" always;
    if ($request_method = OPTIONS) { return 204; }
    proxy_pass https://api.elevenlabs.io;
    proxy_set_header Host api.elevenlabs.io;
    proxy_ssl_server_name on;
    include /etc/nginx/elevenlabs-key.conf;   # proxy_set_header xi-api-key "<key>";  (mode 600)
  }
}
```

`say key <key>` instead keeps the key in this browser's local storage (`civic-simulation:speech:v1`, the
`elevenlabs.key` field, in plain text), with exactly the readers in the table above; `say key none` deletes it.

So a key typed to the console should be a testing key: scoped, with a spending limit, revoked when the testing ends,
and cleared with `ask key none` (which also deletes it from storage). Serving the page from `npm run preview`
(`http://localhost:4173`), or from the Nix launcher (`http://127.0.0.1:4180`, which also gives its Chromium a
profile of its own and opens that profile only on a server that proves it holds this user's token), instead of
opening it as a file gives it an origin of its own, which closes the shared-file-storage row.

## The installable web copy (`tools/web/pwa.mjs`)

`npm run build:web` writes `dist-web/`, the same page made installable for a phone (MANUAL, On an iPhone): a manifest,
the icons and a service worker. It can be served from a host off this machine (GitHub Pages, or a tailnet).

| Where | What it could reach | What closes it |
|---|---|---|
| The service worker (`sw.js`, written by `pwa.mjs worker`) | It has a global of its own, which `installAirgap` never sees, and the browser hands it every request the page makes. It answers only GET requests for its own origin, from its cache or, for a file the cache lacks, from that origin; it never builds a URL. A request for any other origin (a loopback model server, anything) it leaves to the browser, so the page's guard and policy decide it as before. | `src/webApp.test.ts` runs the worker against a fake cache: another origin and a POST are left alone, a page load gets the cached page, and only its own older caches are dropped. |
| The policy of the web copy's page | `manifest-src 'self'` is added so the browser may read the manifest from the page's own origin. | `webApp.test.ts` holds every other directive equal to `index.html`'s; the builder refuses a page whose policy already names a manifest source. |
| The page's own origin, on a host off this machine | The guard admits the page's own origin (The gate). On GitHub Pages that is `cassius-software.github.io`, which answers file reads only. Every Pages site of the organization shares that origin, and so its local storage: a key typed to `ask key` on the published copy could be read by another Pages site of the organization. | By choice: publish only trusted Pages sites under the organization, or serve the copy through Tailscale instead (MANUAL says so). The model providers stay loopback only, and an iPhone runs none. |

## What cannot be closed from the page's scripts

These are vectors a script in the page's realm still has after `installAirgap`, because they are not functions a
script calls but machinery the browser runs. A page-level guard cannot wrap them. They are closed by a
Content-Security-Policy served with the page, which the browser enforces for the document, for iframes it creates
without a URL (`srcdoc`, `about:blank`) and for workers made from `blob:` URLs. That policy is not yet in
`index.html`; it is the next step, and the exact header is given below.

| Vector | What it could reach | What would close it |
|---|---|---|
| Elements the parser and CSS load: `<img src>`, `<script src>`, `<link>`, `<iframe src>`, `<video>`, `<audio>`, `<object>`, CSS `url()` and `@import`, `new Image().src`, `<a ping>`, `<link rel=prefetch>` | A GET to any host, with data in the query string: the classic exfiltration of a key read from local storage. | CSP `img-src`, `script-src`, `style-src`, `media-src`, `frame-src`, `object-src`, `prefetch-src`. |
| Navigation: `location.assign`, `location.href =`, `window.open`, a form submission, a clicked `<a href>` | A GET or POST to any host, ending the session. | CSP `form-action`; navigation itself has no shipped directive (`navigate-to` was dropped). A single-file page opened from a file cannot be stopped from navigating by the page. |
| Link hints: `<link rel=dns-prefetch>`, `<link rel=preconnect>` | A host name (so a few hundred bytes encoded in its labels) to a resolver, and for preconnect a TCP and TLS handshake with that host; no body. | No CSP directive governs them (`prefetch-src` was dropped; dns-prefetch and preconnect were never covered). `index.html` sets `x-dns-prefetch-control: off` for the implicit hints; an explicit hint an injected script inserts remains open, as navigation does. |
| `import('https://...')` | A module from any host, run in the page's realm. It is syntax, not a function on the global, so it cannot be wrapped. The structural test fails if any source names one; a `run` script can still write one. | CSP `script-src`. |
| A fresh realm: `document.createElement('iframe')` (`about:blank` or `srcdoc`), `new Worker(blobURL)`, `new SharedWorker` | Its `contentWindow` or its global has the browser's original `fetch` and `WebSocket`. This is the one way the guard's own closures can be bypassed, and it is why the guard alone is not "mathematical". | CSP `connect-src` is inherited by such iframes and blob workers, so the policy below closes it; `frame-src 'none'` and `worker-src blob:` narrow further. (The physics worker is itself a blob worker, so `worker-src` must keep `blob:`.) |
| The browser's own speech recognition (`08_Swarm/recruitment.ts speechEnv`, `recruit listen`) | In some browsers the Web Speech API sends the microphone's audio to the vendor's service. It is an API the page calls, not a URL the page names, so the guard cannot see it. Opt-in: nothing listens until `recruit listen`. | Only by not using it, or a browser whose recognition is on-device. The README states it. Not closed. |
| WebRTC through an iframe realm, `navigator.serviceWorker.register` of a same-origin script, `SharedArrayBuffer` side channels, hardware (WebHID, Web Serial, Web Bluetooth) | Peer media; a worker with its own fetch (same-origin script only, so not on a file page); a radio. | CSP `webrtc 'block'` (CSP3, where supported); `worker-src`; hardware needs the operator's permission prompt (`hal pair`). Out of scope here, listed for completeness. |
| `localhost` name resolution | The operating system's hosts file could point `localhost` elsewhere. | Browsers resolve `localhost` to loopback themselves (the "let localhost be localhost" rule); `127.0.0.0/8` and `[::1]` are addresses, not names. |
| ES module import order | `main.tsx`'s imports evaluate before its first statement, so a module body in `App.tsx`'s graph that addressed a server at load would run before the guard. | None does: the structural test allowlists every outbound call site, and each is inside a function called later. A side-effect import of the gate as the first import would make the order explicit; it was not needed. |

The policy that closes the first four rows, for `index.html` (a `<meta http-equiv="Content-Security-Policy">`,
which works for a page opened from a file; `frame-ancestors`, `report-uri` and `sandbox` are the directives a meta tag
cannot carry):

```
default-src 'none';
script-src 'self' 'unsafe-inline' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' data: blob:;
font-src 'self' data:;
worker-src 'self' blob:;
connect-src 'self' http://localhost:* https://localhost:* ws://localhost:* wss://localhost:*
            http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:*
            http://[::1]:* https://[::1]:* ws://[::1]:* wss://[::1]:*;
frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';
```

CSP cannot express `127.0.0.0/8` as a wildcard, so the policy names `127.0.0.1`; the gate accepts the whole block,
which is wider than the policy. Chromium also refuses an IPv6 literal (`[::1]`) as a source and logs a warning, so the policy
`index.html` ships (Phase 11, after this audit) names `localhost` and `127.0.0.1` only. The booted page was checked
headless in both tracks with a `securitypolicyviolation` listener: no violation, no new error. The single-file build inlines its scripts and styles, hence `'unsafe-inline'`; a
nonce would need the build to stamp one. `index.html` now carries this policy, without the `[::1]` sources (see above).

**Phase 13: the room gate is the policy's hosts.** A gate wider than the policy turned a typed `ws://[::1]:8787` or
`ws://127.0.0.2:8787` into a socket the browser refused with an error the player could not read. `netServer` now
admits a room only at `localhost` or `127.0.0.1` (`airgap.ts ROOM_HOSTS`), exactly the ws and wss sources of the
shipped policy, and refuses any other loopback address itself, with the reason; `airgap.test.ts` reads `index.html`
and fails if the two ever part. The model and speech gate (`loopbackServer`) is unchanged: its clients name their
servers by `localhost`, and a server at another loopback address is still refused by the policy, as above. On the
host side, the room's own defences against what reaches it over that socket (one connection per player, a session
ending with its token, metered pings, a header deadline, ended refusals) are described in the README, Networking.

## What changed, in one list

- New: `02_Define_The_Rules/airgap.ts` and its test; `docs/zero-trust-audit.md` (this file).
- `09_Cognition/localCompute.ts`, `claudeApi.ts`, `10_Network/netClient.ts`: `loopbackServer`, `claudeServer` and
  `netServer` are the gate's, re-exported under their old names; the Claude default is `CLAUDE_GATEWAY`
  (`http://localhost:8089`); refusals name the rule.
- `09_Cognition/router.ts`, `07_Execute_Actions/operator.ts`, `terminal/commands.ts`, `terminal/bridge.ts`: the
  wording (`ask provider claude`, `ask`, `net`); `net join <ws-url>`.
- `main.tsx`, `07_Execute_Actions/physics.worker.ts`: `installAirgap(globalThis)` first. `App.tsx`: the clients'
  fetch under `loopbackFetch`.
- `10_Network/airgap.test.ts`: the structural proof above. `claudeApi.test.ts`, `router.test.ts`,
  `netClient.test.ts`, `terminal/commands.test.ts`: every former acceptance of an address off this machine is now a
  refusal.
