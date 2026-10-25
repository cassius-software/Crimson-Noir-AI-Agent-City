# The autoscaler at both ends of its range

The quality governor (`src/05_Observe_Environment/governor.ts`) was driven through two device profiles for the Stable
Beta: the minimum it must serve (a flagship phone) and the maximum (a console-class desktop). The tests are
`governorPhone.test.ts` (19 tests) and `governorDesktop.test.ts` (16 tests), next to `governor.test.ts`. Above the
maximum, `governorPeak.test.ts` (19 tests) drives Peak, the tier above Ultra (section C). They run in `npm test`.

## How it was measured, and what it cannot show

The browser's GPU cannot be measured here. Headless Chromium in this environment loses its software WebGPU device at
boot, so the city (Track A) never draws a frame. The tests prove the governor's logic instead:

- **The profile.** It is built from the globals `readDeviceHints` reads (`navigator`, `screen`, `matchMedia`, Tauri's
  markers), stubbed with what each browser really reports and restored afterwards.
- **The governor.** It is built as `Engine.create` builds it: the starting tier, the automatic range, `?fps` as the
  target, the cinema camera's period unless `?cinema=0`, and `?quality` pinning a tier.
- **The frames.** Synthetic animation-frame intervals stand in for the GPU. On the desktop they go through the engine's
  own `FramePacer`, which decides which frames the cinema camera draws and presents.
- **Above Ultra.** `governorPeak.test.ts` drives the governor above Ultra on the same synthetic loop, with a GPU time
  per drawn frame, fed back one reading at a time as the engine's single timing resolve does.

Every number below is simulated time on those frames. A real device's frame costs will differ; what is proved is how
the governor answers a given stream of frames.

The traces are one row per scenario per simulated second (`scenario, t_seconds, fps, camera_fps_or_blank,
tier_index, tier_name`): `phone.csv` (16 scenarios) and `desktop.csv` (27). A plain `npm test` writes nothing. To
regenerate them:

```sh
AUTOSCALER_TRACE=1 node --test src/05_Observe_Environment/governorPhone.test.ts src/05_Observe_Environment/governorDesktop.test.ts
```

## A. Minimum: the flagship phone

A current iPhone-class handset in Safari 26: WebGPU on its own GPU, touch only, a 120 Hz panel, about 8 GB of memory.

| Hint | As Safari reports it |
|---|---|
| adapter | `apple / apple / apple` (WebKit fills every field with the GPU name's first word) |
| user agent | the Safari 26 phone string (the OS version is frozen) |
| touch | 5 points, coarse pointer |
| cores | 4 (WebKit reports 4 for any chip with fewer than 8 cores) |
| memory | not reported (Safari has no `deviceMemory`) |
| screen | 402 × 874 CSS pixels (the page renders at a pixel ratio of at most 1) |

**Profile:** a phone, starting on Low, automatic range Minimal to Medium, 8,000 pedestrians. Only a reported memory of
4 GB or less would change it (Minimal, 5,000), and Safari never reports one.

Tier paths (seconds from boot):

| Scenario | Frames | Path |
|---|---|---|
| Headroom (`1-headroom-cap`) | a full 120 FPS for 180 s | Low → Medium 5.9, then held: the phone cap |
| 60 FPS on 120 Hz | 10 minutes | Low → Medium 5.9, held |
| Overload (`2-overload`) | 30 FPS from 20 s | Medium → Low 22.4 → Minimal 26.2, held |
| Heat (`3-thermal`) | frames 1.8× slower over 5 minutes | Medium 5.9 → Low 166.4 → Minimal 281.6, never back up |
| Recovery (`4-recover-backoff`) | headroom back just after Minimal | Minimal → Low 46.3 (the 20 s back-off) → Medium 52.8 |
| Late recovery (`4-recover-hold`) | headroom back at 60 s | → Low 64.5 → Medium 71.1 |
| Medium too heavy (`4-failed-probes`) | Low fits, Medium does not | probes at 5.9, 49.7, 133.6, 297.5, 601.3, 905.1 s, each withdrawn after 3.8 s; the waits grow 40, 80, 160, 300, 300 s |
| Cinema camera (`5-cinema`) | 16 of 24 presented from 20 s, all 24 from 50 s | Medium → Low 22.3 ("camera behind") → Medium 53.1, when the last 5 s first reach 97 % |
| Pinned (`6-pinned-0` … `4`) | overload, a camera behind, a tab switch, headroom | never moves (High and Ultra stay pinned on the phone) |
| Noise (`7-noise`, `7-noise-cinema`, `7-hitch-run-cinema`) | single 300–950 ms frames, GC pauses, hitch runs, a 5 s tab switch, 30 s in the background | Low → Medium 5.9, then held |

No automatic scenario ever goes above Medium.

## B. Maximum: the console-class desktop

8 cores / 16 threads, a discrete GPU of about 10 TFLOPS (an RDNA2-class part, or the NVIDIA Ampere card of the same
class), 16 GB or more, a 4K display at 60 Hz or a 1440p 144 Hz monitor, no touch, in a Chromium tab and in the native
Tauri shell.

| Hint | Value |
|---|---|
| adapter | `nvidia / ampere` (stock Chrome, Edge and WebView2 report vendor and architecture only); `amd / rdna-2`; `amd / rdna-2 / AMD Radeon RX 6700` where a browser names the card |
| user agent | Chrome 140 on Windows 11 (Edge and WebView2 add their token) |
| touch | none, fine pointer |
| cores | 16 (logical threads) |
| memory | 8 (Chromium caps the report at 8) |
| screen | 2560 × 1440 CSS pixels (4K at 150 %, or the 1440p monitor); 3840 × 2160 for 4K at 100 % |

**Profile:** a desktop, starting on Ultra, range Minimal to Ultra (Peak joins it where the browser gives GPU timings:
section C), 14,000 pedestrians. The native shell profiles the
same and reports `process.host: 'native'`. An AMD card the browser does not name starts on High: without the name it
cannot be told from an integrated chip of the same architecture. The first probe takes it to Ultra 5.8 s after
boot. 4K at 100 % scaling also starts one tier lower and climbs the same way.

| Scenario | Frames | Path |
|---|---|---|
| Boot (`boot-*`) | defaults | Ultra from 0 s, no change; unnamed AMD and 4K at 100 %: High → Ultra 5.8 |
| Steady (`steady-60`, `-144`, with and without the camera) | 600 s | Ultra, no change |
| `?scale=1.5` at 144 Hz | 600 s | holds Ultra under the camera; steps Ultra → High at 3.1 without it |
| Overload at 60 Hz (`overload-60`) | 60,000 pedestrians at 2× pixels, 20–45 s and again 150–175 s | Ultra → High 22.4 → Medium 26.3 → Low 30.2 → Minimal 34.0; back up at 54.1, 60.6, 67.2, 73.8; down again at 152.4, 156.2, 160.0, 163.8 and up at 203.8 (the doubled back-off), 210.4, 216.9, 223.5 |
| Overload at 144 Hz (`overload-144`) | 20–80 s | down at 22.4, 26.3, 30.1, 33.9; up at 84.7, 91.2, 97.7, 104.3 |
| Load swinging across Ultra's line (`oscillating-60`, `-144`) | 10 minutes | 9 changes (about 30 unchecked), never below High; the waits before re-trying Ultra grow 20, 40, 160, 300 s at 60 Hz and 20, 54, 94, 174 s at 144 Hz |
| Camera (`camera-60`, `-144`) | animation frames at 59–61 FPS; the camera presents 22, then 20, then 23, then 24 a second | 22/s holds; 20/s steps Ultra → High at 52.3 ("camera behind"); 23/s holds High with no probe; 24/s returns to Ultra at 101.1 |
| Pinned (`pinned-ultra`, `pinned-minimal`) | overload, camera at 16/s, headroom | never moves |
| `?fps=60`, `72`, `75` at 144 Hz | 180 s | Ultra holds (72 FPS meets 75 within the 5 % tolerance) |
| `?fps=90` at 144 Hz | 180 s | Ultra → High 3.1 ("frames below target"); probes back fail at 23.2–27.0 s and 107.0–110.9 s with a growing back-off |
| `?fps=90` under the camera | 180 s | Ultra holds: an explicit target overrides the camera's 60 FPS floor |
| `?fps=90` on the 60 Hz panel | 60 s | walks to Minimal at 3.1, 6.8, 10.6, 14.5 s and stays: the target cannot be met and is held as given |

## C. Above the maximum: Peak

Peak is tier 5, above Ultra and outside the tier table, like Lite below it. It draws Ultra at 1.25 times the pixels,
the sun's shadows out to 160 m at the same sharpness (an 8192² map, about 512 MB of graphics memory) and full-detail
people out to 90 m.

**The candidate.** The same machine as B, or an RTX 5090 (`nvidia / blackwell / NVIDIA GeForce RTX 5090`, 16 threads).
The rule (`peakCandidate`): a discrete card of any make or an Apple computer's chip, 8 cores or more, and no report
of less than 8 GB. The automatic range reaches Peak only where three really writes GPU timestamps (WebGPU's
`timestamp-query`). Without them the range stops at Ultra, as in B.

**Why the animation frames cannot decide.** Under the cinema camera a 3 ms and an 8 ms Ultra give the same animation
frames, interval for interval (test 4): the camera draws 24 frames a second either way, and both fit. So the
governor reads the GPU's own render time per drawn frame instead.

**The rules.** A probe from Ultra needs a p90 of at most 5.0 ms over the 5 s window (30 % of a 60 FPS frame). At
Peak, a median over 13.3 ms (80 %) through the step-down window steps down (`gpu busy`). The frame rate and camera
rules still apply. Both limits are shares of the frame the governor holds, never longer than the 60 FPS floor, so
`?fps` and a fast display without the camera tighten them and nothing loosens them.

The paths the tests pin, by window (seconds from boot unless said):

| Scenario | Path |
|---|---|
| A fast GPU, calm | Ultra → Peak (`probe`) at 5.5–7.5 s, then held for 10 minutes |
| A misjudged probe | down (`gpu busy`) within 4 s of arriving; the next entry needs a quarter less, so it never comes back at that load |
| Heat from 100 s to 160 s | down (`gpu busy`) at 100–103 s, back (`probe`) at 160–170 s, 0–10 s after the load ends |
| Three losses in a visit | Peak off until the page reloads; `setAuto` after a manual Peak lands on Ultra |
| The in-page model's hold, on the GPU | Peak down to Ultra; the release keeps Ultra, and Peak returns after a quiet 40, 80, 160 and 300 s |

**Section B unaffected.** B's paths are the governor without GPU timings. Peak moves none of them, which
`governorDesktop.test.ts` checks against `desktop.csv`: every row's scenario, second and tier are what the governor
walks today.

## Defects the profiles found, all fixed in `governor.ts`

1. **A named RDNA2 card started on High.** The AMD high-end pattern was `/rdna[34]/`, while every NVIDIA card of the
   same generation started on Ultra. It is `/rdna[234]/` now; the `rx` / `radeon pro` guard still keeps the
   integrated RDNA2 chips out.
2. **Hitch runs under the cinema camera stepped the tier down.** Two or three sub-second hitches in a row
   (950 + 950 ms, 3 × 600 ms) were ignored by the 60 FPS rule but read by the camera rule as frames missed, so the
   tier stepped down about 2.2 s later. A run of ignored hitches longer than a gap (1 s) now restarts the step-down
   window, as one frame that long always did.
3. **The step-down reason under `?fps`.** Every frame-rate step said "frames below 60 FPS", even when the frames ran
   at 72 FPS against an explicit 90. It says "frames below target" under `?fps` now.
4. **The camera floor's wording.** The README and the code comment glossed the 90 % floor as "a frame missed in each"
   half second. One missed leaves 11 of 12 (91.7 %) and holds; it takes two. Both now say two.

## Behaviour to know about (not defects)

- **Low Power Mode.** Safari halves the frame rate in Low Power Mode and under heavy heat. The governor reads that as
  overload, so the phone walks to Minimal and stays there while the mode is on.
- **Safari's 60 Hz default.** Safari caps pages at 60 frames a second even on a 120 Hz panel unless the user turns the
  cap off. The governor then aims at 60 FPS, the floor is unchanged, and a tier at 60 FPS counts as headroom.
- **Short stalls under the camera.** A 180 ms stall every half second for 3 s costs the camera two frames in every
  slice and steps one tier, as the rule says. 180 ms is under the 250 ms hitch cutoff: these are slow frames.
- **The 5 s hold.** It is counted in frames, on the 97th percentile, so the first step up after an overload can come
  about 4.5–4.7 s after the headroom returns rather than 5 s.
- **AMD in stock Chromium.** Chrome, Edge and WebView2 never name the card, so no AMD card starts on Ultra there; the
  first probe reaches it 5.8 s after boot.
