# HAL peripherals: microcontrollers and drones (draft 0.1)

Status: **draft specification**. Nothing here is wired into the HAL bus yet. The gate it describes is written and
tested as a pure module: `src/04_Connect_Hardware/peripheralPolicy.ts`, with tests in `peripheralPolicy.test.ts`.

> **Real-world caveat.** This is a software gate, not a safety case. A city simulation cannot certify that a real
> aircraft or a real motor is safe to operate. Local aviation rules apply to any real flight: registration, pilot
> certification, altitude and line-of-sight limits, and no flight over people unless those rules allow it. They apply
> whatever this gate admits. The device's own firmware must enforce its failsafe independently of the host.

## 1. Why

HAL/1 (`lineLink.ts`) is deliberately one-way. The city feeds devices telemetry, and anything a device sends back
except `PING` is read and ignored: "a device cannot steer the city". The city cannot steer a device either.
Microcontroller actuators and drones need a path out, and that path must obey the same rules as the rest of the
product:

- **Air gap.** Capability flows only through bridges. No peripheral code holds an engine reference.
- **Spatial Lease.** Every capability is bound to a leased task. A broken tether (over 12 m, or driving off) aborts
  it at once.
- **Operator tier.** Anything that acts on the world needs `operator unlock`.
- **Pacifism is not bypassable.** The Three Laws rank protecting people first. No tier, lease or configuration can
  admit a capability designed to release, propel or aim anything.

## 2. Device classes

| Class | Examples | In (to the city) | Out (from the city) |
|---|---|---|---|
| `sensor` | temperature, air-quality or light board; every HAL/1 gadget today | telemetry, always allowed | none |
| `actuator` | status light, display, haptic seat, servo, small motor | telemetry | `light`, `display`, `haptic`, `servo`, `motor`, each gated |
| `drone` | small multirotor on a companion microcontroller | telemetry (position, battery, link) | `flight` setpoints and `light`, gated plus flight limits |

A device that sends no capability line is a `sensor`. This is how existing HAL/1 gadgets stay exactly as they are.

## 3. Wire protocol: HAL/1 capabilities extension (additive)

Framing is unchanged: UTF-8, one message per `\n`-terminated line, at most 1,024 bytes, over Web Serial or BLE NUS.
The existing handshake is unchanged too: `HELLO <brand>/<version>`, answered by `READY <name>`, then PING/PONG. The
extension adds these lines:

| Direction | Line | Meaning |
|---|---|---|
| device → host | `CAPS 1 {json}` | Sent right after `READY`. The host waits 500 ms for it; if none arrives, the device is a legacy `sensor`. |
| host → device | `ARM <nonce>` | Arming request. Sent only when the gate allows arming (§4). |
| device → host | `ARMED <nonce>` | Arms only when it echoes the pending nonce exactly. |
| device → host | `BEAT <n>` | Heartbeat, at least every 200 ms while armed (the watchdog allows 500 ms). |
| host → device | `CMD {json}` | One admitted command: `{"seq":…,"issuedAt":…,"ttlMs":…,…}`. |
| host → device | `DISARM <cause>` | Stop now. Causes: `ring0-panic`, `tether-broken`, `heartbeat-lost`, `operator`. |
| host → device | `FAILSAFE LAND` | Drones only, sent after `DISARM`: hold position, then descend and land where it is. |

The `CAPS` body:

```json
{ "class": "drone",
  "telemetry": ["gps", "battery", "link"],
  "actuation": ["flight", "light"],
  "limits": { "ceilingM": 20, "speedMs": 4, "rangeM": 40 } }
```

- **Unknown versions** are refused with a sentence, and the device stays at `sensor`.
- **Names** are lower-case, 1–32 characters, `[a-z0-9_-]`.
- **Drone limits** can only lower the host's own (§5). A missing or invalid limit takes the host value.

A device ignores lines it does not know. A legacy gadget therefore never sees `ARM`, `CMD` or `DISARM`, because the
host never arms a device that declared no actuation.

## 4. The gate (default deny)

Telemetry in is always admitted. Every command out is checked in this order. The first failing check is the refusal
reason, and every refusal is audited.

| # | Check | Refusal |
|---|---|---|
| 1 | No Ring-0 lock this session | `locked` |
| 2 | The capability was not refused at the handshake and is not in a never-class | `refused-at-handshake` |
| 3 | The capability was declared and accepted for this class | `not-declared` |
| 4 | Operator tier unlocked | `no-operator-tier` |
| 5 | A live Spatial Lease (its signal not aborted); if the device was armed, it is disarmed now | `no-lease` |
| 6 | Armed by the `ARM`/`ARMED` nonce handshake | `not-armed` |
| 7 | Heartbeat within 500 ms; otherwise it is disarmed now | `heartbeat-lost` |
| 8 | Sequence number is a safe integer above the last admitted one (replay protection) | `stale-sequence` |
| 9 | Issued no later than now, time-to-live at most 250 ms, and not yet elapsed | `expired` |
| 10 | Under 20 commands in the rolling second | `rate-limited` |
| 11 | Every number finite | `non-finite` |
| 12 | Drones: a geofence is set, and the setpoint is inside it at altitude ≥ 0 | `no-geofence`, `outside-geofence` |
| 13 | Drones: altitude ≤ ceiling | `above-ceiling` |
| 14 | Drones: 0 ≤ speed ≤ speed cap | `over-speed` |
| 15 | Drones: within range of the operator's known position | `beyond-range` |

Arming (`requestArm`) needs checks 1 and 3–5, plus a geofence for a drone.

### Never admitted (the pacifist rule)

At the handshake, any declared capability in these classes is moved to `refused` for the whole session: **payload
release** (release, drop, dispense, spray), **projectile** (launch, fire) and **aiming**. The gate also re-checks the
never-classes on every command (check 2). So even a state edited to list such a capability as accepted cannot admit
it. No tier, lease or later handshake changes this; a new `CAPS` line needs a new session.

## 5. Drone limits

- **Host defaults:** ceiling 30 m, speed 5 m/s, range 50 m from the operator. They are deliberately small, for a
  test field.
- **Effective limits** are the lower of the host default and the device's declaration.
- **Geofence** is an axis-aligned rectangle in world metres (x east, z south). Arming without one is refused.
- **Failsafe:** a lost heartbeat, a broken tether or a Ring-0 panic sends `DISARM`, then `FAILSAFE LAND`. The drone
  holds position, then lands where it is. It **never** flies a return path: a return route can cross people who
  arrived after it left.
- **Future (0.2):** a standoff from people. Refuse setpoints within a radius of any person the city knows about,
  mirroring the vehicles' sanctuary standoff.

## 6. Events that disarm

| Event | Source | Effect |
|---|---|---|
| Ring-0 panic | `ring0.ts` → `kernelPanic`; the engine's HAL dispose | `ring0Panic()`: disarm, broadcast, **latched lock** (nothing is armed or admitted again in this session) |
| Tether broken | taskRouter lease aborts (over 12 m, or driving off) | `tetherBroken()`: disarm, broadcast |
| Heartbeat lost | host watchdog every tick, and the gate itself | `watchdog()` or `admit()`: disarm, broadcast |
| Operator | `hal disarm` (future console command) | `disarm(…, 'operator')` |

The broadcast goes to **every** armed peripheral, not only the one the event concerns.

## 7. Audit

Every admission, refusal, arming, disarm and lock is appended to the device's audit log as `{ at, event, detail }`.
The newest 256 entries are kept per device. A future `hal audit` console command prints it; the `.agv` recorder can
carry it per frame.

## 8. Where it plugs in (future work)

1. `lineLink.ts`: parse `CAPS`, `ARMED` and `BEAT` after `READY`, and add `sendLine` for `ARM`, `CMD` and `DISARM`.
   The gate stays out of the link.
2. `hal.ts`: keep one `PolicyState` per device, and run `watchdog()` on the HAL tick. Subscribe to the engine's
   Ring-0 panic and to the lease's `abort` event.
3. The operator bridge: expose `sim.peripherals.command(id, …)`, routed through `admit()` only, with no engine
   reference, as with `operatorBridge`.
4. Tests against a mock serial port (as `hal.test.ts` does): a legacy gadget is unchanged, and the full `CAPS`,
   `ARM`, `CMD` and `DISARM` exchange works.
