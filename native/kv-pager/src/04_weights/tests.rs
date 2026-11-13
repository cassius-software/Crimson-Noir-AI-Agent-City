// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
use super::gguf::write::{byte_at, gguf, Meta, Tensor};
use super::gguf::*;
use super::stream::*;
use super::swarm::*;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const Q4_K: u32 = 12;
const Q6_K: u32 = 14;
const Q8_0: u32 = 8;
const F32: u32 = 0;
const F16: u32 = 1;

/// splitmix64: the tests' deterministic randomness.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn t(name: &str, dims: &[u64], ggml_type: u32) -> Tensor {
    Tensor { name: name.to_string(), dims: dims.to_vec(), ggml_type }
}

/// A small mixture-of-experts model: `layers` layers of `experts` experts, top-2, every tensor type the index meets.
fn moe(layers: u32, experts: u64, alignment: u64) -> Vec<u8> {
    moe_ff(layers, experts, alignment, 32)
}

/// The same with experts of `ff` hidden units (an expert is about 560 · `ff` bytes).
fn moe_ff(layers: u32, experts: u64, alignment: u64, ff: u64) -> Vec<u8> {
    let mut tensors = vec![t("token_embd.weight", &[256, 50], F16)];
    for l in 0..layers {
        tensors.push(t(&format!("blk.{l}.attn_norm.weight"), &[256], F32));
        tensors.push(t(&format!("blk.{l}.attn_q.weight"), &[256, 64], Q4_K));
        tensors.push(t(&format!("blk.{l}.ffn_gate_inp.weight"), &[256, experts], F32));
        tensors.push(t(&format!("blk.{l}.ffn_gate_exps.weight"), &[256, ff, experts], Q4_K));
        tensors.push(t(&format!("blk.{l}.ffn_up_exps.weight"), &[256, ff, experts], Q4_K));
        tensors.push(t(&format!("blk.{l}.ffn_down_exps.weight"), &[ff, 256, experts], Q8_0));
    }
    tensors.push(t("output_norm.weight", &[256], F32));
    tensors.push(t("output.weight", &[256, 50], Q6_K));
    let meta = [
        ("general.architecture", Meta::Str("qwen3moe".into())),
        ("general.alignment", Meta::U32(alignment as u32)),
        ("qwen3moe.block_count", Meta::U32(layers)),
        ("qwen3moe.expert_count", Meta::U32(experts as u32)),
        ("qwen3moe.expert_used_count", Meta::U32(2)),
        ("tokenizer.ggml.tokens", Meta::Strs((0..50).map(|i| format!("tok{i}")).collect())),
    ];
    gguf(&meta, &tensors, alignment)
}

fn dense() -> Vec<u8> {
    let tensors = vec![
        t("token_embd.weight", &[256, 50], F16),
        t("blk.0.attn_q.weight", &[256, 64], Q4_K),
        t("blk.0.ffn_gate.weight", &[256, 128], Q4_K),
        t("blk.1.attn_q.weight", &[256, 64], Q4_K),
        t("blk.1.ffn_gate.weight", &[256, 128], Q4_K),
    ];
    let meta = [("general.architecture", Meta::Str("llama".into())), ("llama.block_count", Meta::U32(2))];
    gguf(&meta, &tensors, 32)
}

fn parse(bytes: &[u8]) -> Gguf {
    Gguf::parse(bytes, bytes.len() as u64).unwrap()
}

/// A file in the system's temporary folder, removed when dropped.
struct TempFile(PathBuf);
impl TempFile {
    fn new(tag: &str, bytes: &[u8]) -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("kv-pager-{tag}-{}-{n}.gguf", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        TempFile(p)
    }
}
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------------------------------------------------------------- the header

#[test]
fn a_mixture_of_experts_header_reads_back_its_metadata_shapes_and_offsets() {
    let bytes = moe(2, 4, 64);
    let g = parse(&bytes);
    assert_eq!((g.version, g.alignment, g.architecture()), (3, 64, Some("qwen3moe")));
    assert_eq!((g.arch_u64("block_count"), g.arch_u64("expert_count"), g.arch_u64("expert_used_count")), (Some(2), Some(4), Some(2)));
    assert_eq!(g.meta["tokenizer.ggml.tokens"], Value::Array { elem_type: 8, len: 50 });
    assert_eq!(g.data_start % 64, 0);
    let gate = g.tensors.iter().find(|t| t.name == "blk.1.ffn_gate_exps.weight").unwrap();
    assert_eq!(gate.bytes, 144 * 32 * 4, "one Q4_K super-block per row of 256, 32 rows, 4 experts");
    let down = g.tensors.iter().find(|t| t.name == "blk.1.ffn_down_exps.weight").unwrap();
    assert_eq!(down.bytes, 34 * 256 * 4, "one Q8_0 block per row of 32");
    for t in &g.tensors {
        assert_eq!(t.offset % 64, 0, "{}", t.name);
        assert_eq!(bytes[t.offset as usize], byte_at(t.offset), "{} starts where the writer put it", t.name);
    }
}

#[test]
fn the_index_cuts_each_stacked_expert_tensor_into_equal_slices_and_covers_every_byte_once() {
    let bytes = moe(2, 4, 32);
    let g = parse(&bytes);
    let idx = WeightIndex::build(&g).unwrap();
    assert_eq!((idx.layers, idx.experts, idx.experts_used, idx.is_moe()), (2, 4, 2, true));
    let keys: Vec<UnitKey> = idx.units().map(|u| u.key).collect();
    assert_eq!(keys.len(), 1 + 2 * (1 + 4));
    assert_eq!(keys[0], UnitKey::Globals);
    let e2 = idx.unit(UnitKey::Expert { layer: 1, expert: 2 }).unwrap();
    assert_eq!(e2.extents.len(), 3, "gate, up and down");
    assert_eq!(idx.expert_bytes(1, 2), 144 * 32 * 2 + 34 * 256);
    let gate = g.tensors.iter().find(|t| t.name == "blk.1.ffn_gate_exps.weight").unwrap();
    assert_eq!(e2.extents[0], Extent { offset: gate.offset + 2 * gate.bytes / 4, len: gate.bytes / 4 });
    // Every byte of every tensor in exactly one unit, nothing else.
    let mut covered: Vec<Extent> = idx.units().flat_map(|u| u.extents.iter().copied()).collect();
    covered.sort();
    for w in covered.windows(2) {
        assert!(w[0].end() <= w[1].offset, "{w:?} overlap");
    }
    assert_eq!(covered.iter().map(|e| e.len).sum::<u64>(), g.tensors.iter().map(|t| t.bytes).sum::<u64>());
    assert_eq!(idx.total_bytes(), g.tensors.iter().map(|t| t.bytes).sum::<u64>());
    assert_eq!(idx.layer_bytes(0), idx.layer_shared_bytes(0) + 4 * idx.expert_bytes(0, 0));
    assert_eq!(idx.active_bytes_per_token(), 2 * (idx.layer_shared_bytes(0) + 2 * idx.expert_bytes(0, 0)));
}

#[test]
fn a_dense_model_has_one_unit_per_layer_and_no_experts() {
    let idx = WeightIndex::build(&parse(&dense())).unwrap();
    assert_eq!((idx.layers, idx.experts, idx.is_moe()), (2, 0, false));
    assert_eq!(idx.units().count(), 3);
    assert_eq!(idx.active_bytes_per_token(), idx.layer_shared_bytes(0) + idx.layer_shared_bytes(1));
}

#[test]
fn a_stacked_tensor_whose_outer_dimension_is_not_the_expert_count_is_refused() {
    let tensors = vec![t("blk.0.ffn_up_exps.weight", &[256, 8, 3], Q4_K)];
    let meta = [("general.architecture", Meta::Str("m".into())), ("m.expert_count", Meta::U32(4))];
    let bytes = gguf(&meta, &tensors, 32);
    assert!(matches!(WeightIndex::build(&parse(&bytes)), Err(GgufError::BadTensor { .. })));
}

/// Header bytes with one field overwritten.
fn patched(mut bytes: Vec<u8>, at: usize, with: &[u8]) -> Vec<u8> {
    bytes[at..at + with.len()].copy_from_slice(with);
    bytes
}

/// Where the first tensor record starts in `moe`-style files written by `gguf`: after the counts and the metadata.
fn first_tensor_record(bytes: &[u8]) -> usize {
    let g = parse(bytes);
    let name = g.tensors[0].name.as_bytes();
    let pos = bytes.windows(name.len()).position(|w| w == name).unwrap();
    pos - 8
}

#[test]
fn damaged_headers_are_refused_with_the_reason() {
    let good = dense();
    let len = good.len() as u64;
    assert_eq!(Gguf::parse(&patched(good.clone(), 0, b"GGUG"), len), Err(GgufError::NotGguf { magic: u32::from_le_bytes(*b"GGUG") }));
    assert_eq!(Gguf::parse(&patched(good.clone(), 4, &1u32.to_le_bytes()), len), Err(GgufError::Version(1)));
    let rec = first_tensor_record(&good);
    let name_len = 17; // "token_embd.weight"
    let n_dims_at = rec + 8 + name_len;
    let type_at = n_dims_at + 4 + 2 * 8;
    let offset_at = type_at + 4;
    assert!(matches!(Gguf::parse(&patched(good.clone(), n_dims_at, &5u32.to_le_bytes()), len), Err(GgufError::BadTensor { .. })));
    assert_eq!(
        Gguf::parse(&patched(good.clone(), type_at, &4u32.to_le_bytes()), len),
        Err(GgufError::UnknownTensorType { name: "token_embd.weight".into(), ggml_type: 4 })
    );
    assert!(matches!(Gguf::parse(&patched(good.clone(), offset_at, &3u64.to_le_bytes()), len), Err(GgufError::BadTensor { .. })));
    // The first tensor moved onto the second: they overlap.
    let g = parse(&good);
    let second_rel = (g.tensors[1].offset - g.data_start).to_le_bytes();
    assert!(matches!(Gguf::parse(&patched(good.clone(), offset_at, &second_rel), len), Err(GgufError::Overlap { .. })));
    // A file cut short: the last tensor runs past its end.
    assert!(matches!(Gguf::parse(&good[..good.len() - 1], len - 1), Err(GgufError::BadTensor { .. })));
    // The same tensor twice.
    let twice = gguf(&[], &[t("a", &[32], F32), t("a", &[32], F32)], 32);
    assert_eq!(Gguf::parse(&twice, twice.len() as u64), Err(GgufError::DuplicateTensor("a".into())));
    let odd = gguf(&[("general.alignment", Meta::U32(48))], &[], 32);
    assert_eq!(Gguf::parse(&odd, odd.len() as u64), Err(GgufError::BadAlignment(48)));
}

#[test]
fn any_mutation_or_truncation_of_a_header_is_refused_or_read_never_a_panic() {
    let good = moe(2, 4, 32);
    let header_end = parse(&good).data_start as usize;
    let mut rng = Rng(0x5eed);
    for round in 0..4000 {
        let mut b = good[..header_end].to_vec();
        for _ in 0..1 + rng.below(4) {
            let at = rng.below(b.len() as u64) as usize;
            b[at] = match rng.below(3) {
                0 => rng.next() as u8,
                1 => 0xff,
                _ => b[at] ^ (1 << rng.below(8)),
            };
        }
        let cut = if round % 3 == 0 { rng.below(b.len() as u64) as usize } else { b.len() };
        let claimed = if round % 5 == 0 { rng.next() } else { good.len() as u64 };
        if let Ok(g) = Gguf::parse(&b[..cut], claimed) {
            for t in &g.tensors {
                assert!(t.offset.checked_add(t.bytes).is_some_and(|end| end <= claimed));
            }
            let _ = WeightIndex::build(&g);
        }
    }
}

#[test]
fn a_prefix_too_short_for_the_header_says_how_much_more_it_needs() {
    let good = moe(1, 4, 32);
    let header_end = parse(&good).data_start as usize;
    for cut in [0, 7, 23, header_end / 2, header_end - 40] {
        match Gguf::parse(&good[..cut], good.len() as u64) {
            Err(GgufError::Truncated { at, needed, .. }) => assert!(at + needed > cut as u64 && at + needed <= good.len() as u64),
            other => panic!("cut at {cut}: {other:?}"),
        }
    }
}

#[test]
fn opening_a_file_whose_vocabulary_is_larger_than_the_first_read_still_finds_its_tensors() {
    let vocab: Vec<String> = (0..300_000).map(|i| format!("token-{i:08}")).collect(); // about 7 MiB of strings
    let tensors = [t("blk.0.attn_q.weight", &[256, 4], Q4_K)];
    let bytes = gguf(&[("general.architecture", Meta::Str("llama".into())), ("tokenizer.ggml.tokens", Meta::Strs(vocab))], &tensors, 32);
    assert!(bytes.len() > 4 << 20);
    let f = TempFile::new("vocab", &bytes);
    let g = Gguf::open(&f.0).unwrap();
    assert_eq!(g.tensors.len(), 1);
    assert_eq!(g.tensors[0].offset + g.tensors[0].bytes, bytes.len() as u64);
}

// ---------------------------------------------------------------- the reads

#[test]
fn read_plans_are_sector_aligned_minimal_and_put_every_extent_where_it_says() {
    let mut rng = Rng(42);
    let file_len = 3 * MAX_READ + 12_345;
    let file: Vec<u8> = (0..file_len).map(byte_at).collect();
    for round in 0..300 {
        let n = 1 + rng.below(12) as usize;
        let extents: Vec<Extent> = (0..n)
            .map(|_| {
                let len = if round % 7 == 0 { rng.below(2 * MAX_READ) } else { rng.below(20_000) };
                let len = len.min(file_len);
                Extent { offset: rng.below(file_len - len + 1), len }
            })
            .collect();
        let gap = [0, SECTOR, 64 << 10][round % 3];
        let plan = ReadPlan::new(&extents, gap);
        let mut buf = vec![0u8; plan.buffer_len() as usize];
        let mut at = 0;
        for (i, r) in plan.reads.iter().enumerate() {
            assert_eq!((r.offset % SECTOR, r.len % SECTOR, r.at % SECTOR), (0, 0, 0), "{r:?}");
            assert!(r.len <= MAX_READ && r.len > 0);
            assert_eq!(r.at, at, "reads are consecutive in the buffer");
            at += r.len;
            if i > 0 {
                assert!(plan.reads[i - 1].offset + plan.reads[i - 1].len <= r.offset, "sorted and disjoint");
            }
            let end = (r.offset + r.len).min(file_len);
            buf[r.at as usize..(r.at + end - r.offset) as usize].copy_from_slice(&file[r.offset as usize..end as usize]);
        }
        for (e, p) in extents.iter().zip(&plan.placements) {
            assert_eq!(p.len, e.len);
            assert_eq!(&buf[p.at as usize..(p.at + p.len) as usize], &file[e.offset as usize..e.end() as usize]);
        }
        let breaks = plan.reads.windows(2).filter(|w| w[0].offset + w[0].len != w[1].offset).count();
        assert_eq!(plan.spans, if plan.reads.is_empty() { 0 } else { breaks + 1 });
        if gap == 0 {
            // No sector is read that holds no requested byte.
            for r in &plan.reads {
                for s in (r.offset..r.offset + r.len).step_by(SECTOR as usize) {
                    assert!(extents.iter().any(|e| e.len > 0 && e.offset < s + SECTOR && e.end() > s), "sector {s} is read for nothing");
                }
            }
        }
        assert!(plan.read_bytes() >= extents.iter().map(|e| e.len).max().unwrap_or(0));
    }
}

#[test]
fn aligned_buffers_start_and_end_on_a_sector() {
    for len in [0, 1, 4095, 4096, 4097, 1 << 20] {
        let mut b = AlignedBuf::new(len);
        assert_eq!(b.as_slice().as_ptr() as usize % SECTOR as usize, 0);
        assert_eq!(b.len() % SECTOR as usize, 0);
        assert!(b.len() >= len);
        b.as_mut_slice().fill(7);
        assert!(b.as_slice().iter().all(|&x| x == 7));
    }
}

fn extents_of(idx: &WeightIndex, key: UnitKey) -> Vec<Extent> {
    idx.unit(key).unwrap().extents.clone()
}

#[test]
fn the_streamer_hands_back_every_units_exact_bytes_in_request_order_in_either_mode() {
    let bytes = moe(2, 8, 32);
    let f = TempFile::new("order", &bytes);
    let idx = WeightIndex::build(&Gguf::open(&f.0).unwrap()).unwrap();
    for (mode, threads) in [(IoMode::Direct, 4), (IoMode::Buffered, 1), (IoMode::Direct, 1)] {
        let mut s = Streamer::open(&f.0, StreamConfig { mode, depth: 2, threads, merge_gap: 0 }).unwrap();
        let keys: Vec<UnitKey> = idx.units().map(|u| u.key).collect();
        for k in &keys {
            s.request(&extents_of(&idx, *k)).unwrap();
        }
        for (i, k) in keys.iter().enumerate() {
            let staged = s.next().unwrap().unwrap();
            assert_eq!(staged.ticket, i as u64);
            for (j, e) in extents_of(&idx, *k).iter().enumerate() {
                assert_eq!(staged.extent(j), &bytes[e.offset as usize..e.end() as usize], "{mode:?} {k:?} extent {j}");
            }
        }
        assert!(s.next().is_none());
    }
}

#[test]
fn the_next_unit_is_read_while_the_caller_holds_this_one_and_no_further() {
    let bytes = moe(4, 8, 32);
    let f = TempFile::new("ahead", &bytes);
    let idx = WeightIndex::build(&Gguf::open(&f.0).unwrap()).unwrap();
    let mut s = Streamer::open(&f.0, StreamConfig { mode: IoMode::Buffered, depth: 2, threads: 1, merge_gap: 0 }).unwrap();
    let keys: Vec<UnitKey> = idx.units().map(|u| u.key).collect();
    for k in &keys {
        s.request(&extents_of(&idx, *k)).unwrap();
    }
    let first = s.next().unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.units_read() < 2 {
        assert!(Instant::now() < deadline, "unit 1 was not read while unit 0 was held");
        std::thread::sleep(Duration::from_millis(1));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(s.units_read(), 2, "two buffers: one held, one filled ahead, then the reader waits");
    drop(first);
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.units_read() < 3 {
        assert!(Instant::now() < deadline, "a returned buffer lets the reader go on");
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut n = 1;
    for u in s {
        u.unwrap();
        n += 1;
    }
    assert_eq!(n, keys.len());
}

#[test]
fn a_request_outside_the_file_is_refused_and_dropping_the_streamer_mid_stream_returns() {
    let bytes = moe(2, 4, 32);
    let f = TempFile::new("drop", &bytes);
    let mut s = Streamer::open(&f.0, StreamConfig { depth: 2, ..StreamConfig::default() }).unwrap();
    let len = bytes.len() as u64;
    assert_eq!(s.request(&[Extent { offset: len - 10, len: 11 }]).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(s.request(&[Extent { offset: u64::MAX, len: 2 }]).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    for _ in 0..6 {
        s.request(&[Extent { offset: 0, len }]).unwrap();
    }
    let held = s.next().unwrap().unwrap();
    assert_eq!(held.extent(0), &bytes[..]);
    drop(s); // the reader is blocked waiting for `held`'s buffer: it must still stop
    drop(held);
}

// ---------------------------------------------------------------- the swarm

#[test]
fn grouping_by_expert_keeps_every_agent_expert_pair_once_whatever_the_order() {
    let mut rng = Rng(7);
    for _ in 0..200 {
        let routes: Vec<Route> = (0..1 + rng.below(40))
            .map(|a| Route { agent: a as u32 * 3, experts: (0..rng.below(9)).map(|_| rng.below(64) as u32).collect() })
            .collect();
        let groups = group_swarm_by_expert(&routes);
        let pairs: BTreeSet<(u32, u32)> = routes.iter().flat_map(|r| r.experts.iter().map(move |&e| (e, r.agent))).collect();
        let got: Vec<(u32, u32)> = groups.iter().flat_map(|g| g.agents.iter().map(move |&a| (g.expert, a))).collect();
        assert_eq!(got.len(), pairs.len(), "no pair twice");
        assert_eq!(got.iter().copied().collect::<BTreeSet<_>>(), pairs);
        assert!(groups.windows(2).all(|w| w[0].expert < w[1].expert));
        assert!(groups.iter().all(|g| !g.agents.is_empty() && g.agents.windows(2).all(|w| w[0] < w[1])));
        let mut shuffled = routes.clone();
        shuffled.reverse();
        for r in &mut shuffled {
            r.experts.reverse();
        }
        assert_eq!(group_swarm_by_expert(&shuffled), groups);
    }
}

#[test]
fn a_dense_layer_is_always_read_whole_once_for_every_agent() {
    let g = parse(&dense());
    let idx = WeightIndex::build(&g).unwrap();
    let s = SwarmScheduler::new(&idx, IoCost::NVME, 0);
    let routes: Vec<Route> = (0..50).map(|a| Route { agent: a, experts: vec![] }).collect();
    let plans = s.plan_step(&[routes.clone(), routes], &|_| false);
    assert_eq!(plans.len(), 2);
    for (l, p) in plans.iter().enumerate() {
        assert_eq!((p.regime, p.units.clone()), (Regime::WholeLayer, vec![UnitKey::Layer(l as u32)]));
        assert_eq!(p.reads.useful, idx.layer_shared_bytes(l as u32));
    }
}

#[test]
fn few_agents_read_only_their_experts_and_many_read_the_layer_in_one_sweep() {
    // 64 experts of 280 KiB: two of them are 0.6 ms of reads, the whole layer 9 ms.
    let bytes = moe_ff(1, 64, 32, 512);
    let idx = WeightIndex::build(&parse(&bytes)).unwrap();
    let cost = IoCost { bytes_per_sec: 2.0e9, sec_per_request: 100e-6 };
    let s = SwarmScheduler::new(&idx, cost, 0);
    let one = [Route { agent: 9, experts: vec![5, 40] }];
    let p = s.plan_layer(0, &one, &|_| false);
    assert_eq!(p.regime, Regime::RoutedExperts);
    assert_eq!(p.units, vec![UnitKey::Layer(0), UnitKey::Expert { layer: 0, expert: 5 }, UnitKey::Expert { layer: 0, expert: 40 }]);
    assert_eq!(p.reads.useful, idx.layer_shared_bytes(0) + 2 * idx.expert_bytes(0, 0));
    assert!(p.seconds <= p.other_seconds);
    // Every agent routed to scattered experts: 64 agents cover the layer, each expert read once.
    let many: Vec<Route> = (0..64).map(|a| Route { agent: a, experts: vec![(a * 7) % 64, (a * 13 + 1) % 64] }).collect();
    let p = s.plan_layer(0, &many, &|_| false);
    assert_eq!(p.regime, Regime::WholeLayer);
    assert_eq!(p.reads.useful, idx.layer_bytes(0));
    assert_eq!(p.groups.iter().map(|g| g.agents.len()).sum::<usize>(), 128);
    // Resident experts are never read.
    let resident = |k: UnitKey| matches!(k, UnitKey::Expert { expert: 5, .. });
    let p = s.plan_layer(0, &one, &resident);
    assert_eq!(p.units, vec![UnitKey::Layer(0), UnitKey::Expert { layer: 0, expert: 40 }]);
    // Half the experts, scattered: with no cost per request the routed reads win (fewer bytes); at a millisecond a
    // request (a hard disk) the sweep does.
    let half: Vec<Route> = (0..16).map(|a| Route { agent: a, experts: vec![4 * a, 4 * a + 2] }).collect();
    let free_requests = SwarmScheduler::new(&idx, IoCost { bytes_per_sec: 2.0e9, sec_per_request: 0.0 }, 0);
    assert_eq!(free_requests.plan_layer(0, &half, &|_| false).regime, Regime::RoutedExperts);
    let disk = SwarmScheduler::new(&idx, IoCost { bytes_per_sec: 150e6, sec_per_request: 8e-3 }, 0);
    assert_eq!(disk.plan_layer(0, &half, &|_| false).regime, Regime::WholeLayer);
    assert_eq!(free_requests.crossover_agents(0, 10_000), None, "with free requests the sweep is never strictly cheaper");
    let n = s.crossover_agents(0, 10_000).unwrap();
    let d = disk.crossover_agents(0, 10_000).unwrap();
    assert!(d < n && n < 200, "a hard disk switches sooner ({d}) than an SSD ({n})");
}
