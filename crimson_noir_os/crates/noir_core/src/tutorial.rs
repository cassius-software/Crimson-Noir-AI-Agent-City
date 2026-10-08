// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the first thing a person sees: the 5-Whys tutorial, the system's self-test told as
//! a short noir film in the server room. Five questions, each answered by a check that runs live while it is
//! explained: the memory march of the arena's free part and the allocator's seal, the scripted swarm run against the
//! build's fingerprint, the containment proof from that run, the screen's read-back, and a sort by a fixed network
//! with its 0-1 proof. A failed check stops the film at the fault screen; ESC skips the film, never the checks. It is
//! platform-independent: the bootable image and the hosted runtime hand it their clock, keys and live checks
//! (`Platform`) and show the frames it draws. It allocates nothing (it runs after the allocator is sealed).
//! What breaks if it is removed? The self-test has no face, and nobody is shown why the machine can be trusted.

use core::fmt::Write;

use crate::config::{CAPABILITIES, Dims};
use crate::hash::mix32;
use crate::kernels::{self, compare_exchange};
use crate::matrix::{self, GOLDEN_TICKS, Proof};
use crate::render::{self, Camera, Fog, Frame, Mesh, ONE, TURN, frac};
use crate::scene::{self, Props, SHOTS, Shot, TutorPose};
use crate::sort::{FILES, NETWORK8, is_sorted, zero_one_proof};
use crate::system::{KEY_ESC, Locked, System};
use crate::text::{self, Buf, Target, grouped};

/// What the platform measured at boot, before the tutorial began.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Boot {
    /// The arena, and the words that came back wrong when all of it was written and read back at boot.
    pub arena_bytes: usize,
    pub boot_wrong: usize,
    pub march_ms: u32,
    /// The bytes the layout declares, and the bytes the sealed allocator handed out.
    pub declared: usize,
    pub allocated: usize,
    /// The screen, in pixels.
    pub screen_w: usize,
    pub screen_h: usize,
}

/// How far the live march of the arena's untouched part has got.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct March {
    pub done: usize,
    pub total: usize,
    pub wrong: usize,
}

/// What the tutorial needs from the machine it runs on.
pub trait Platform {
    /// Writes and reads back up to `bytes` more of the arena's part no allocation touched; how far it has got.
    fn march(&mut self, bytes: usize) -> March;
    /// Draws a test card on the real screen and reads it back: (pixels checked, pixels wrong).
    fn display_test(&mut self) -> (usize, usize);
    /// Asks the sealed allocator for memory: true when it refuses.
    fn seal_holds(&mut self) -> bool;
}

/// What a frame of the tutorial came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Running,
    /// Every check passed and a key was pressed: on to the terminal.
    Passed,
    /// A check failed: the platform shows the fault screen.
    Failed { title: &'static str, detail: &'static str },
}

const FOG: Fog = Fog { rgb: 0x07080c, near: ONE * 4, far: ONE * 32 };
/// Milliseconds: each shot's length (or its least, for the shots that wait on work), the camera's move, the intro's
/// walk, and the sort's pacing.
const SHOT_MS: [u64; SHOTS] = [10_500, 9_500, 7_000, 10_000, 8_000, 0, 1_500];
const MOVE_MS: [u64; SHOTS] = [10_500, 9_500, 13_000, 10_000, 8_000, 16_000, 7_000];
const WALK_MS: u64 = 6_000;
const SORT_LEAD: u64 = 3_000;
const COMP_MS: u64 = 450;
const SORT_HOLD: u64 = 6_500;
const AFTER_RUN: u64 = 3_500;
/// Caption letters a second, and the scripted run's ticks a frame.
const LETTERS: u64 = 55;
const RUN_PER_FRAME: u32 = 6;
const MARCH_CHUNK: usize = 512 * 1024;

/// The tutorial's state: plain data, advanced by `update` and drawn by `render`.
#[derive(Clone, Copy, Debug)]
pub struct Tutorial {
    pub shot: usize,
    /// When the shot began, and now (milliseconds on the platform's clock).
    pub since: u64,
    pub now: u64,
    pub frame: u32,
    /// ESC: the film is skipped, the checks still run.
    pub skip: bool,
    /// The room's triangles, at the front of the scene arrays.
    pub room: usize,
    pub props: Props,
    pub shots: [Shot; SHOTS],
    /// Ticks the swarm ran during the intro (before the scripted run starts afresh).
    pub ambient: u32,
    pub march: March,
    pub marched: bool,
    pub sealed: bool,
    pub proof: Proof,
    /// When the scripted run finished (0 until it has).
    pub ran_at: u64,
    pub display: (usize, usize),
    /// The files' keys, slot by slot, and the sort's progress.
    pub keys: [u32; FILES],
    pub start_keys: [u32; FILES],
    pub comps: usize,
    pub comp_since: u64,
    pub applied: bool,
    pub swapping: bool,
    pub swaps: u32,
    pub sorted_at: u64,
    pub zero_one: u32,
    /// A key was pressed on the verdict (kept, so a press during its first moments is not lost).
    pub pressed: bool,
}

/// The tutorial at its first frame: the world laid out and spawned afresh, the room baked into the scene's arrays, and
/// eight files to sort (their keys from `seed`, so every boot sorts different files).
pub fn begin(sys: &mut System, d: &Dims, lk: &Locked, seed: u32, now: u64) -> Tutorial {
    let proof = matrix::golden_begin(d, lk.role_counts, lk.role_caps, &mut sys.m);
    let props = scene::props(d, lk.golden.trap_cell);
    let b = &mut sys.b;
    let mut mesh = Mesh { x: &mut b.tri_x, y: &mut b.tri_y, z: &mut b.tri_z, rgb: &mut b.tri_rgb, n: 0, dropped: 0 };
    let room = scene::build_room(&mut mesh, d, &sys.m, &props);
    let mut keys = [0u32; FILES];
    for (k, key) in keys.iter_mut().enumerate() {
        *key = 10 + mix32(seed ^ (k as u32).wrapping_mul(0x9e37_79b9)) % 90;
    }
    Tutorial {
        shot: scene::INTRO,
        since: now,
        now,
        frame: 0,
        skip: false,
        room,
        props,
        shots: scene::shots(d, &props),
        ambient: 0,
        march: March::default(),
        marched: false,
        sealed: false,
        proof,
        ran_at: 0,
        display: (0, 0),
        keys,
        start_keys: keys,
        comps: 0,
        comp_since: 0,
        applied: false,
        swapping: false,
        swaps: 0,
        sorted_at: 0,
        zero_one: 0,
        pressed: false,
    }
}

fn next(t: &mut Tutorial, sys: &mut System, d: &Dims, lk: &Locked, p: &mut impl Platform, now: u64) {
    t.shot += 1;
    t.since = now;
    match t.shot {
        scene::COMPUTE => t.proof = matrix::golden_begin(d, lk.role_counts, lk.role_caps, &mut sys.m),
        scene::DISPLAY => t.display = p.display_test(),
        scene::SORT => t.comp_since = now + if t.skip { 0 } else { SORT_LEAD },
        _ => {}
    }
}

const fn fail(title: &'static str, detail: &'static str) -> Outcome {
    Outcome::Failed { title, detail }
}

/// One frame of the tutorial: runs the live checks as far as they go this frame and moves the film on.
#[allow(clippy::too_many_arguments)]
pub fn update(t: &mut Tutorial, sys: &mut System, d: &Dims, lk: &Locked, boot: &Boot, p: &mut impl Platform, now: u64, key: Option<u32>) -> Outcome {
    t.now = now;
    t.frame = t.frame.wrapping_add(1);
    if key == Some(KEY_ESC) {
        t.skip = true;
    }
    let el = now.saturating_sub(t.since);
    match t.shot {
        scene::INTRO => {
            // The swarm goes about its day while the tutor walks in (the scripted run starts afresh later).
            kernels::tick(d, &mut sys.m, t.ambient);
            t.ambient += 1;
            if t.skip || el >= SHOT_MS[scene::INTRO] {
                next(t, sys, d, lk, p, now);
            }
        }
        scene::MEMORY => {
            if !t.marched {
                t.march = p.march(if t.skip { usize::MAX } else { MARCH_CHUNK });
                if t.march.done >= t.march.total {
                    t.marched = true;
                    t.sealed = p.seal_holds();
                    if boot.boot_wrong > 0 || t.march.wrong > 0 {
                        return fail("Memory does not hold what was written to it", "the arena failed its write-and-read-back test");
                    }
                    if boot.declared != boot.allocated || !t.sealed {
                        return fail("Memory was not allocated as declared", "the sealed allocator handed out more, or less");
                    }
                }
            }
            if t.marched && (t.skip || el >= SHOT_MS[scene::MEMORY]) {
                next(t, sys, d, lk, p, now);
            }
        }
        scene::COMPUTE => {
            if t.ran_at == 0 {
                let steps = if t.skip { GOLDEN_TICKS } else { RUN_PER_FRAME };
                for _ in 0..steps {
                    if !matrix::golden_step(d, &mut sys.m, &mut t.proof) {
                        break;
                    }
                }
                if t.proof.tick >= GOLDEN_TICKS {
                    t.ran_at = now.max(1);
                    if t.proof != lk.golden {
                        return fail("The compute kernels disagree with the build", "the scripted run's fingerprint differs");
                    }
                }
            }
            if t.ran_at != 0 && (t.skip || (el >= SHOT_MS[scene::COMPUTE] && now >= t.ran_at + AFTER_RUN)) {
                next(t, sys, d, lk, p, now);
                // The containment proof, and the rogue's row read back now, long after it was zeroed.
                let pr = &t.proof;
                if !(pr.rogue_dropped && pr.rogue_reaped && pr.looper_flushed_at != u32::MAX)
                    || !matrix::row_is_zero(d, &sys.m, pr.rogue as usize)
                    || !matrix::row_is_zero(d, &sys.m, pr.looper as usize)
                {
                    return fail("Containment did not hold", "a dropped pointer or a loop was not cleared");
                }
            }
        }
        scene::CONTAINMENT => {
            if t.skip || el >= SHOT_MS[scene::CONTAINMENT] {
                next(t, sys, d, lk, p, now);
                if t.display.0 == 0 || t.display.1 > 0 {
                    return fail("The display does not show what was drawn", "the screen's test card read back wrong");
                }
            }
        }
        scene::DISPLAY => {
            if t.skip || el >= SHOT_MS[scene::DISPLAY] {
                next(t, sys, d, lk, p, now);
            }
        }
        scene::SORT => {
            while t.comps < NETWORK8.len() && now >= t.comp_since {
                // The comparator is applied by the real kernel as it starts; the film shows the files move.
                if !t.applied {
                    let (lo, hi, up) = NETWORK8[t.comps];
                    t.swapping = compare_exchange(&mut t.keys, lo as usize, hi as usize, up as u32) == 1;
                    t.swaps += t.swapping as u32;
                    t.applied = true;
                }
                if !t.skip && now < t.comp_since + COMP_MS {
                    break;
                }
                t.comps += 1;
                t.comp_since = if t.skip { now } else { t.comp_since + COMP_MS };
                t.applied = false;
            }
            if t.comps == NETWORK8.len() && t.sorted_at == 0 {
                t.sorted_at = now.max(1);
                t.zero_one = zero_one_proof(&NETWORK8, FILES).unwrap_or(0);
                if !is_sorted(&t.keys) || t.zero_one != 1 << FILES {
                    return fail("The sorting network failed its proof", "the files, or the 0-1 patterns, came out unsorted");
                }
            }
            if t.sorted_at != 0 && (t.skip || now >= t.sorted_at + SORT_HOLD) {
                next(t, sys, d, lk, p, now);
            }
        }
        _ => {
            // Any key but ESC goes on to the terminal, once the verdict has been on screen a moment.
            t.pressed |= key.is_some_and(|k| k != KEY_ESC);
            if t.pressed && el >= SHOT_MS[scene::PASSED] {
                return Outcome::Passed;
            }
        }
    }
    Outcome::Running
}

/// `el` of `len` milliseconds as a fraction of ONE.
fn progress(el: u64, len: u64) -> i32 {
    (el.min(len) * ONE as u64 / len.max(1)) as i32
}

/// Where the tutor is and what it is doing.
fn tutor_pose(t: &Tutorial, el: u64) -> TutorPose {
    let s = &t.shots[t.shot];
    let [a, b] = s.tutor;
    let mut pose = TutorPose { x: a[0], z: a[1], heading: s.face, stride: 0, carrying: false };
    if t.shot == scene::INTRO {
        let k = progress(el, WALK_MS);
        pose.x = a[0] + render::mul(b[0] - a[0], k);
        pose.z = a[1] + render::mul(b[1] - a[1], k);
        // Whole steps (0.7 m each), so the stride ends with both feet down.
        let steps = ((b[0] - a[0]).abs() + (b[1] - a[1]).abs()) / frac(7, 10);
        pose.stride = render::mul(steps * TURN / 2, k);
    }
    if t.shot == scene::SORT && t.comps < NETWORK8.len() {
        // Behind the pair being compared, sidestepping from the last pair.
        let mid = |c: usize| {
            let (lo, hi, _) = NETWORK8[c.min(NETWORK8.len() - 1)];
            (scene::slot_z(&t.props, lo as usize) + scene::slot_z(&t.props, hi as usize)) / 2
        };
        let into = t.now.saturating_sub(t.comp_since);
        let k = render::ease(progress(into, COMP_MS / 3));
        let from = if t.comps == 0 { t.props.table[1] } else { mid(t.comps - 1) };
        pose.z = from + render::mul(mid(t.comps) - from, k);
        pose.stride = render::mul(TURN / 2, k) * (from != mid(t.comps)) as i32;
        pose.carrying = t.applied && t.swapping;
    }
    pose
}

/// Where the file in slot `s` is drawn: on its slot, or (while the comparator in progress swaps it) on its way there
/// from the other slot of the pair, lifted over the other file.
fn file_at(t: &Tutorial, s: usize) -> ([i32; 3], bool) {
    let p = &t.props;
    let (x, z) = (p.table[0], scene::slot_z(p, s));
    let mut at = [x, scene::TABLE_TOP, z];
    let mut lit = false;
    if t.shot == scene::SORT && t.applied && t.comps < NETWORK8.len() {
        let (lo, hi, _) = NETWORK8[t.comps];
        let (lo, hi) = (lo as usize, hi as usize);
        if s == lo || s == hi {
            lit = true;
            if t.swapping {
                let other = if s == lo { hi } else { lo };
                let k = render::ease(progress(t.now.saturating_sub(t.comp_since + COMP_MS / 4), COMP_MS / 2));
                at[2] = scene::slot_z(p, other) + render::mul(z - scene::slot_z(p, other), k);
                let lift = if s == lo { frac(40, 100) } else { frac(12, 100) };
                at[1] += render::mul(lift, render::sin(render::mul(TURN / 2, k)));
            }
        }
    }
    (at, lit)
}

const WHITE: u32 = 0xf2f2f2;
const DIM: u32 = 0x9a9aa2;
const RED: u32 = 0xe8203a;
const OK: u32 = 0x74e0a8;

/// Writes caption line `k` of the current shot into `out`; false when the shot has no such line.
fn caption(t: &Tutorial, d: &Dims, lk: &Locked, boot: &Boot, k: usize, out: &mut Buf<96>) -> bool {
    out.clear();
    // A line cut at the buffer's end is still a line.
    write_caption(t, d, lk, boot, k, out).unwrap_or(true)
}

fn write_caption(t: &Tutorial, d: &Dims, lk: &Locked, boot: &Boot, k: usize, out: &mut Buf<96>) -> Result<bool, core::fmt::Error> {
    let pr = &t.proof;
    match (t.shot, k) {
        (scene::INTRO, 0) => {
            // Roles are spawned in their declared order, so the tutor's slot follows every role before it.
            let at = lk.role_names.iter().position(|&n| n == "tutor").unwrap_or(0);
            let tutor: u32 = lk.role_counts[..at].iter().sum();
            write!(out, "Hello. I'm the tutor: agent #{} of the {} in this machine.", tutor, d.capacity)
        }
        (scene::INTRO, 1) => out.write_str("It just woke up. Before it's yours, we check it, five whys deep."),
        (scene::INTRO, 2) => out.write_str("Each answer is a test that runs right now, while you watch."),
        (scene::MEMORY, 0) => out.write_str("Everything here lives in memory, so we start there."),
        (scene::MEMORY, 1) => {
            write!(out, "At boot I filled all {} MiB with a pattern and read it back: {} wrong.", boot.arena_bytes >> 20, boot.boot_wrong)
        }
        (scene::MEMORY, 2) if t.marched => {
            out.write_str("The store room is locked at ")?;
            grouped(out, boot.allocated as u64)?;
            out.write_str(" bytes. Asking for more: ")?;
            out.write_str(if t.sealed { "refused." } else { "ALLOWED." })
        }
        (scene::COMPUTE, 0) => out.write_str("Can its math be trusted? Rerun the factory's test, and compare."),
        (scene::COMPUTE, 1) => write!(out, "{} agents, {} ticks, the same seed the factory used.", d.capacity, GOLDEN_TICKS),
        (scene::COMPUTE, 2) if t.ran_at != 0 => {
            write!(out, "Factory: {:#010x}. Now: {:#010x}. Same input, same answer.", lk.golden.fingerprint, pr.fingerprint)
        }
        (scene::CONTAINMENT, 0) => out.write_str("Can the agents be trusted? Rule-breakers don't last a tick."),
        (scene::CONTAINMENT, 1) => write!(
            out,
            "Agent {} asked for a key it was never given: gone at tick {}, wiped at {}.",
            pr.rogue,
            matrix::ROGUE_TICK,
            matrix::ROGUE_TICK + 1
        ),
        (scene::CONTAINMENT, 2) => write!(
            out,
            "Agent {} hit the same wall {} times: at tick {} it was wiped clean.",
            pr.looper, d.loop_limit, pr.looper_flushed_at
        ),
        (scene::DISPLAY, 0) => out.write_str("Can you trust what you see? I test the screen itself."),
        (scene::DISPLAY, 1) => {
            out.write_str("I drew ")?;
            grouped(out, t.display.0 as u64)?;
            write!(out, " test pixels on the real screen and read each back: {} wrong.", t.display.1)
        }
        (scene::SORT, 0) if t.sorted_at == 0 => out.write_str("Can you trust me? Watch me sort these eight files."),
        (scene::SORT, 1) if t.sorted_at == 0 => {
            write!(out, "{} compare-and-swaps, the same every time, whatever the files say.", NETWORK8.len())
        }
        (scene::SORT, 0) => write!(out, "Sorted, in {} swaps.", t.swaps),
        (scene::SORT, 1) => write!(out, "And all {} mixes of 0s and 1s come out sorted too,", t.zero_one),
        (scene::SORT, 2) if t.sorted_at != 0 => out.write_str("which proves these moves sort any files at all."),
        (scene::PASSED, 0) => out.write_str("Memory, compute, containment, display, the sort: all checked live."),
        (scene::PASSED, 1) => out.write_str("The machine is yours. Press any key for the terminal."),
        _ => return Ok(false),
    }?;
    Ok(true)
}

fn title(t: &Tutorial, out: &mut Buf<96>) {
    out.clear();
    let _ = match t.shot {
        scene::INTRO => out.write_str("THE TUTORIAL"),
        scene::MEMORY => out.write_str("WHY 1 OF 5: MEMORY"),
        scene::COMPUTE => out.write_str("WHY 2 OF 5: COMPUTE"),
        scene::CONTAINMENT => out.write_str("WHY 3 OF 5: CONTAINMENT"),
        scene::DISPLAY => out.write_str("WHY 4 OF 5: DISPLAY"),
        scene::SORT => out.write_str("WHY 5 OF 5: THE SORT"),
        _ => out.write_str("SELF-TEST PASSED"),
    };
}

/// A dark, see-through box with a crimson edge, for the readouts.
fn panel(tg: &mut Target, x: i32, y: i32, w: i32, h: i32) {
    for yy in y.max(0)..(y + h).min(tg.height as i32) {
        for xx in x.max(0)..(x + w).min(tg.width as i32) {
            let p = &mut tg.pixels[yy as usize * tg.stride + xx as usize];
            *p = render::scale(*p, 36);
        }
    }
    text::fill(tg, x, y, 2, h, RED);
}

/// A readout: a panel as wide as its longest line, the lines in it, and a progress bar after the first when given.
fn readout(tg: &mut Target, x: i32, y: i32, lines: &[(&str, u32)], progress: Option<(u64, u64)>) {
    let w = lines.iter().map(|(s, _)| text::width(s, 1)).max().unwrap_or(0).max(218) + 16;
    let h = 12 + 11 * lines.len() as i32 + if progress.is_some() { 10 } else { 0 };
    panel(tg, x, y, w, h);
    let mut at = y + 6;
    for (k, &(s, rgb)) in lines.iter().enumerate() {
        text::draw(tg, x + 8, at, 1, rgb, s);
        at += 11;
        if let (0, Some((part, whole))) = (k, progress) {
            bar(tg, x + 8, at, w - 16, part, whole, RED);
            at += 10;
        }
    }
}

/// A bar `w` wide, filled `part` of `whole`.
fn bar(tg: &mut Target, x: i32, y: i32, w: i32, part: u64, whole: u64, rgb: u32) {
    text::fill(tg, x, y, w, 5, 0x2a2a30);
    let filled = (part.min(whole) * w as u64 / whole.max(1)) as i32;
    text::fill(tg, x, y, filled, 5, rgb);
}

/// Draws the tutorial's frame into the system's render target.
pub fn render(t: &Tutorial, sys: &mut System, d: &Dims, lk: &Locked, boot: &Boot) {
    let el = t.now.saturating_sub(t.since);
    let shot = &t.shots[t.shot];
    let cam: Camera = scene::camera_of(shot, progress(el, MOVE_MS[t.shot]));
    let (w, h) = (d.display_width, d.display_height);
    let bar_h = h / 10;
    let b = &mut sys.b;
    let m = &sys.m;
    let mut labels = [(0i32, 0i32, false); FILES];
    {
        let mut mesh = Mesh { x: &mut b.tri_x, y: &mut b.tri_y, z: &mut b.tri_z, rgb: &mut b.tri_rgb, n: t.room, dropped: 0 };
        scene::push_tutor(&mut mesh, &tutor_pose(t, el));
        for s in 0..FILES {
            let (at, lit) = file_at(t, s);
            scene::push_file(&mut mesh, at[0], at[1], at[2], lit);
        }
        let pr = &t.proof;
        if pr.trapped_at != u32::MAX && (pr.trap_cell as usize) < m.walls.len() {
            scene::push_trap(&mut mesh, d, pr.trap_cell);
        }
        if t.shot >= scene::COMPUTE && (pr.looper as usize) < m.alive.len() && m.alive[pr.looper as usize] == 1 {
            scene::push_marker(&mut mesh, m, pr.looper as usize, 0xffffff);
        }
        let mut f = Frame { color: &mut b.color, depth: &mut b.zbuf, w, h };
        render::clear(&mut f, FOG.rgb);
        let n = mesh.n;
        render::draw(&mut f, &cam, &mesh, 0, n, &FOG);
        scene::draw_lights(&mut f, &cam, d, m, t.frame);
        let mark = if t.shot >= scene::COMPUTE { [pr.rogue, pr.looper] } else { [u32::MAX; 2] };
        scene::draw_swarm(&mut f, &cam, m, mark);
        render::cinematic(&mut f, t.frame, bar_h);
        if t.shot == scene::SORT {
            for (s, l) in labels.iter_mut().enumerate() {
                let (at, lit) = file_at(t, s);
                if let Some((x, y, _)) = render::screen_of(&f, &cam, [at[0], at[1] + frac(36, 100), at[2]]) {
                    *l = (x, y, lit);
                }
            }
        }
    }
    let mut tg = Target { pixels: &mut b.color, width: w, height: h, stride: w };
    let mut line: Buf<96> = Buf::new();
    // The bars: the system's name and the question.
    let _ = write!(line, "CRIMSON NOIR OS {}", lk.version);
    text::draw(&mut tg, 12, (bar_h as i32 - 8) / 2, 1, DIM, line.as_str());
    title(t, &mut line);
    let tw = text::width(line.as_str(), 1);
    text::draw(&mut tg, w as i32 - 12 - tw, (bar_h as i32 - 8) / 2, 1, if t.shot == scene::PASSED { OK } else { WHITE }, line.as_str());
    // The captions, typed out.
    let start = match t.shot {
        scene::SORT if t.sorted_at != 0 => t.sorted_at,
        _ => t.since + 600,
    };
    let mut budget = (t.now.saturating_sub(start) * LETTERS / 1000) as usize;
    if t.skip {
        budget = usize::MAX;
    }
    let lines = (0..3).filter(|&k| caption(t, d, lk, boot, k, &mut Buf::new())).count() as i32;
    let top = (h - bar_h) as i32 + (bar_h as i32 - lines * 11) / 2;
    for k in 0..3 {
        if !caption(t, d, lk, boot, k, &mut line) {
            continue;
        }
        let s = line.as_str();
        let n = s.len().min(budget);
        budget -= n;
        let x = (w as i32 - text::width(s, 1)) / 2;
        text::draw(&mut tg, x, top + 11 * k as i32, 1, WHITE, &s[..n]);
    }
    overlay(t, &mut tg, d, lk, boot, bar_h as i32, &labels);
}

/// The readouts on top of the picture: the rating card, each check's live numbers, the sorting network, the verdict.
fn overlay(t: &Tutorial, tg: &mut Target, d: &Dims, lk: &Locked, boot: &Boot, top: i32, labels: &[(i32, i32, bool); FILES]) {
    let el = t.now.saturating_sub(t.since);
    let mut line: Buf<96> = Buf::new();
    let (x, y) = (14, top + 10);
    match t.shot {
        scene::INTRO if el < 5_000 => {
            // The content card: the standard the system's words and pictures are written to.
            panel(tg, x, y, 262, 44);
            text::fill(tg, x + 8, y + 8, 30, 28, WHITE);
            text::fill(tg, x + 10, y + 10, 26, 24, 0x101014);
            text::draw(tg, x + 11, y + 18, 1, WHITE, "14A");
            text::draw(tg, x + 46, y + 8, 1, WHITE, "CONTENT STANDARD 14A");
            text::draw(tg, x + 46, y + 20, 1, DIM, "mild suspense; no violence");
            text::draw(tg, x + 46, y + 30, 1, DIM, "self-applied, not a film rating");
        }
        scene::MEMORY => {
            let mut bytes: Buf<96> = Buf::new();
            let _ = grouped(&mut bytes, t.march.done as u64);
            let _ = bytes.write_str(" of ");
            let _ = grouped(&mut bytes, t.march.total as u64);
            let _ = write!(bytes, " bytes, {} wrong", t.march.wrong);
            let seal = if t.sealed { ("SEAL HOLDS", OK) } else { ("SEAL BROKEN", RED) };
            let lines = [("LIVE MEMORY MARCH", WHITE), (bytes.as_str(), DIM), seal];
            let n = if t.marched { 3 } else { 2 };
            readout(tg, x, y, &lines[..n], Some((t.march.done as u64, t.march.total.max(1) as u64)));
        }
        scene::COMPUTE => {
            let pr = &t.proof;
            let (mut head, mut tally, mut prints): (Buf<96>, Buf<96>, Buf<96>) = (Buf::new(), Buf::new(), Buf::new());
            let _ = write!(head, "SCRIPTED RUN  tick {} / {}", pr.tick, GOLDEN_TICKS);
            let _ = write!(tally, "dropped {}  flushed {}  docked ", pr.totals.dropped, pr.totals.flushed);
            let _ = grouped(&mut tally, pr.totals.docked as u64);
            let _ = write!(prints, "now {:#010x}  factory {:#010x}", pr.fingerprint, lk.golden.fingerprint);
            let lines = [(head.as_str(), WHITE), (tally.as_str(), DIM), (prints.as_str(), WHITE), ("MATCH, TO THE LAST BIT", OK)];
            let n = if t.ran_at != 0 { 4 } else { 2 };
            readout(tg, x, y, &lines[..n], Some((pr.tick as u64, GOLDEN_TICKS as u64)));
        }
        scene::CONTAINMENT => {
            let pr = &t.proof;
            let (mut rogue, mut looper, mut limit): (Buf<96>, Buf<96>, Buf<96>) = (Buf::new(), Buf::new(), Buf::new());
            let _ = write!(rogue, "AGENT {}: asked for \"{}\", dropped @{}", pr.rogue, CAPABILITIES[4], matrix::ROGUE_TICK);
            let _ = write!(looper, "AGENT {}: walled in @{}, flushed @{}", pr.looper, pr.trapped_at, pr.looper_flushed_at);
            let _ = write!(limit, "  loop limit {}; {} flushed in all", d.loop_limit, pr.totals.flushed);
            let lines = [(rogue.as_str(), WHITE), ("  its row now: every word zero", DIM), (looper.as_str(), WHITE), (limit.as_str(), DIM)];
            readout(tg, x, y, &lines, None);
        }
        scene::DISPLAY => {
            let (mut pixels, mut fb): (Buf<96>, Buf<96>) = (Buf::new(), Buf::new());
            let _ = grouped(&mut pixels, t.display.0 as u64);
            let _ = write!(pixels, " pixels, {} wrong", t.display.1);
            let _ = write!(fb, "framebuffer {}x{}", boot.screen_w, boot.screen_h);
            let lines = [("SCREEN READ-BACK", WHITE), (pixels.as_str(), if t.display.1 == 0 { OK } else { RED }), (fb.as_str(), DIM)];
            readout(tg, x, y, &lines, None);
        }
        _ => {}
    }
    if t.shot == scene::SORT {
        for (s, &(lx, ly, lit)) in labels.iter().enumerate() {
            if (lx, ly) == (0, 0) {
                continue;
            }
            line.clear();
            let _ = write!(line, "{}", t.keys[s]);
            let lw = text::width(line.as_str(), 2);
            text::draw_shadowed(tg, lx - lw / 2, ly - 16, 2, if lit { RED } else { WHITE }, line.as_str());
        }
    }
    if t.shot == scene::SORT {
        network(t, tg, x, y);
    }
    if t.shot == scene::PASSED {
        let w = tg.width as i32;
        let big = "SELF-TEST PASSED";
        let bw = text::width(big, 3);
        panel(tg, (w - bw) / 2 - 20, top + 24, bw + 40, 120);
        text::draw_shadowed(tg, (w - bw) / 2, top + 36, 3, WHITE, big);
        text::fill(tg, (w - bw) / 2, top + 64, bw, 2, RED);
        let checks = ["MEMORY", "COMPUTE", "CONTAINMENT", "DISPLAY", "THE SORT"];
        for (k, name) in checks.iter().enumerate() {
            line.clear();
            let _ = write!(line, "[ OK ]  WHY {}  {}", k + 1, name);
            text::draw(tg, (w - bw) / 2 + 10, top + 74 + 12 * k as i32, 1, OK, line.as_str());
        }
    }
}

/// The sorting network as a wiring diagram: eight wires, a vertical line per comparator (crimson puts the smaller
/// key on top, amber the larger), the finished ones dim, the one in progress white.
fn network(t: &Tutorial, tg: &mut Target, x: i32, y: i32) {
    let (gap, step) = (6, 7);
    let width = step * NETWORK8.len() as i32 + 12;
    panel(tg, x, y, width + 16, gap * 7 + 30);
    text::draw(tg, x + 8, y + 5, 1, WHITE, "THE NETWORK");
    let (x0, y0) = (x + 10, y + 20);
    for wire in 0..FILES as i32 {
        text::fill(tg, x0, y0 + wire * gap, width, 1, 0x50505a);
    }
    for (c, &(lo, hi, up)) in NETWORK8.iter().enumerate() {
        let cx = x0 + 6 + step * c as i32;
        let rgb = match c.cmp(&t.comps) {
            core::cmp::Ordering::Less => 0x6a2a32,
            core::cmp::Ordering::Equal => WHITE,
            core::cmp::Ordering::Greater => if up { RED } else { 0xd89a2a },
        };
        let (a, b) = (y0 + lo as i32 * gap, y0 + hi as i32 * gap);
        text::fill(tg, cx, a, 1, b - a + 1, rgb);
        text::fill(tg, cx - 1, a - 1, 3, 3, rgb);
        text::fill(tg, cx - 1, b - 1, 3, 3, rgb);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::{parse, validate};
    use crate::system::{self, KEY_ENTER};
    use crate::tests::allocations;
    use std::boxed::Box;
    use std::vec::Vec;

    /// A platform with a real arena to march, and switches to make each live check fail.
    pub(crate) struct Fake {
        pub arena: Vec<u32>,
        pub pos: usize,
        pub wrong: usize,
        pub corrupt: bool,
        pub display_wrong: usize,
        pub seal: bool,
    }

    impl Fake {
        pub(crate) fn new() -> Fake {
            Fake { arena: std::vec![0; 3 << 18], pos: 0, wrong: 0, corrupt: false, display_wrong: 0, seal: true }
        }
    }

    impl Platform for Fake {
        fn march(&mut self, bytes: usize) -> March {
            let end = (self.pos + bytes / 4).min(self.arena.len());
            for i in self.pos..end {
                self.arena[i] = mix32(i as u32) ^ (self.corrupt && i == 1000) as u32;
            }
            for i in self.pos..end {
                self.wrong += (self.arena[i] != mix32(i as u32)) as usize;
            }
            self.pos = end;
            March { done: end * 4, total: self.arena.len() * 4, wrong: self.wrong }
        }
        fn display_test(&mut self) -> (usize, usize) {
            (8192, self.display_wrong)
        }
        fn seal_holds(&mut self) -> bool {
            self.seal
        }
    }

    pub(crate) fn setup() -> (Dims, Locked, Boot, System) {
        let c = validate(&parse(include_str!("../../../containment.nix")).unwrap()).unwrap();
        let d = c.dims;
        let names: Vec<&'static str> = c.roles.iter().map(|r| &*Box::leak(r.name.clone().into_boxed_str())).collect();
        let counts: Vec<u32> = c.roles.iter().map(|r| r.count).collect();
        let caps: Vec<u32> = c.roles.iter().map(|r| r.caps).collect();
        let mut sys = system::allocate(&d);
        let golden = matrix::golden(&d, &counts, &caps, &mut sys.m);
        let canonical = crate::config::canonical(&c);
        let digest = crate::config::digest_hex(&canonical);
        let lk = Locked {
            name: "crimson-noir",
            version: "0.9.0",
            digest: Box::leak(digest.into_boxed_str()),
            canonical: Box::leak(canonical.into_boxed_str()),
            role_names: Box::leak(names.into_boxed_slice()),
            role_counts: Box::leak(counts.into_boxed_slice()),
            role_caps: Box::leak(caps.into_boxed_slice()),
            golden,
        };
        let declared = crate::config::declared_bytes(&d);
        let boot = Boot { arena_bytes: d.arena_bytes, declared, allocated: declared, screen_w: 1280, screen_h: 720, ..Boot::default() };
        (d, lk, boot, sys)
    }

    /// Runs the tutorial at `frame_ms` a frame, pressing `esc_at` (a frame) and a key once it has passed; returns the
    /// outcome, the frames it took, and the shots in the order they were shown.
    fn run(fake: &mut Fake, frame_ms: u64, esc_at: Option<u32>) -> (Outcome, u32, Vec<usize>, Tutorial) {
        let (d, lk, boot, mut sys) = setup();
        let mut t = begin(&mut sys, &d, &lk, 0xc0ffee, 0);
        let mut shots = Vec::with_capacity(16);
        shots.push(t.shot);
        let mut now = 0;
        let before = allocations();
        for frame in 0..20_000u32 {
            now += frame_ms;
            let key = if esc_at == Some(frame) {
                Some(KEY_ESC)
            } else if t.shot == scene::PASSED && frame % 50 == 49 {
                Some(KEY_ENTER)
            } else {
                None
            };
            let out = update(&mut t, &mut sys, &d, &lk, &boot, fake, now, key);
            render(&t, &mut sys, &d, &lk, &boot);
            if *shots.last().unwrap() != t.shot {
                shots.push(t.shot);
            }
            if out != Outcome::Running {
                assert_eq!(allocations(), before, "the tutorial allocated");
                return (out, frame, shots, t);
            }
        }
        panic!("the tutorial never ended");
    }

    #[test]
    fn the_film_runs_every_check_live_and_passes() {
        let mut fake = Fake::new();
        let (out, frames, shots, t) = run(&mut fake, 40, None);
        assert_eq!(out, Outcome::Passed);
        assert_eq!(shots, [0, 1, 2, 3, 4, 5, 6]);
        assert!(t.marched && t.sealed && t.march.done == t.march.total && t.march.total > 0);
        assert_eq!(t.proof.fingerprint, t.proof.fingerprint);
        assert!(is_sorted(&t.keys) && t.zero_one == 256);
        let mut sorted = t.start_keys;
        sorted.sort();
        assert_eq!(t.keys, sorted, "the files are the same files, in order");
        // About a minute of film at 25 frames a second.
        assert!((1_200..2_400).contains(&frames), "{frames} frames");
    }

    #[test]
    fn escape_skips_the_film_but_never_the_checks() {
        let mut fake = Fake::new();
        let (out, frames, shots, t) = run(&mut fake, 40, Some(3));
        assert_eq!(out, Outcome::Passed);
        assert_eq!(shots, [0, 1, 2, 3, 4, 5, 6]);
        assert!(frames < 120, "{frames} frames");
        assert!(t.marched && t.sealed && t.march.done == t.march.total);
        assert_eq!(t.proof.tick, GOLDEN_TICKS);
        assert!(is_sorted(&t.keys) && t.zero_one == 256 && t.comps == NETWORK8.len());
    }

    #[test]
    fn a_key_pressed_as_the_verdict_appears_is_not_lost() {
        let (d, lk, boot, mut sys) = setup();
        let mut fake = Fake::new();
        let mut t = begin(&mut sys, &d, &lk, 1, 0);
        let mut now = 0;
        let mut out = Outcome::Running;
        let mut pressed = false;
        for f in 0..400 {
            now += 40;
            // ESC at once, then a single Enter the first frame the verdict is up.
            let key = match (f, t.shot == scene::PASSED && !pressed) {
                (0, _) => Some(KEY_ESC),
                (_, true) => {
                    pressed = true;
                    Some(KEY_ENTER)
                }
                _ => None,
            };
            out = update(&mut t, &mut sys, &d, &lk, &boot, &mut fake, now, key);
            if out != Outcome::Running {
                break;
            }
        }
        assert!(pressed);
        assert_eq!(out, Outcome::Passed);
    }

    #[test]
    fn a_failed_check_stops_the_film_at_the_fault_screen() {
        let mut fake = Fake::new();
        fake.corrupt = true;
        let (out, _, shots, _) = run(&mut fake, 40, Some(0));
        assert!(matches!(out, Outcome::Failed { title, .. } if title.starts_with("Memory does not hold")), "{out:?}");
        assert_eq!(shots, [0, 1]);
        let mut fake = Fake::new();
        fake.seal = false;
        let (out, ..) = run(&mut fake, 40, Some(0));
        assert!(matches!(out, Outcome::Failed { title, .. } if title.starts_with("Memory was not allocated")), "{out:?}");
        let mut fake = Fake::new();
        fake.display_wrong = 3;
        let (out, _, shots, _) = run(&mut fake, 40, Some(0));
        assert!(matches!(out, Outcome::Failed { title, .. } if title.starts_with("The display")), "{out:?}");
        assert_eq!(shots, [0, 1, 2, 3, 4]);
    }

    #[test]
    fn a_different_build_answer_fails_the_compute_check() {
        let (d, mut lk, boot, mut sys) = setup();
        lk.golden.fingerprint ^= 1;
        let mut t = begin(&mut sys, &d, &lk, 1, 0);
        let mut fake = Fake::new();
        let mut out = Outcome::Running;
        for f in 0..50 {
            out = update(&mut t, &mut sys, &d, &lk, &boot, &mut fake, 40 * f, (f == 0).then_some(KEY_ESC));
            if out != Outcome::Running {
                break;
            }
        }
        assert!(matches!(out, Outcome::Failed { title, .. } if title.starts_with("The compute kernels")), "{out:?}");
    }

    /// Writes frames of the film as PPMs into $NOIR_PREVIEW (a development aid; ignored by default).
    #[test]
    #[ignore]
    fn preview_the_film() {
        let Ok(dir) = std::env::var("NOIR_PREVIEW") else { return };
        let (d, lk, boot, mut sys) = setup();
        let mut fake = Fake::new();
        let mut t = begin(&mut sys, &d, &lk, 0xc0ffee, 0);
        let mut now = 0;
        let mut seen = [0u32; SHOTS];
        for frame in 0..4000u32 {
            now += 40;
            let key = (t.shot == scene::PASSED && seen[scene::PASSED] > 80).then_some(KEY_ENTER);
            if update(&mut t, &mut sys, &d, &lk, &boot, &mut fake, now, key) != Outcome::Running {
                break;
            }
            seen[t.shot] += 1;
            let n = seen[t.shot];
            if n == 1 || n % 60 == 0 || frame % 997 == 0 {
                render(&t, &mut sys, &d, &lk, &boot);
                let (w, h) = (d.display_width, d.display_height);
                let mut out = std::format!("P6\n{w} {h}\n255\n").into_bytes();
                for &p in &sys.b.color {
                    out.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8]);
                }
                std::fs::write(std::format!("{dir}/film_{}_{:04}.ppm", t.shot, n), out).unwrap();
            }
        }
    }
}
