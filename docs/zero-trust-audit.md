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
| `netClient.ts connect` → `open(href)` → `new WebSocket(href)` | Before: wss to any host, carrying the session token in the first frame and then the player's walking input every frame. | `netServer` is the gate's ws rule: ws or wss to loopback only. The default `open` checks `netServer` again before constructing the socket, and the socket constructor is the guard's. `netClient.test.ts` flips `wss://rooms.example.net` to a refusal; the Node host tests still drive a real socket to `127.0.0.1`. |
| `netClient.ts offerVoice` | A `RTCPeerConnection` would carry media to a peer directly, outside every URL-based rule (a Content-Security-Policy cannot see it either, short of CSP3's `webrtc 'block'`). The scaffold never constructs one. | `installAirgap` removes `RTCPeerConnection` from the global; the stub reports it absent. |
| `terminal/commands.ts net` | A `ws(s)://` syntax check only, then the bridge. The terminal imports only types, so it cannot import the gate's value. | The client decides (`netServer`), and its refusal is what the console prints. |
| `replication.node.ts` | Node-only, never bundled; it listens, it does not connect. | `10_Network/airgap.test.ts`: no page source imports it, and it names no address off this machine and opens no connection of its own. |

## The physics worker

`physics.worker.ts` has a global of its own, so the page's guard does not cover it. It now imports the gate first and
calls `installAirgap(globalThis)` before its own imports' module bodies have anything to do. Rapier's WASM is embedded
as bytes and instantiated from them (no `fetch`), and the crowd runs on WebGPU. The worker is created by `simClient.ts`
from the inlined build (`?worker&inline`, a `blob:` URL), which the guard does not touch: `Worker` is not an outbound
primitive, and a worker's own `fetch` is governed by its own guard.

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
