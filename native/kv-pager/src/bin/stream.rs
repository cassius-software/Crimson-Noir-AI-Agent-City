// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 05: the `stream` run. A GGUF file is read in swarm decode steps, as a host too small for the model would read
//! it, and the drive is measured.
//!
//! Why does this file exist? The weight streamer (stage 04) is only worth something at the speed a real drive gives it.
//! This run measures that speed on the machine it runs on and shows what the swarm planner does with it:
//! 1. the file: a GGUF model given with `--model`, or a synthetic mixture-of-experts file written to the temporary
//!    folder (every byte a hash of its position, so every read is checked);
//! 2. the drive: one sequential sweep and a series of single 4 KiB reads at random places, giving the cost model its
//!    bandwidth and its cost per request;
//! 3. swarm steps for growing agent counts: each agent's router picks its experts at every layer (uniform or skewed),
//!    the planner chooses per layer between the whole layer and only the routed experts, the streamer reads the chosen
//!    plan one layer ahead, and the time and bytes of each step are printed beside the planner's estimate;
//! 4. estimates for two real model shapes (Qwen3-30B-A3B and gpt-oss-20b, from their tensor shapes alone, no weights
//!    read): the agent count at which reading the whole layer becomes cheaper, on a reference NVMe drive and on this
//!    drive.
//!
//! The token-embedding and output tensors are held in memory, as a host would hold them; only the layers stream.
//! What breaks if it is removed? Nothing ships with it; the streamer's speed on a real drive has no source.
//!
//! cargo run --release --bin stream -- [--model path.gguf] [--layers 4] [--experts 64] [--used 8] [--steps 2]
//!   [--agents 1,2,4,8,16,32,64,256,1024] [--routing uniform|skewed|both] [--buffered] [--depth 2] [--threads 4] [--keep]
//!
//! A synthetic file was just written, so a buffered run reads it from the page cache (memory, not the drive); the run
//! reads unbuffered by default for that reason. Where the file system refuses unbuffered reads the run says so.

use kv_pager::weights::gguf::write::{byte_at, header, Meta, Tensor};
use kv_pager::weights::gguf::{Extent, Gguf, UnitKey, WeightIndex};
use kv_pager::weights::stream::{AlignedBuf, IoMode, SectorFile, StreamConfig, Streamer, SECTOR};
use kv_pager::weights::swarm::{IoCost, Regime, Route, SwarmScheduler};
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const F32: u32 = 0;
const Q4_K: u32 = 12;
const Q6_K: u32 = 14;
const Q8_0: u32 = 8;
const MXFP4: u32 = 39;
const MB: f64 = 1e6;

/// splitmix64.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn t(name: impl Into<String>, dims: &[u64], ggml_type: u32) -> Tensor {
    Tensor { name: name.into(), dims: dims.to_vec(), ggml_type }
}

/// A mixture-of-experts model's tensors in llama.cpp's naming: attention, router, and stacked `_exps` experts per layer.
struct Shape {
    arch: &'static str,
    layers: u32,
    experts: u64,
    used: u32,
    hidden: u64,
    q_dim: u64,
    kv_dim: u64,
    ff: u64,
    vocab: u64,
    attn_type: u32,
    gate_up_type: u32,
    down_type: u32,
    embd_type: u32,
}

impl Shape {
    fn tensors(&self) -> (Vec<(&'static str, Meta)>, Vec<Tensor>) {
        let (h, e, ff) = (self.hidden, self.experts, self.ff);
        let mut ts = vec![t("token_embd.weight", &[h, self.vocab], self.embd_type)];
        for l in 0..self.layers {
            let b = |n: &str| format!("blk.{l}.{n}.weight");
            ts.push(t(b("attn_norm"), &[h], F32));
            ts.push(t(b("attn_q"), &[h, self.q_dim], self.attn_type));
            ts.push(t(b("attn_k"), &[h, self.kv_dim], self.attn_type));
            ts.push(t(b("attn_v"), &[h, self.kv_dim], self.attn_type));
            ts.push(t(b("attn_output"), &[self.q_dim, h], self.attn_type));
            ts.push(t(b("ffn_norm"), &[h], F32));
            ts.push(t(b("ffn_gate_inp"), &[h, e], F32));
            ts.push(t(b("ffn_gate_exps"), &[h, ff, e], self.gate_up_type));
            ts.push(t(b("ffn_up_exps"), &[h, ff, e], self.gate_up_type));
            ts.push(t(b("ffn_down_exps"), &[ff, h, e], self.down_type));
        }
        ts.push(t("output_norm.weight", &[h], F32));
        ts.push(t("output.weight", &[h, self.vocab], self.embd_type));
        let key = |k: &str| -> &'static str { Box::leak(format!("{}.{k}", self.arch).into_boxed_str()) };
        let meta = vec![
            ("general.architecture", Meta::Str(self.arch.into())),
            ("general.alignment", Meta::U32(32)),
            (key("block_count"), Meta::U32(self.layers)),
            (key("expert_count"), Meta::U32(e as u32)),
            (key("expert_used_count"), Meta::U32(self.used)),
        ];
        (meta, ts)
    }

    /// The index of a file of this shape, from its header alone.
    fn index(&self) -> WeightIndex {
        let (meta, ts) = self.tensors();
        let (head, places) = header(&meta, &ts, 32);
        let len = places.last().map_or(head.len() as u64, |&(at, size)| at + size);
        let g = Gguf::parse(&head, len).expect("a well-formed header");
        WeightIndex::build(&g).expect("an indexable shape")
    }
}

/// Qwen3-30B-A3B (48 layers, 128 experts of 768, 8 per token) at a Q4_K_M-like mix.
const QWEN3_30B_A3B: Shape = Shape {
    arch: "qwen3moe",
    layers: 48,
    experts: 128,
    used: 8,
    hidden: 2048,
    q_dim: 4096,
    kv_dim: 512,
    ff: 768,
    vocab: 151_936,
    attn_type: Q4_K,
    gate_up_type: Q4_K,
    down_type: Q6_K,
    embd_type: Q6_K,
};

/// gpt-oss-20b (24 layers, 32 experts of 2880, 4 per token) with MXFP4 experts, as published.
const GPT_OSS_20B: Shape = Shape {
    arch: "gpt-oss",
    layers: 24,
    experts: 32,
    used: 4,
    hidden: 2880,
    q_dim: 4096,
    kv_dim: 512,
    ff: 2880,
    vocab: 201_088,
    attn_type: Q8_0,
    gate_up_type: MXFP4,
    down_type: MXFP4,
    embd_type: Q8_0,
};

/// Writes a synthetic file of `shape` to `path` in 1 MiB pieces (never the whole file in memory).
fn write_synthetic(path: &Path, shape: &Shape) -> io::Result<u64> {
    let (meta, ts) = shape.tensors();
    let (head, places) = header(&meta, &ts, 32);
    let mut f = io::BufWriter::new(File::create(path)?);
    f.write_all(&head)?;
    let mut chunk = Vec::with_capacity(1 << 20);
    for (at, size) in places {
        f.seek(SeekFrom::Start(at))?;
        let mut pos = at;
        while pos < at + size {
            let n = (at + size - pos).min(1 << 20);
            chunk.clear();
            chunk.extend((pos..pos + n).map(byte_at));
            f.write_all(&chunk)?;
            pos += n;
        }
    }
    f.flush()?;
    let len = f.get_ref().metadata()?.len();
    f.get_ref().sync_all()?;
    Ok(len)
}

/// The drive's bandwidth (one sweep of `extent`, read in 8 MiB pieces) and its cost per request (`n` single-sector
/// reads at random places, one at a time).
fn measure(path: &Path, mode: IoMode, sweep: Extent, n: usize) -> io::Result<(IoCost, IoMode)> {
    let mut f = SectorFile::open(path, mode)?;
    let start = sweep.offset / SECTOR * SECTOR;
    let end = sweep.end().next_multiple_of(SECTOR).min(f.len().next_multiple_of(SECTOR));
    let mut buf = AlignedBuf::new(8 << 20);
    let t = Instant::now();
    let mut pos = start;
    let mut moved = 0u64;
    while pos < end {
        let len = ((end - pos) as usize).min(buf.len());
        moved += f.read_full(pos, &mut buf.as_mut_slice()[..len])? as u64;
        pos += len as u64;
    }
    let bytes_per_sec = moved as f64 / t.elapsed().as_secs_f64().max(1e-9);
    let mut rng = Rng(0x5eed);
    let sectors = f.len() / SECTOR;
    let mut one = AlignedBuf::new(SECTOR as usize);
    let t = Instant::now();
    for _ in 0..n {
        let at = rng.next() % sectors.max(1) * SECTOR;
        f.read_full(at, one.as_mut_slice())?;
    }
    let per_read = t.elapsed().as_secs_f64() / n.max(1) as f64;
    let sec_per_request = (per_read - SECTOR as f64 / bytes_per_sec).max(1e-6);
    Ok((IoCost { bytes_per_sec, sec_per_request }, f.mode()))
}

#[derive(Clone, Copy, PartialEq)]
enum Routing {
    Uniform,
    /// A Zipf law over a per-layer order of the experts: a few experts take most tokens, as real routers do.
    Skewed,
}

/// Every agent's experts at one layer of one step.
fn routes(agents: u32, experts: u32, used: u32, routing: Routing, seed: u64) -> Vec<Route> {
    let harmonic: f64 = (1..=experts).map(|k| 1.0 / f64::from(k)).sum();
    // The per-layer order of the experts for the skewed router.
    let mut order: Vec<u32> = (0..experts).collect();
    let mut rng = Rng(seed);
    for i in (1..order.len()).rev() {
        order.swap(i, (rng.next() % (i as u64 + 1)) as usize);
    }
    (0..agents)
        .map(|agent| {
            let mut rng = Rng(seed ^ (u64::from(agent) << 32) ^ 0xa5a5);
            let mut picked: Vec<u32> = Vec::with_capacity(used as usize);
            while picked.len() < used.min(experts) as usize {
                let e = match routing {
                    Routing::Uniform => (rng.next() % u64::from(experts)) as u32,
                    Routing::Skewed => {
                        let target = rng.unit() * harmonic;
                        let mut acc = 0.0;
                        let mut k = experts - 1;
                        for r in 0..experts {
                            acc += 1.0 / f64::from(r + 1);
                            if acc >= target {
                                k = r;
                                break;
                            }
                        }
                        order[k as usize]
                    }
                };
                if !picked.contains(&e) {
                    picked.push(e);
                }
            }
            Route { agent, experts: picked }
        })
        .collect()
}

struct StepReport {
    whole_layers: usize,
    routed_layers: usize,
    read_bytes: u64,
    useful_bytes: u64,
    estimate: f64,
    /// The reader's time in its reads (the drive's share), and the step's wall time (checking every byte included).
    read_seconds: f64,
    seconds: f64,
}

impl StepReport {
    fn add(&mut self, r: &StepReport) {
        self.whole_layers += r.whole_layers;
        self.routed_layers += r.routed_layers;
        self.read_bytes += r.read_bytes;
        self.useful_bytes += r.useful_bytes;
        self.estimate += r.estimate;
        self.read_seconds += r.read_seconds;
        self.seconds += r.seconds;
    }
}

const NO_STEP: StepReport =
    StepReport { whole_layers: 0, routed_layers: 0, read_bytes: 0, useful_bytes: 0, estimate: 0.0, read_seconds: 0.0, seconds: 0.0 };

/// One decode step of `agents`: plan every layer, read the plans through the ring one layer ahead, check every byte
/// (synthetic files), and time it.
fn step(
    streamer: &mut Streamer,
    planner: &SwarmScheduler,
    index: &WeightIndex,
    agents: u32,
    routing: Routing,
    seed: u64,
    synthetic: bool,
) -> io::Result<StepReport> {
    let in_memory = |k: UnitKey| k == UnitKey::Globals;
    let all: Vec<Vec<Route>> = (0..index.layers)
        .map(|l| routes(agents, index.experts, index.experts_used, routing, seed ^ (u64::from(l) << 16)))
        .collect();
    let plans = planner.plan_step(&all, &in_memory);
    let mut r = NO_STEP;
    let t = Instant::now();
    let mut wanted: Vec<Vec<Extent>> = Vec::new();
    for p in &plans {
        match p.regime {
            Regime::WholeLayer => r.whole_layers += 1,
            Regime::RoutedExperts => r.routed_layers += 1,
        }
        r.estimate += p.seconds;
        r.useful_bytes += p.reads.useful;
        let extents: Vec<Extent> = p.units.iter().filter_map(|&k| index.unit(k)).flat_map(|u| u.extents.iter().copied()).collect();
        streamer.request(&extents)?;
        wanted.push(extents);
    }
    for extents in &wanted {
        let staged = streamer.next().expect("one unit per request")?;
        r.read_bytes += staged.read_bytes;
        r.read_seconds += staged.read_time.as_secs_f64();
        if synthetic {
            for (i, e) in extents.iter().enumerate() {
                let got = staged.extent(i);
                if got.len() as u64 != e.len {
                    return Err(io::Error::other(format!("{} bytes at {} came back as {}", e.len, e.offset, got.len())));
                }
                if let Some(at) = (0..e.len).find(|&at| got[at as usize] != byte_at(e.offset + at)) {
                    return Err(io::Error::other(format!("byte {} of the file read back wrong", e.offset + at)));
                }
            }
        }
    }
    r.seconds = t.elapsed().as_secs_f64();
    Ok(r)
}

fn main() -> io::Result<()> {
    let mut model: Option<PathBuf> = None;
    let mut layers = 4u32;
    let mut experts = 64u64;
    let mut used = 8u32;
    let mut steps = 2u32;
    let mut agent_counts: Vec<u32> = vec![1, 2, 4, 8, 16, 32, 64, 256, 1024];
    let mut routings = vec![Routing::Uniform, Routing::Skewed];
    let mut mode = IoMode::Direct;
    let mut depth = 2usize;
    let mut threads = 4usize;
    let mut keep = false;
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().unwrap_or_else(|| panic!("{k} needs a value"));
        let num = |v: String| -> u64 { v.parse().unwrap_or_else(|_| panic!("{v} is not a number")) };
        match k.as_str() {
            "--model" => model = Some(PathBuf::from(val())),
            "--layers" => layers = num(val()) as u32,
            "--experts" => experts = num(val()),
            "--used" => used = num(val()) as u32,
            "--steps" => steps = num(val()) as u32,
            "--agents" => agent_counts = val().split(',').map(|v| num(v.to_string()) as u32).collect(),
            "--routing" => {
                routings = match val().as_str() {
                    "uniform" => vec![Routing::Uniform],
                    "skewed" => vec![Routing::Skewed],
                    _ => vec![Routing::Uniform, Routing::Skewed],
                }
            }
            "--depth" => depth = num(val()) as usize,
            "--threads" => threads = num(val()) as usize,
            "--buffered" => mode = IoMode::Buffered,
            "--keep" => keep = true,
            _ => panic!("unknown argument {k}"),
        }
    }

    let synthetic = model.is_none();
    let path = match &model {
        Some(p) => p.clone(),
        None => {
            let shape = Shape {
                arch: "qwen3moe",
                layers,
                experts,
                used,
                hidden: 1024,
                q_dim: 1024,
                kv_dim: 256,
                ff: 512,
                vocab: 32_000,
                attn_type: Q4_K,
                gate_up_type: Q4_K,
                down_type: Q8_0,
                embd_type: Q8_0,
            };
            let p = std::env::temp_dir().join(format!("kv-pager-stream-{}.gguf", std::process::id()));
            let t = Instant::now();
            let len = write_synthetic(&p, &shape)?;
            println!("synthetic model: {} ({:.0} MB, {layers} layers, {experts} experts, {used} per token), written in {:.1} s", p.display(), len as f64 / MB, t.elapsed().as_secs_f64());
            p
        }
    };
    let g = Gguf::open(&path).map_err(|e| io::Error::other(e.to_string()))?;
    let index = WeightIndex::build(&g).map_err(|e| io::Error::other(e.to_string()))?;
    println!(
        "model: {} ({}), {} layers, {} experts ({} per token), {:.0} MB in all, {:.1} MB of layers read per token by one agent",
        path.display(),
        index.architecture,
        index.layers,
        index.experts,
        index.experts_used,
        index.total_bytes() as f64 / MB,
        index.active_bytes_per_token() as f64 / MB
    );

    // The sweep: up to 512 MB of the file from the first layer on.
    let first = index
        .unit(UnitKey::Layer(0))
        .and_then(|u| u.extents.iter().map(|e| e.offset).min())
        .ok_or_else(|| io::Error::other("the model has no layer 0 to stream"))?;
    let sweep = Extent { offset: first, len: (g.file_len - first).min(512 << 20) };
    let (cost, got) = measure(&path, mode, sweep, 512)?;
    println!(
        "drive ({}): {:.0} MB/s sequential, {:.0} µs per 4 KiB read at a random place (one at a time)",
        match got {
            IoMode::Direct => "unbuffered",
            IoMode::Buffered if mode == IoMode::Direct => "buffered: this file system refused unbuffered reads, so the page cache answers",
            IoMode::Buffered => "buffered, page cache",
        },
        cost.bytes_per_sec / MB,
        cost.sec_per_request * 1e6
    );

    let planner = SwarmScheduler::new(&index, cost, 64 << 10);
    let mut streamer = Streamer::open(&path, StreamConfig { mode, depth, threads, merge_gap: 64 << 10 })?;
    for &routing in &routings {
        println!(
            "swarm steps, {} routing ({} steps each; layers read one ahead through {depth} buffers on {threads} handles):",
            if routing == Routing::Uniform { "uniform" } else { "skewed (Zipf)" },
            steps
        );
        println!("  agents  layers whole/routed  MB read/step  useful MB  estimate ms  read ms   MB/s   ms/agent  wall ms{}", if synthetic { " (every byte checked)" } else { "" });
        for &n in &agent_counts {
            let mut total = NO_STEP;
            for s in 0..steps {
                total.add(&step(&mut streamer, &planner, &index, n, routing, u64::from(s) * 7919 + u64::from(n), synthetic)?);
            }
            let k = f64::from(steps.max(1));
            println!(
                "  {n:>6}  {:>8.1}/{:<8.1}  {:>12.1}  {:>9.1}  {:>11.1}  {:>7.1}  {:>5.0}  {:>9.3}  {:>7.1}",
                total.whole_layers as f64 / k,
                total.routed_layers as f64 / k,
                total.read_bytes as f64 / k / MB,
                total.useful_bytes as f64 / k / MB,
                total.estimate / k * 1e3,
                total.read_seconds / k * 1e3,
                total.read_bytes as f64 / total.read_seconds.max(1e-9) / MB,
                total.read_seconds / k * 1e3 / f64::from(n.max(1)),
                total.seconds / k * 1e3
            );
        }
        match planner.crossover_agents(0, 1 << 16) {
            Some(n) => println!("  uniform-routing estimate: the whole layer is strictly cheaper from {n} agents on this drive"),
            None => println!("  uniform-routing estimate: skipping an unrouted expert always pays on this drive; the whole layer is read once every expert is routed"),
        }
    }
    drop(streamer);

    println!("estimates from tensor shapes alone (planned, not read: no weights here; layers streamed, embeddings in memory):");
    for (name, shape) in [("Qwen3-30B-A3B", &QWEN3_30B_A3B), ("gpt-oss-20b", &GPT_OSS_20B)] {
        let idx = shape.index();
        println!(
            "  {name}: {:.1} GB, {} layers, {} experts ({} per token); per decode step of the whole swarm:",
            idx.total_bytes() as f64 / 1e9,
            idx.layers,
            idx.experts,
            idx.experts_used
        );
        for routing in [Routing::Uniform, Routing::Skewed] {
            let mut row = String::new();
            for n in [1u32, 4, 16, 64, 256, 1024] {
                let all: Vec<Vec<Route>> =
                    (0..idx.layers).map(|l| routes(n, idx.experts, idx.experts_used, routing, 99 ^ (u64::from(l) << 16))).collect();
                let in_memory = |k: UnitKey| k == UnitKey::Globals;
                let at = |c: IoCost| -> (f64, f64) {
                    let plans = SwarmScheduler::new(&idx, c, 64 << 10).plan_step(&all, &in_memory);
                    (plans.iter().map(|p| p.reads.read_bytes() as f64).sum(), plans.iter().map(|p| p.seconds).sum())
                };
                let ((bytes, nvme), (_, here)) = (at(IoCost::NVME), at(cost));
                row.push_str(&format!("\n      {n:>5} agents: {:>5.2} GB, {:>5.2} s on the reference drive, {:>5.2} s on this one", bytes / 1e9, nvme, here));
            }
            println!("    {} routing:{row}", if routing == Routing::Uniform { "uniform" } else { "skewed" });
        }
    }
    println!("  (reference drive: 2 GB/s, 100 µs a request. A step's time is shared by every agent in it. A host whose free");
    println!("  memory holds part of the model reads only the rest: these are the costs with nothing cached.)");
    if synthetic && !keep {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}
