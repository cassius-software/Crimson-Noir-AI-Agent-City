# The operator's progression

This is the design of the operator's level, skills, civic credits and purchases (`MANUAL.md`, "The operator's
progression", says how to use them). The implementation is three files:

- `src/02_Define_The_Rules/progression.ts`: the rules, pure (no clock, no storage, no DOM), over one flat record.
- `src/05_Observe_Environment/progressStore.ts`: the record kept in this browser's local storage.
- `src/07_Execute_Actions/progress.ts`: the page's keeper (rounds, rests, saving, listeners), the console's text,
  which console command earns which skill, what the recruiter's events earn, and the HUD chip's words.

The tests beside them (`progression.test.ts`, `progressStore.test.ts`, `progress.test.ts`) pin every number on this
page. The mechanics are offered under the ORC License; `NOTICE.md` names the two works they come from (Pathfinder
Player Core and Pathfinder GM Core) and lists what was taken and what was added, and `docs/ip-audit.md` §7 records
what was checked.

## Where it came from

A plan another AI wrote (pasted by Julian on 7 November 2026, "Section 3") asked for a progression in the style of the
Pathfinder Second Edition remaster: six ability modifiers, eight skills with proficiency ranks, levels 1 to 20 at
1,000 XP, a currency paid from a wealth table and a payout table, hero points, resolve, three-action pips, the four
degrees of success, a breadth multiplier for using many skills, and audio, haptic and HUD cues on success. This
product builds that, extending the check rules it already had (`degrees.ts`: the d20, the four degrees, natural 20s
and 1s, fortune, proficiency) rather than adding a second set. What it declined is under "Not built".

## The record

One `Int32Array` of 128 words (512 bytes), over a `SharedArrayBuffer` when the page is cross-origin isolated and an
`ArrayBuffer` otherwise; a `Uint32Array` view of the same buffer reads the masks and the seal. The first fields keep
the indices the plan gave them, so a reader of the plan finds them where it said.

| Word | Field |
|---|---|
| 0-5 | Attribute modifiers, STR DEX CON INT WIS CHA |
| 6-13 | Proficiency ranks of the eight skills (0 untrained to 4 legendary) |
| 14 | Level, 1 to 20 |
| 15 | XP toward the next level, 0 to 999 |
| 16 | Civic credits, 0 to 2,000,000,000 |
| 17 | Hero points, 0 to 3 |
| 18 | Resolve, 0 to the cap |
| 19 | Actions left this round (bits 0-1) and the reaction (bit 2) |
| 20 | Skills used this cycle, one bit each |
| 21 | Misses in a row |
| 22 | Kept free (the plan's running reward expectation, not kept) |
| 23 | Skill increases not yet spent |
| 24 | Partial boosts, one bit per attribute |
| 25-26 | The dice's seed and position |
| 27 | Checks made |
| 28-35 | Checks made in each skill |
| 36 | Checks in the current cycle |
| 37-38 | Credits earned and spent, all time |
| 39 | Layout (1) |
| 63 | Seal (FNV-1a of every other word) |
| 64-127 | 2,048 unlock bits |

A stored record is used only when it has 128 whole words, layout 1, a matching seal and every field in range
(`whyInvalid`); anything else is moved aside under `civic-simulation:progress:set-aside` and a new operator starts.
The seal catches damage and casual hand edits; it is not security, since the record never leaves the device and buys
nothing outside it.

The dice are seeded from the record (its seed mixed with its position), so the same record always rolls the same
next check, and a test can replay any run.

## The numbers

**Attributes.** A new operator has +1 in each. Levels 5, 10, 15 and 20 bring four boosts to four different
attributes; a boost at +4 or more counts half (two halves make +1). The boosts go to the attributes behind the skills
used most, so the operator grows into the work they do.

**Skills.**

| Skill | Attribute | Earned at the console | Earned in the city |
|---|---|---|---|
| computers | INT | `noir`, `r0`, `run` | |
| piloting | DEX | | boarding a car with the door key |
| robotics | STR | `robot spawn`, `urdf`, `demo`, `set`, `arm`, `calibrate`, `mode` | |
| cyber security | WIS | `harness run`, `act gate`, `act log verify`, `swarm audit verify` | |
| swarm command | CHA | `act ok`, `swarm run`, `recruit rally`, `ask`, `ping` | someone recruited arriving (from the reaction) |
| acoustics and voice | CHA | `say`, `sloane say` | a spoken request the recruiter understood |
| optics and cinema | WIS | `rain`, `ghost`, `time`, `xr`, `record start` | the clock keys, the rain key, the ghost key when the view shows or goes, the touch menu's Headset |
| architecture and commerce | INT | `look` (with a change) | the wardrobe card's first real change of a visit |

Every skill starts trained. A level from 2 brings one skill increase: expert at any level, master from level 7,
legendary from level 15 (Player Core's gates). A skill's modifier is its attribute plus, when trained or better,
twice its rank plus the level.

**Checks.** A d20 plus the modifier against the level-based DC (GM Core: 14 at level 0, 15 at level 1, to 40 at
level 20) eased by 2, the easy adjustment, since city work is routine. A natural 20 raises the degree one step and a
natural 1 lowers it one. With every skill trained at +1, a level 1 operator succeeds on a 9 or better (60%) and
critically fails only on a 1.

**What a check pays.** Fixed, by degree, and printed by `progress table`:

| Degree | XP | Credits | Hero point |
|---|---|---|---|
| Critical failure | 0 | 0 | 0 |
| Failure | 10 | 0 | 0 |
| Success | 40 | the level's payout | 0 |
| Critical success | 80 | 2.5 times the payout | 1 |

The level's payout is the plan's table (150 credits at level 1, 400,000 at level 20), about a thirteenth of the
level's treasure. The treasure by level is GM Core's table at ten credits to the gold piece (1,750 at level 1 to
4,900,000 at level 20); a new operator starts with 150 credits, GM Core's 15 gp of starting wealth. The treasure table
is printed beside the payouts so the scale of a level is visible; nothing is paid from it directly.

**Breadth.** A cycle is 24 checks. Each check's XP and credits are multiplied by how many different skills the cycle
has used so far, counting this one: 1x for one, 1.25x for two, up in quarters to 2.5x for seven, and 3.5x for all
eight (in 256ths, indexed by the count from 0: 256, 256, 320, 384, 448, 512, 576, 640, 896). The check that lights the eighth skill
also gives a resolve (the plan's "overdrive"). The plan's feature-rotation multiplier was this; it rewards using the
whole city rather than repeating one command.

**Pace.** Three actions and a reaction every six seconds (Player Core's round); a check spends one. A skill earns
again only a minute after its last check. Together they keep a scripted loop from turning the console into a credit
mill, without a daily cap or a timer to come back for.

**Bad luck.** After three checks in a row that came out a failure or worse, the next one has fortune: two dice, the
higher kept, said so in the check's lines. This takes the place of the plan's hidden pity counter, and it is visible.

**Hero points.** At most three; at least one at the start of every session; a critical success gives one. One spent
on the last check that was not a critical success (`progress reroll`) rolls it again against the same numbers. The
better result pays: what the first paid stays, and a better second pays the difference. The plan also offered
spending one to make a critical success certain; that was left out for Player Core's reroll.

**Resolve.** The product's own pool: up to 5 plus CON (1 to 10), one more with each level and each overdrive. In
this slice it is shown and kept; what spends it comes with the slices that need it.

**XP.** 1,000 a level; what is left over rolls into the next. At level 20 the XP stops at 999.

## The city's checks and the cues

**What the city earns.** The engine hands App a deed (`onDeed`) once per press or event, never once per frame:
boarding counts only when player 1 pressed the door key within 1.5 s and the boarding was not a network room's
correction, so a script's or a harness's `interact()` earns nothing; the ghost key counts only when the view actually
showed or went away (a single view, no headset, the post chain on). The setters behind the keys (the ghost view's,
rain mode's and the clock's) and the city knobs an agent's act uses earn nothing, because the console, scripts and
agents share them and the console earns for its own commands. Recruiting earns once, when the person arrives, however
they were asked (the console, a voice, `agent hire`), and from the reaction, since the city chose the moment and the
round's actions stay the operator's; so `recruit <skill>` and `recruit listen` at the console earn nothing themselves.
The wardrobe card calls back on every swatch and slider step, so only its first change of a visit that alters the look
earns; the console's `look` earns for itself. The keeper's rests and rounds still decide every one of these.

**The cues.** One listener in App cues every success and critical success, the console's and the city's alike,
including a hero-point reroll that climbs to one (a reroll that stayed a success paid nothing and is not cued again):

- a short chime in player 1's ears alone (`audio.ts` `CHIME`: a C5 E5 G5 arpeggio for a success, a C4 C6 G6 chord
  for a critical success, rendered once when the soundscape is built), captioned as text with no place
  (`[chime: Piloting, success]`). It never covers a cue or a ping: at the ear it is quieter than the recruitment cue
  from anyone near enough to be asked over (5 m, through the cue's distance and pan), it waits for a cue or a ping
  still sounding (the console's `ping go` cues the mark first), and one that starts over it fades it out;
- on a controller, one 50 ms tap for a success and two for a critical success on the rumble alone (`hal.ts` `PULSE`),
  only while no guardrail signal holds the motors, the screen is not split and the page is shown; on a phone, a 12 ms
  vibration, or two;
  `haptics off` at the console or `?haptics=0` stills both, and the guardrails' rumble with them (the triggers'
  resistance stays);
- the HUD's progress chip: the level, the XP ('420 of 1,000 XP'), the credits, the hero points and the round's pips
  (◆ left, ◇ spent, ↺ the reaction), and for four seconds after a check which degree, in which skill and what it paid,
  with one soft ring around the chip (warmer for a critical success), at most once a second and none when the system
  asks for reduced motion. On a phone the chip shows only for those four seconds, and not at all held in landscape.
  A check the city earns makes no toast: the chip and the chime's caption report it. Captions only describe sounds
  that play, so with the sound off (`audio off`, `?audio=0`) the chip alone shows it; `audio 0` silences the city and
  keeps every caption, the chime's too.

The chime is rendered before any check, and the first tap is sent from the listener at once rather than on the next
frame. Whether that meets the plan's under-16 ms budget is not measured, and how the tap and the vibration feel on real
pads and phones is unverified.

## The purchase gate

Every purchase in the city goes through the one record, so the credits and what they bought are saved in the same
write and a purchase never takes the credits without the item, or the other way round.

```ts
import { pageProgress } from './07_Execute_Actions/progress.ts'
import { PURCHASE, PURCHASE_TEXT, UNLOCK_SPACE } from './02_Define_The_Rules/progression.ts'

const p = pageProgress()                         // the page's one keeper
p.canBuy('look', 17, 3, 900)                     // what buying would come to, without buying
p.buy('look', 17, 3, 900)                        // PURCHASE.bought, or why not (nothing changes then)
p.owns('property', 2)                            // true once bought
p.spend(250)                                     // credits for a service, not an unlock
p.subscribe(() => { /* the record changed */ })  // returns an unsubscribe
p.record[16]                                     // credits, read-only by convention; level is p.record[14]
```

- **Spaces.** `look` (indices 0 to 1023: the wardrobe, the dyes and the body art), `property` (0 to 63) and
  `furniture` (0 to 511). An index outside its space is `PURCHASE.invalid`. Each selling thread owns its space and
  numbers its own items in it; an index, once shipped, keeps its meaning, since the bit is what the record remembers.
  The claims so far:

  | Space | Indices | Sold by |
  |---|---|---|
  | `look` | 0-511 and 768-1023 | the customizer (wardrobe, dyes, body art) |
  | `look` | 512-767 | the retail storefronts |
  | `property` | 0-63 (the seven homes and offices are 0-6) | the properties |
  | `furniture` | 0-511 | the furnishing of the properties |
- **Arguments.** `buy(space, index, levelReq, price)`: `levelReq` a whole number from 1 to 20, `price` a whole number
  of credits from 0 to 2,000,000,000 (0 is a free unlock).
- **Results.** `PURCHASE.bought` (0), `owned` (1, nothing charged), `level` (2), `credits` (3), `invalid` (4), checked
  in that order after `invalid`; `PURCHASE_TEXT[r]` is the plain words for each.
- **Saving.** The keeper saves after every purchase; a store that refuses (a private window) leaves the purchase in
  the page for the visit.

## The console

`progress` prints the status (level, XP, credits, hero points, resolve, the round's actions, the attributes and the
skills); `progress table` the DC, the payouts, the treasure, the degrees and the breadth bonus; `progress train
<skill>` spends an increase; `progress reroll` a hero point; `progress reset --yes` starts a new operator. A console
command that does something in the city and ran without an error earns a check in its skill, printed under its own
lines, when an action is left and the skill is rested; status lines and lists earn nothing. The status refills the
round's pips on the same six-second clock the HUD chip reads, so the two agree. `haptics [on|off]` switches the
controller's rumble and the phone's vibration. The terminal app (`tty`) has no city and says so.

## Not built

- **The plan's reward-prediction-error multiplier** (a payout scaled up to five times by how much it surprises the
  player, word 22 of its record) and **its hidden pity counter** (a large payout guaranteed on a variable ratio).
  Their purpose is to make play compulsive, which a 14A city that people return to on their own terms does not need.
  Payouts here are a fixed table anyone can print, and the bad-luck guard is visible.
- **Drop tokens** and any real money: credits are earned in the city and spent in the city, nothing else.
- **The plan's conditioning vocabulary** stays out of the product's text; a check says what it paid and nothing
  more.

## Next

- Done in the second slice: the cues (the chime, the controller's tap and the phone's vibration, the HUD chip) and
  the checks the city itself earns (above).
- Left: an action card's cost in pips.
