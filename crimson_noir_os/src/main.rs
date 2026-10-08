//! Why does this file exist? It is the hosted runtime of Crimson Noir OS: the same core as the bootable image, on a
//! desktop, with the GPU. `selftest` (the default) runs the self-test's scripted swarm on the CPU and on the GPU (the
//! WGSL kernels through wgpu) and holds both against the build's proof and each other, word for word, then relaxes
//! the routing fields, sorts a million keys and digests the telemetry frames on both; `frames DIR` renders the 5-Whys tutorial and a terminal
//! session as PNG frames; `terminal` is the Crimson Terminal on standard input and output; `info` prints the locked
//! configuration; `bridge [ws://127.0.0.1:PORT]` sends the scripted run's weight ledger to the Phase 12 host for
//! verification and adopts the verified weights in a fresh runtime (bridge.rs; loopback only, token in CRIMSON_TOKEN).
//! The bootable image has none of this. Logging goes through `log` (env_logger: RUST_LOG=info shows the GPU's progress).
//! What breaks if it is removed? The runtime has no entry point.

mod bridge;
mod gpu;
mod host;
mod ledger;
mod telemetry;
mod wire;

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::Instant;

use log::info;
use noir_core::config::{self, Dims};
use noir_core::hash::mix32;
use noir_core::matrix::{self, Matrix};
use noir_core::system::{self, KEY_ENTER, Locked, System};
use noir_core::term::{self, Request};
use noir_core::tutorial::{self, Boot, Outcome};

#[global_allocator]
static ALLOCATOR: host::Sealable = host::Sealable;

/// The tables the runtime was built with (build.rs, from containment.nix).
#[allow(dead_code)]
mod locked {
    include!(concat!(env!("OUT_DIR"), "/locked.rs"));
}

const LOCKED: Locked = Locked {
    name: locked::NAME,
    version: locked::VERSION,
    digest: locked::DIGEST,
    canonical: locked::CANONICAL,
    role_names: &locked::ROLE_NAMES,
    role_counts: &locked::ROLE_COUNTS,
    role_caps: &locked::ROLE_CAPS,
    golden: locked::GOLDEN_PROOF,
};

/// The system's memory, made as the image makes it: the declared allocations, counted against the declaration.
fn allocate(d: &Dims) -> Result<System, String> {
    let before = host::allocated();
    let sys = system::allocate(d);
    let made = host::allocated() - before;
    let declared = config::declared_bytes(d);
    if made != declared {
        return Err(format!("the system allocated {made} bytes, the layout declares {declared}"));
    }
    Ok(sys)
}

/// The first word of the matrices that differ, if any.
fn first_difference(a: &Matrix, b: &Matrix) -> Option<String> {
    let f32s = [("px", &a.px, &b.px), ("pz", &a.pz, &b.pz)];
    for (name, x, y) in f32s {
        if let Some(i) = (0..x.len()).find(|&i| x[i].to_bits() != y[i].to_bits()) {
            return Some(format!("{name}[{i}]: {} on the CPU, {} on the GPU", x[i], y[i]));
        }
    }
    let words = [
        ("alive", &a.alive, &b.alive),
        ("doomed", &a.doomed, &b.doomed),
        ("caps", &a.caps, &b.caps),
        ("req", &a.req, &b.req),
        ("role", &a.role, &b.role),
        ("goal", &a.goal, &b.goal),
        ("run", &a.run, &b.run),
        ("last", &a.last, &b.last),
        ("trips", &a.trips, &b.trips),
        ("clock", &a.clock, &b.clock),
        ("heading", &a.heading, &b.heading),
        ("fate", &a.fate, &b.fate),
        ("memory", &a.memory, &b.memory),
        ("walls", &a.walls, &b.walls),
        ("field", &a.field, &b.field),
    ];
    for (name, x, y) in words {
        if let Some(i) = (0..x.len()).find(|&i| x[i] != y[i]) {
            return Some(format!("{name}[{i}]: {} on the CPU, {} on the GPU", x[i], y[i]));
        }
    }
    (0..a.weights.len()).find(|&i| a.weights[i] != b.weights[i]).map(|i| format!("weights[{i}]: {} on the CPU, {} on the GPU", a.weights[i], b.weights[i]))
}

fn selftest() -> Result<(), String> {
    let d = locked::DIMS;
    println!("{} {}, containment {}", locked::NAME, locked::VERSION, locked::DIGEST);
    let t = Instant::now();
    let mut cpu = matrix::new(&d);
    let p = matrix::golden(&d, &locked::ROLE_COUNTS, &locked::ROLE_CAPS, &mut cpu);
    println!("cpu   scripted run: {} ticks of {} agents in {:.0?}, fingerprint {:#010x}", p.tick, d.capacity, t.elapsed(), p.fingerprint);
    if p != locked::GOLDEN_PROOF {
        return Err(format!("the CPU's scripted run differs from the build's: {p:?}"));
    }
    println!("      = the build's proof (rogue {} dropped and reaped, looper {} flushed at {})", p.rogue, p.looper, p.looper_flushed_at);
    let g = gpu::open()?;
    println!("gpu   {} ({:?}, {})", g.info.name, g.info.backend, g.info.driver_info);
    let t = Instant::now();
    let (gp, gm) = gpu::golden(&g, &d, &locked::ROLE_COUNTS, &locked::ROLE_CAPS);
    println!("gpu   scripted run: {} ticks in {:.0?}, fingerprint {:#010x}", gp.tick, t.elapsed(), gp.fingerprint);
    if let Some(diff) = first_difference(&cpu, &gm) {
        return Err(format!("the GPU's matrix differs from the CPU's: {diff}"));
    }
    if gp != p {
        return Err(format!("the GPU's proof differs from the CPU's: {gp:?}"));
    }
    println!("      = the CPU's matrix, every word, and the same proof");
    let mut world = matrix::new(&d);
    matrix::lay_out_world(&d, &mut world);
    let t = Instant::now();
    let passes = matrix::route(&d, &mut world);
    let cpu_ms = t.elapsed();
    let t = Instant::now();
    let (field, gpu_passes) = gpu::route(&g, &d, &world);
    println!("route {} stations x {} cells: {} passes on the CPU in {:.0?}, {} on the GPU in {:.0?}", d.stations, d.width * d.depth, passes, cpu_ms, gpu_passes, t.elapsed());
    if field != world.field || gpu_passes != passes {
        return Err(String::from("the GPU's routing fields differ from the CPU's"));
    }
    println!("      = the same fields, every cell");
    let n = 1 << 20;
    let keys: Vec<u32> = (0..n as u32).map(|i| mix32(i ^ 0x5eed_5eed)).collect();
    let t = Instant::now();
    let mut want = keys.clone();
    noir_core::sort::bitonic_sort(&mut want);
    let cpu_ms = t.elapsed();
    let t = Instant::now();
    let got = gpu::sort(&g, &keys);
    println!("sort  {} keys with the bitonic network: {:.0?} on the CPU, {:.0?} on the GPU", n, cpu_ms, t.elapsed());
    if got != want || !noir_core::sort::is_sorted(&got) {
        return Err(String::from("the GPU's sort differs from the CPU's"));
    }
    println!("      = the same order, every key");
    // The telemetry digest (Phase 18): the fog's shader against the CPU kernel on a batch of frames, and the pinned
    // vectors folded to the chain head the page pins (telemetry.rs).
    let frames = 1 << 16;
    let words: Vec<u32> = (0..frames as u32 * telemetry::FRAME_WORDS as u32).map(|i| mix32(i ^ 0x7e1e_7e1e)).collect();
    let t = Instant::now();
    let want = telemetry::digests(&words);
    let cpu_ms = t.elapsed();
    let t = Instant::now();
    let got = gpu::digests(&g, &words);
    println!("telem {} frames digested: {:.0?} on the CPU, {:.0?} on the GPU", frames, cpu_ms, t.elapsed());
    if got != want {
        return Err(String::from("the GPU's telemetry digests differ from the CPU's"));
    }
    let mut head = 0;
    for (seq, (vector, digest)) in telemetry::VECTORS.iter().enumerate() {
        if telemetry::frame_digest(vector) != *digest {
            return Err(format!("telemetry vector {seq} does not digest to {digest:#010x}"));
        }
        head = telemetry::chain(head, *digest, seq as u32);
    }
    if head != telemetry::VECTORS_CHAIN {
        return Err(format!("the telemetry vectors chain to {head:#010x}, not {:#010x}", telemetry::VECTORS_CHAIN));
    }
    println!("      = the same digests, every frame; the pinned vectors chain to {:#010x}", head);
    println!("SELFTEST PASS");
    Ok(())
}

fn boot_facts(d: &Dims, host: &mut host::Host) -> Boot {
    let declared = config::declared_bytes(d);
    let mut whole = vec![0u32; d.arena_bytes / 4];
    let t = Instant::now();
    let boot_wrong = host::march(&mut whole);
    Boot {
        arena_bytes: d.arena_bytes,
        boot_wrong,
        march_ms: t.elapsed().as_millis() as u32,
        declared,
        allocated: declared,
        screen_w: (host.screen.len() as f64).sqrt() as usize,
        screen_h: (host.screen.len() as f64).sqrt() as usize,
    }
}

/// The tutorial at 25 frames a second, then a short terminal session, as PNGs in `dir` at the render target's own
/// size (a frame every two seconds, and the first of every shot).
fn frames(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
    let d = locked::DIMS;
    let mut sys = allocate(&d)?;
    let mut host = host::Host::new(d.arena_bytes - config::declared_bytes(&d), 1280 * 720);
    let mut boot = boot_facts(&d, &mut host);
    (boot.screen_w, boot.screen_h) = (1280, 720);
    let (w, h) = (d.display_width, d.display_height);
    let save = |sys: &System, name: &str| -> Result<(), String> {
        let path = format!("{dir}/{name}.png");
        std::fs::write(&path, host::png(&sys.b.color, w, h, 1)).map_err(|e| format!("{path}: {e}"))?;
        println!("{path}");
        Ok(())
    };
    let mut t = host::sealed(|| tutorial::begin(&mut sys, &d, &LOCKED, 0xc0ffee, 0));
    let (mut now, mut shot, mut written) = (0u64, usize::MAX, 0u64);
    loop {
        now += 40;
        let key = (t.shot == noir_core::scene::PASSED && now > t.since + 4000).then_some(KEY_ENTER);
        let out = host::sealed(|| {
            let out = tutorial::update(&mut t, &mut sys, &d, &LOCKED, &boot, &mut host, now, key);
            tutorial::render(&t, &mut sys, &d, &LOCKED, &boot);
            out
        });
        match out {
            Outcome::Running => {}
            Outcome::Passed => break,
            Outcome::Failed { title, detail } => {
                return Err(format!("{title}: {detail} (march {:?}, sealed {}, boot {:?})", t.march, t.sealed, boot));
            }
        }
        if t.shot != shot || now >= written + 2000 {
            shot = t.shot;
            written = now;
            save(&sys, &format!("tutorial-{:06}", now))?;
        }
    }
    let mut c = host::sealed(|| term::open(&mut sys, &d, &LOCKED));
    for line in ["help", ": sq dup * ;", "10 0 do i sq . loop", "cap-spawn 5 ask 1 tick 5 agent", "golden", "digest", "map 42 mark go"] {
        host::sealed(|| term::run_line(&mut c, &mut sys, &LOCKED, line));
    }
    for f in 0..90u64 {
        host::sealed(|| {
            term::frame(&mut c, &mut sys, now + f * 17);
            term::render(&c, &mut sys, &LOCKED);
        });
    }
    save(&sys, "terminal")?;
    Ok(())
}

/// The Crimson Terminal on standard input and output (the swarm ticks only when told to: `tick`).
fn terminal() -> Result<(), String> {
    let d = locked::DIMS;
    let mut sys = allocate(&d)?;
    let mut c = host::sealed(|| {
        matrix::golden(&d, &locked::ROLE_COUNTS, &locked::ROLE_CAPS, &mut sys.m);
        term::open(&mut sys, &d, &LOCKED)
    });
    let print = |c: &term::Term, sys: &System, from: usize| {
        let mut out = std::io::stdout().lock();
        for k in from..c.lines {
            let line = &sys.b.term_text[k * config::TERM_COLS..(k + 1) * config::TERM_COLS];
            let _ = writeln!(out, "{}", String::from_utf8_lossy(line).trim_end());
        }
        let _ = out.flush();
    };
    print(&c, &sys, 0);
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        (c.lines, c.col, c.pending) = (0, 0, false);
        host::sealed(|| term::run_line(&mut c, &mut sys, &LOCKED, line.trim_end()));
        print(&c, &sys, 1);
        match c.request {
            Request::None => {}
            Request::Halt => break,
            Request::Reboot | Request::Tutorial => {
                println!("(reboot and tutorial are the bootable image's; here: halt ends the session, frames renders the tutorial)");
                c.request = Request::None;
            }
        }
    }
    Ok(())
}

fn info_command() {
    println!("{} {}", locked::NAME, locked::VERSION);
    println!("containment.lock {}", locked::DIGEST);
    println!("{}", locked::CANONICAL);
    println!("declared memory: {} bytes of the {} the arena allows", config::declared_bytes(&locked::DIMS), locked::DIMS.arena_bytes);
    println!("the scripted run's fingerprint, as built: {:#010x}", locked::GOLDEN);
}

/// The bridge to the host's ledger door. The token comes from the environment, never the command line.
fn bridge_command(url: &str) -> Result<(), String> {
    let token = std::env::var("CRIMSON_TOKEN").map_err(|_| String::from("set CRIMSON_TOKEN to a session token the host's operator minted"))?;
    let lk = bridge::Locked { canonical: locked::CANONICAL, dims: locked::DIMS, role_counts: &locked::ROLE_COUNTS, role_caps: &locked::ROLE_CAPS };
    bridge::run(url, token.trim(), &lk)
}

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        None | Some("selftest") => selftest(),
        Some("frames") => frames(args.get(2).map_or("frames", String::as_str)),
        Some("terminal") => terminal(),
        Some("info") => {
            info_command();
            Ok(())
        }
        Some("seal") => {
            // The scripted run's seal, for the host's ledger door (containment.seal is this output).
            let (m, _, l) = ledger::record_golden(&locked::DIMS, &locked::ROLE_COUNTS, &locked::ROLE_CAPS);
            print!("{}", ledger::seal_text(&l, &m.weights, locked::DIGEST));
            Ok(())
        }
        Some("canonical") => {
            // The locked configuration's canonical form, byte for byte (containment.canonical is this output).
            print!("{}", locked::CANONICAL);
            Ok(())
        }
        Some("bridge") => bridge_command(args.get(2).map_or("ws://127.0.0.1:8787", String::as_str)),
        Some(other) => Err(format!("unknown command {other}: selftest (the default), frames DIR, terminal, info, canonical, seal, bridge [URL]")),
    };
    info!("done");
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("FAIL: {e}");
            ExitCode::FAILURE
        }
    }
}
