//! Why does this file exist? It is the headless stress run of the paged KV cache on the real GPU: 100 agents on the
//! 16 × 16 block grid, in squads that share one briefing (a fork), each walking a route of its own so their sequences
//! part. It records, step by step, what the fixed pool holds, what copy-on-write copied, and what the same agents would
//! need with no sharing (a second page table of the same size, which refuses them); then it runs the decode kernel on
//! the pool and checks every agent's attention against a CPU reference built from that agent's own tokens alone.
//! What breaks if it is removed? Nothing ships with it; the telemetry has no source.
//!
//! Keys and values are synthetic (no model weights here): a token's K/V are a hash of the chain of tokens up to and
//! including it, so two agents hold the same K/V at a position exactly when their prompts agree up to there, as with a
//! real model. Tokens come from a stand-in word tokenizer, not the model's own: counts are close, not exact.
//!
//! cargo run --release --features gpu --bin stress -- [--pool-mib 2048] [--steps 24] [--seed 7] [--skip-cow-copy]

use kv_pager::gpu::{f16_bits, f16_value, Decode, Gpu, KvPool};
use kv_pager::{AgentId, PageError, PageTable, Slot, Token, BLOCK_TOKENS, DEFAULT_MODEL};
use std::fmt::Write as _;
use std::time::Instant;

const GRID: i32 = 16;
const SQUADS: u32 = 10;
const PER_SQUAD: u32 = 10;
const AGENTS: u32 = SQUADS * PER_SQUAD;
const CONTEXT_TOKENS: usize = 8192;
/// Observation tokens: [OBS, x, y, heading].
const OBS: Token = 1;
const X0: Token = 2;
const Y0: Token = X0 + GRID as Token;
const H0: Token = Y0 + GRID as Token;

const SOURCE: &str = include_str!("../../../../src/09_Cognition/localCompute.ts");

/// The BASE_REALITY lines of localCompute.ts, joined as the page joins them.
fn base_reality() -> String {
    let start = SOURCE.find("export const BASE_REALITY = [").expect("BASE_REALITY in localCompute.ts");
    let body = &SOURCE[start..];
    let body = &body[..body.find("].join").expect("BASE_REALITY's join")];
    let lines: Vec<&str> = body.lines().skip(1).filter_map(|l| l.trim().strip_prefix('\'')?.strip_suffix("',")).collect();
    assert!(lines.len() >= 3, "BASE_REALITY lines");
    lines.join("\n")
}

/// Stand-in tokenizer: words and punctuation, each hashed into a 151,936-entry vocabulary (above the grid tokens).
fn tokenize(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut word = String::new();
    let push = |w: &str, out: &mut Vec<Token>| {
        if !w.is_empty() {
            let h = w.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3));
            out.push(64 + (h % 151_872) as Token);
        }
    };
    for c in text.chars() {
        if c.is_alphanumeric() || c == '\'' {
            word.push(c);
        } else {
            push(&word, &mut out);
            word.clear();
            if !c.is_whitespace() {
                push(&c.to_string(), &mut out);
            }
        }
    }
    push(&word, &mut out);
    out
}

fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        mix(self.0)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// The synthetic K and V of one token for one layer, from the hash of its chain: `token_words` words each.
fn kv_words(chain: u64, layer: usize, words: usize) -> (Vec<u32>, Vec<u32>) {
    let mut s = mix(chain ^ (layer as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
    let mut val = || {
        s = mix(s.wrapping_add(0x9e37_79b9_7f4a_7c15));
        f16_bits(((s >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0)
    };
    let mut pack = || (0..words).map(|_| u32::from(val()) | u32::from(val()) << 16).collect::<Vec<u32>>();
    let k = pack();
    let v = pack();
    (k, v)
}

/// The chain hash at every position of a token sequence.
fn chains(tokens: &[Token]) -> Vec<u64> {
    let mut h = 0x243f_6a88_85a3_08d3u64;
    tokens.iter().map(|&t| { h = mix(h ^ u64::from(t).wrapping_mul(0xff51_afd7_ed55_8ccd)); h }).collect()
}

struct Agent {
    id: AgentId,
    x: i32,
    y: i32,
    goal: (i32, i32),
    rng: Rng,
    /// Everything this agent will have appended: identity, then its observations (the baseline replays it).
    appended: Vec<Token>,
}

impl Agent {
    /// One move on the grid toward its goal (a detour one time in five), as observation tokens.
    fn walk(&mut self) -> [Token; 4] {
        if (self.x, self.y) == self.goal {
            self.goal = (self.rng.below(GRID as u64) as i32, self.rng.below(GRID as u64) as i32);
        }
        let (dx, dy) = (self.goal.0 - self.x, self.goal.1 - self.y);
        let heading = if self.rng.below(5) == 0 || (dx == 0 && dy == 0) {
            self.rng.below(4) as usize
        } else if dy != 0 && (dx == 0 || self.rng.below(2) == 0) {
            if dy < 0 { 0 } else { 2 }
        } else if dx > 0 { 1 } else { 3 };
        let (mx, my) = [(0, -1), (1, 0), (0, 1), (-1, 0)][heading];
        self.x = (self.x + mx).clamp(0, GRID - 1);
        self.y = (self.y + my).clamp(0, GRID - 1);
        [OBS, X0 + self.x as Token, Y0 + self.y as Token, H0 + heading as Token]
    }
}

struct Args {
    pool_mib: u64,
    steps: usize,
    seed: u64,
    skip_cow_copy: bool,
    verify_layers: Vec<usize>,
    out: String,
}

fn args() -> Args {
    let mut a = Args { pool_mib: 2048, steps: 24, seed: 7, skip_cow_copy: false, verify_layers: vec![0, 17, 35], out: "telemetry".into() };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().unwrap_or_else(|| panic!("{k} needs a value"));
        match k.as_str() {
            "--pool-mib" => a.pool_mib = val().parse().expect("--pool-mib"),
            "--steps" => a.steps = val().parse().expect("--steps"),
            "--seed" => a.seed = val().parse().expect("--seed"),
            "--skip-cow-copy" => a.skip_cow_copy = true,
            "--verify-all-layers" => a.verify_layers = (0..DEFAULT_MODEL.layers).collect(),
            "--out" => a.out = val(),
            _ => panic!("unknown argument {k}"),
        }
    }
    a
}

/// Device-wide VRAM in use, MiB, from nvidia-smi (every process's, so only its change means anything).
fn nvidia_used_mib() -> Option<u64> {
    let o = std::process::Command::new("nvidia-smi").args(["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]).output().ok()?;
    String::from_utf8(o.stdout).ok()?.lines().next()?.split(',').next()?.trim().parse().ok()
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1 << 20) as f64
}

/// Takes a token into the page table and the pool: runs the copy-on-write copy (unless the mutation skips it) and
/// stores the token's K/V for every layer.
struct Host<'a> {
    gpu: &'a Gpu,
    pool: &'a KvPool,
    enc: wgpu::CommandEncoder,
    skip_cow_copy: bool,
    cow_copies: u64,
    cow_bytes: u64,
    tokens_written: u64,
}

impl Host<'_> {
    fn store(&mut self, slot: Slot, chain: u64) {
        if let Some((src, slots)) = slot.copy_from {
            self.cow_copies += 1;
            if !self.skip_cow_copy {
                self.cow_bytes += self.pool.encode_copy(&mut self.enc, src, slot.block, slots);
            }
        }
        self.write(slot.block, slot.offset, chain);
    }

    fn write(&mut self, block: u32, offset: usize, chain: u64) {
        let words = KvPool::token_words(&self.pool.geometry);
        for layer in 0..self.pool.geometry.layers {
            let (k, v) = kv_words(chain, layer, words);
            self.pool.write_token(&self.gpu.queue, layer, block, offset, &k, &v);
        }
        self.tokens_written += 1;
    }

    /// Submits this phase: its queued writes land, then its copies run (a copy reads only slots below the one its
    /// agent writes next, so the order within a submit cannot clobber it). Then waits for the device, which is what
    /// frees the staging memory the queued writes took: without it that memory grows with every token written.
    fn flush(&mut self) {
        let enc = std::mem::replace(&mut self.enc, self.gpu.device.create_command_encoder(&Default::default()));
        self.gpu.queue.submit([enc.finish()]);
        self.gpu.device.poll(wgpu::Maintain::Wait);
    }
}

fn main() {
    let a = args();
    let g = DEFAULT_MODEL;
    let block_bytes = KvPool::block_bytes(&g);
    let blocks = (a.pool_mib << 20) / block_bytes;
    let mut report = String::new();
    macro_rules! say { ($($t:tt)*) => {{ let line = format!($($t)*); println!("{line}"); report.push_str(&line); report.push('\n'); }} }

    let gpu = Gpu::new().expect("GPU");
    say!("adapter: {} ({:?}, {:?}, driver {})", gpu.info.name, gpu.info.backend, gpu.info.device_type, gpu.info.driver_info);
    say!("model geometry: {} layers, {} Q heads, {} KV heads, head_dim {} -> {} B of KV per token (f16)", g.layers, g.q_heads, g.kv_heads, g.head_dim, g.bytes_per_token(2));
    say!("page: {BLOCK_TOKENS} tokens = {:.2} MiB; pool: {blocks} pages = {:.0} MiB requested ({} MiB asked)", mib(block_bytes), mib(blocks * block_bytes), a.pool_mib);

    let smi_before = nvidia_used_mib();
    let t = Instant::now();
    let pool = KvPool::new(&gpu, g, blocks as usize).expect("pool allocation");
    let decode = Decode::new(&gpu).expect("pipeline");
    gpu.device.poll(wgpu::Maintain::Wait);
    let smi_after = nvidia_used_mib();
    say!("pool allocated: {:.0} MiB in {} K + {} V storage buffers of {:.2} MiB each ({:.0} ms)", mib(pool.bytes()), g.layers, g.layers, mib(KvPool::layer_bytes(&g, pool.blocks)), t.elapsed().as_secs_f64() * 1e3);
    match gpu.allocator_report() {
        Some(r) => say!("wgpu allocator report: {:.0} MiB allocated, {:.0} MiB reserved, {} allocations in {} memory blocks", mib(r.allocated_bytes), mib(r.reserved_bytes), r.allocations, r.memory_blocks),
        None => say!("wgpu allocator report: not available on this backend"),
    }
    if let (Some(b), Some(af)) = (smi_before, smi_after) {
        say!("nvidia-smi device memory.used: {b} MiB -> {af} MiB (+{} MiB, every process on the GPU counted)", af as i64 - b as i64);
    }

    // The two page tables: the paged one (prefix cache + forks + copy-on-write) and the no-sharing baseline.
    let mut pt = PageTable::new(pool.blocks);
    let mut private = PageTable::without_sharing(pool.blocks);
    let mut refused: Vec<(AgentId, usize, PageError)> = Vec::new();
    let mut host = Host { gpu: &gpu, pool: &pool, enc: gpu.device.create_command_encoder(&Default::default()), skip_cow_copy: a.skip_cow_copy, cow_copies: 0, cow_bytes: 0, tokens_written: 0 };

    let base = tokenize(&base_reality());
    let mut rng = Rng(a.seed);
    let mut agents: Vec<Agent> = Vec::new();
    let mut prompts: Vec<Vec<Token>> = Vec::new(); // per squad
    let mut cached_tokens = 0usize;
    for s in 0..SQUADS {
        let (x, y) = (rng.below(GRID as u64) as i32, rng.below(GRID as u64) as i32);
        let mut prompt = base.clone();
        prompt.extend(tokenize(&format!("\nSquad {s} musters at block ({x}, {y}) of the grid. Each of you walks your own route to your own lot, reporting every block you enter.")));
        let leader = s * PER_SQUAD;
        let adm = pt.admit(leader, &prompt).expect("admit a leader");
        cached_tokens += adm.cached_tokens;
        let table = pt.blocks_of(leader).unwrap().to_vec();
        for (p, &c) in chains(&prompt).iter().enumerate().skip(adm.cached_tokens) {
            host.write(table[p / BLOCK_TOKENS], p % BLOCK_TOKENS, c);
        }
        for m in 0..PER_SQUAD {
            let id = leader + m;
            if m > 0 {
                pt.fork(leader, id).expect("fork");
            }
            agents.push(Agent { id, x, y, goal: (rng.below(GRID as u64) as i32, rng.below(GRID as u64) as i32), rng: Rng(mix(a.seed ^ u64::from(id) << 32)), appended: Vec::new() });
        }
        prompts.push(prompt);
    }
    host.flush();
    say!("base reality: {} stand-in tokens; squad prompts {}..{} tokens; prefix-cache hits on admission: {} tokens", base.len(), prompts.iter().map(Vec::len).min().unwrap(), prompts.iter().map(Vec::len).max().unwrap(), cached_tokens);
    say!("after admission + forks: {} pages in use for {} agents ({} logical pages mapped)", pt.in_use(), pt.agents(), (0..AGENTS).map(|i| pt.blocks_of(i).unwrap().len()).sum::<usize>());

    let mut csv = String::from("step,agents,pages_in_use,pool_pages,live_kv_mib,logical_pages,shared_pages,cow_copies,cow_mib,baseline_pages_in_use,baseline_agents_running,baseline_refused,baseline_demand_pages,distinct_histories,driver_allocated_mib\n");
    let mut peak_in_use = pt.in_use();

    // Step 0 is each agent saying who it is; steps 1.. are the walk.
    for step in 0..=a.steps {
        for agent in agents.iter_mut() {
            let tokens: Vec<Token> = if step == 0 { tokenize(&format!(" You are answering for agent {}.", agent.id)) } else { agent.walk().to_vec() };
            let mut seq = pt.tokens_of(agent.id).unwrap();
            for &tok in &tokens {
                seq.push(tok);
                let chain = *chains(&seq).last().unwrap();
                let slot = pt.append(agent.id, tok).unwrap_or_else(|e| panic!("paged pool refused agent {} at step {step}: {e:?}", agent.id));
                host.store(slot, chain);
            }
            agent.appended.extend(&tokens);
        }
        host.flush();
        peak_in_use = peak_in_use.max(pt.in_use());

        // The baseline: the same agents with no sharing. It admits each agent's whole prompt on its first step and
        // takes the same tokens after; an agent refused anywhere stops (its request changed nothing).
        for agent in &agents {
            if refused.iter().any(|r| r.0 == agent.id) {
                continue;
            }
            let squad_prompt = &prompts[(agent.id / PER_SQUAD) as usize];
            let fresh = private.len_of(agent.id).is_none();
            let result = if fresh {
                let mut p = squad_prompt.clone();
                p.extend(&agent.appended);
                private.admit(agent.id, &p).map(|_| ())
            } else {
                let have = private.len_of(agent.id).unwrap() - squad_prompt.len();
                agent.appended[have..].iter().try_for_each(|&t| private.append(agent.id, t).map(|_| ()))
            };
            if let Err(e) = result {
                refused.push((agent.id, step, e));
            }
        }
        private.check().expect("baseline table");
        pt.check().expect("paged table");

        let logical: usize = (0..AGENTS).map(|i| pt.blocks_of(i).unwrap().len()).sum();
        let mut seen = std::collections::HashMap::new();
        for i in 0..AGENTS {
            for &b in pt.blocks_of(i).unwrap() {
                *seen.entry(b).or_insert(0) += 1;
            }
        }
        let shared = seen.values().filter(|&&n| n > 1).count();
        let demand: usize = agents.iter().map(|ag| (prompts[(ag.id / PER_SQUAD) as usize].len() + ag.appended.len()).div_ceil(BLOCK_TOKENS)).sum();
        let distinct = agents.iter().map(|ag| &ag.appended).collect::<std::collections::HashSet<_>>().len();
        let driver = gpu.allocator_report().map_or(String::new(), |r| format!("{:.0}", mib(r.allocated_bytes)));
        writeln!(csv, "{step},{},{},{},{:.1},{logical},{shared},{},{:.1},{},{},{},{demand},{distinct},{driver}", pt.agents(), pt.in_use(), pool.blocks, mib(pt.in_use() as u64 * block_bytes), host.cow_copies, mib(host.cow_bytes), private.in_use(), AGENTS as usize - refused.len(), refused.len()).unwrap();
    }

    let last = csv.lines().last().unwrap().to_string();
    let f: Vec<&str> = last.split(',').collect();
    say!("");
    say!("after {} steps ({} tokens per agent appended):", a.steps, agents[0].appended.len());
    say!("  paged + prefix cache + CoW: {} of {} pages in use ({:.0} MiB of {:.0} MiB), peak {} pages; {} logical pages mapped, {} physical pages shared", pt.in_use(), pool.blocks, mib(pt.in_use() as u64 * block_bytes), mib(pool.bytes()), peak_in_use, f[5], f[6]);
    say!("  copy-on-write: {} partial pages copied ({:.1} MiB moved on the GPU); {} distinct agent histories of {}", host.cow_copies, mib(host.cow_bytes), f[13], AGENTS);
    say!("  no sharing, same pool: demand {} pages ({:.0} MiB); {} of {AGENTS} agents stalled (a token refused; admitted ones still hold {} pages), {} ran every step", f[12], mib(f[12].parse::<u64>().unwrap() * block_bytes), refused.len(), private.in_use(), AGENTS as usize - refused.len());
    if let Some((id, step, e)) = refused.first() {
        say!("  first refusal: agent {id} at step {step}: {e:?} (the request was refused whole; table invariants held)");
    }
    let max_len = (0..AGENTS).map(|i| pt.len_of(i).unwrap()).max().unwrap();
    say!("  contiguous reservation: {AGENTS} x {max_len} tokens (longest agent) = {:.2} GiB; x {CONTEXT_TOKENS} (full context) = {:.1} GiB", (AGENTS as u64 * max_len as u64 * g.bytes_per_token(2) as u64) as f64 / (1u64 << 30) as f64, (AGENTS as u64 * CONTEXT_TOKENS as u64 * g.bytes_per_token(2) as u64) as f64 / (1u64 << 30) as f64);
    if let Some(r) = gpu.allocator_report() {
        say!("  wgpu allocator report after the run: {:.0} MiB allocated, {:.0} MiB reserved", mib(r.allocated_bytes), mib(r.reserved_bytes));
    }
    if let Some(u) = nvidia_used_mib() {
        say!("  nvidia-smi device memory.used after the run: {u} MiB");
    }

    // The kernel over the pool, against a CPU reference from each agent's own tokens.
    say!("");
    let ids: Vec<AgentId> = (0..AGENTS).collect();
    let tables = pt.gpu_tables(&ids).unwrap();
    let words = KvPool::token_words(&g);
    let mut worst = 0f64;
    let mut worst_at = (0, 0);
    let t = Instant::now();
    for &layer in &a.verify_layers {
        let q: Vec<f32> = (0..AGENTS as usize * g.q_heads * g.head_dim).map(|i| {
            let r = mix((layer as u64) << 40 ^ i as u64);
            f16_value(f16_bits(((r >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0) * 3.0))
        }).collect();
        let out = decode.run(&gpu, &pool, layer, &tables, &q);
        for &id in &ids {
            let toks = pt.tokens_of(id).unwrap();
            let kv: Vec<(Vec<u32>, Vec<u32>)> = chains(&toks).iter().map(|&c| kv_words(c, layer, words)).collect();
            let half = |w: &[u32], d: usize| f64::from(f16_value((w[d / 2] >> (16 * (d % 2))) as u16));
            for h in 0..g.q_heads {
                let kvh = h / (g.q_heads / g.kv_heads);
                let qrow = &q[(id as usize * g.q_heads + h) * g.head_dim..][..g.head_dim];
                let scores: Vec<f64> = kv.iter().map(|(k, _)| {
                    let kh = &k[kvh * g.head_dim / 2..][..g.head_dim / 2];
                    (0..g.head_dim).map(|d| f64::from(qrow[d]) * half(kh, d)).sum::<f64>() / (g.head_dim as f64).sqrt()
                }).collect();
                let m = scores.iter().cloned().fold(f64::MIN, f64::max);
                let e: Vec<f64> = scores.iter().map(|s| (s - m).exp()).collect();
                let sum: f64 = e.iter().sum();
                for d in 0..g.head_dim {
                    let want: f64 = kv.iter().zip(&e).map(|((_, v), p)| p * half(&v[kvh * g.head_dim / 2..], d)).sum::<f64>() / sum;
                    let got = f64::from(out[(id as usize * g.q_heads + h) * g.head_dim + d]);
                    if (want - got).abs() > worst {
                        worst = (want - got).abs();
                        worst_at = (id, layer);
                    }
                }
            }
        }
    }
    let pass = worst < 1e-3;
    say!("decode kernel vs CPU reference ({} layers x {AGENTS} agents x {} heads x {} dims, {:.1} s): max |error| {worst:.2e} at agent {} layer {} -> {}", a.verify_layers.len(), g.q_heads, g.head_dim, t.elapsed().as_secs_f64(), worst_at.0, worst_at.1, if pass { "PASS" } else { "FAIL" });
    if a.skip_cow_copy {
        say!("(mutation run: copy-on-write copies were skipped, so a FAIL above is the expected result)");
    }
    say!("tokens written to the pool: {} (the rest came from the prefix cache or were shared by forks)", host.tokens_written);

    std::fs::create_dir_all(&a.out).expect("telemetry dir");
    let tag = if a.skip_cow_copy { "-skip-cow" } else { "" };
    std::fs::write(format!("{}/stress{tag}-steps.csv", a.out), &csv).expect("csv");
    std::fs::write(format!("{}/stress{tag}-report.txt", a.out), &report).expect("report");
    println!("telemetry: {}/stress{tag}-steps.csv, {}/stress{tag}-report.txt", a.out, a.out);
    if !pass && !a.skip_cow_copy {
        std::process::exit(1);
    }
}
