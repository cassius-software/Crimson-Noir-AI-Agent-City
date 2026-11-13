// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04c: what one decode step of the whole swarm reads from the disk, and in what order.
//!
//! Why does this file exist? When every agent's next token runs through the same weights, the weights should be read
//! once per step for all of them, not once per agent. Two orders follow from that:
//! - layer-major: each layer's weights are read once and every active agent runs through them before the next layer
//!   is read. This is FlexGen's zig-zag block schedule with the whole swarm in one block; it holds for every model and
//!   every agent count, so the planner never reads a layer more than once per step;
//! - per layer of a mixture-of-experts model, which bytes: the whole layer in one sequential sweep, or only the layer's
//!   shared part and the experts some agent was routed to (the sparse reads of LLM in a Flash and SSD-LLaMA), each
//!   routed expert read once however many agents chose it (`group_swarm_by_expert`).
//!
//! The choice between the two is made per layer from the reads themselves, not from a fixed agent count: both read
//! plans are built (stream.rs, sector-aligned and merged) and costed with the drive's measured bandwidth and its cost per
//! request; the cheaper wins. With few agents the routed experts are a small part of the layer and sparse reads win;
//! as agents are added their experts cover more of the layer and neighbouring experts merge into long reads. Where an
//! expert's slice is smaller than what the drive moves in the time of one request (bandwidth × cost per request), the
//! sweep wins before every expert is routed; where it is larger, as in the two released models the `stream` run
//! sizes (Qwen3-30B-A3B's slices are 0.9 MB against 0.2 MB on a 2 GB/s, 100 µs drive), skipping an unrouted expert always pays and the planner sweeps
//! only once every expert is routed. `crossover_agents` estimates the first case for uniform routing, which real
//! routers are not (skewed routing keeps the sparse reads cheaper for longer).
//! Experts already resident (a caller's RAM cache) cost nothing and are left out of both plans.
//! What breaks if it is removed? Nothing reads the weights in step order; the `stream` run has no plan to measure.

use super::gguf::{Extent, UnitKey, WeightIndex};
use super::stream::ReadPlan;
use crate::geometry::AgentId;
use std::collections::BTreeMap;

/// One agent's routing at one layer: the experts its router picked for its token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub agent: AgentId,
    pub experts: Vec<u32>,
}

/// One routed expert and every agent routed to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpertGroup {
    pub expert: u32,
    pub agents: Vec<AgentId>,
}

/// Every routed expert once, with the agents routed to it. Groups are sorted by expert (the experts' order on disk:
/// expert `e` of a stacked tensor sits after expert `e - 1`); each group's agents are sorted and never repeated. The
/// result is the same whatever order the routes come in.
pub fn group_swarm_by_expert(routes: &[Route]) -> Vec<ExpertGroup> {
    let mut by_expert: BTreeMap<u32, Vec<AgentId>> = BTreeMap::new();
    for r in routes {
        for &e in &r.experts {
            by_expert.entry(e).or_default().push(r.agent);
        }
    }
    by_expert
        .into_iter()
        .map(|(expert, mut agents)| {
            agents.sort_unstable();
            agents.dedup();
            ExpertGroup { expert, agents }
        })
        .collect()
}

/// What a read costs on this drive: a fixed cost per discontiguous request and a transfer rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IoCost {
    pub bytes_per_sec: f64,
    pub sec_per_request: f64,
}

impl IoCost {
    /// A mid-range PCIe 3 NVMe drive read with a queue: about 2 GB/s and 100 µs a request. A starting guess; the
    /// `stream` run measures the real drive.
    pub const NVME: IoCost = IoCost { bytes_per_sec: 2.0e9, sec_per_request: 100e-6 };

    pub fn seconds(&self, plan: &ReadPlan) -> f64 {
        plan.spans as f64 * self.sec_per_request + plan.read_bytes() as f64 / self.bytes_per_sec
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Regime {
    /// The whole layer in one sequential sweep (every dense layer; a MoE layer whose routed experts cover most of it).
    WholeLayer,
    /// The layer's shared part and only the routed experts.
    RoutedExperts,
}

/// One layer of a step: what is read, and what each choice would have cost.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerPlan {
    pub layer: u32,
    pub regime: Regime,
    /// The units read, in disk order (shared part first). Resident units are left out.
    pub units: Vec<UnitKey>,
    /// The routed experts and their agents (empty for a dense layer).
    pub groups: Vec<ExpertGroup>,
    pub reads: ReadPlan,
    /// Estimated seconds of the plan chosen and of the other one.
    pub seconds: f64,
    pub other_seconds: f64,
}

pub struct SwarmScheduler<'a> {
    index: &'a WeightIndex,
    cost: IoCost,
    merge_gap: u64,
}

impl<'a> SwarmScheduler<'a> {
    pub fn new(index: &'a WeightIndex, cost: IoCost, merge_gap: u64) -> Self {
        SwarmScheduler { index, cost, merge_gap }
    }

    fn extents(&self, units: &[UnitKey]) -> Vec<Extent> {
        units.iter().filter_map(|&k| self.index.unit(k)).flat_map(|u| u.extents.iter().copied()).collect()
    }

    /// The plan for `layer` given every active agent's routing there. `resident` says which units the caller already
    /// holds in memory.
    pub fn plan_layer(&self, layer: u32, routes: &[Route], resident: &dyn Fn(UnitKey) -> bool) -> LayerPlan {
        let wanted = |k: &UnitKey| self.index.unit(*k).is_some() && !resident(*k);
        let shared: Vec<UnitKey> = [UnitKey::Layer(layer)].into_iter().filter(wanted).collect();
        if !self.index.is_moe() {
            let reads = ReadPlan::new(&self.extents(&shared), self.merge_gap);
            let seconds = self.cost.seconds(&reads);
            return LayerPlan { layer, regime: Regime::WholeLayer, units: shared, groups: Vec::new(), reads, seconds, other_seconds: seconds };
        }
        let groups: Vec<ExpertGroup> =
            group_swarm_by_expert(routes).into_iter().filter(|g| g.expert < self.index.experts).collect();
        let mut whole = shared.clone();
        whole.extend((0..self.index.experts).map(|expert| UnitKey::Expert { layer, expert }).filter(wanted));
        let mut routed = shared;
        routed.extend(groups.iter().map(|g| UnitKey::Expert { layer, expert: g.expert }).filter(wanted));
        let whole_reads = ReadPlan::new(&self.extents(&whole), self.merge_gap);
        let routed_reads = ReadPlan::new(&self.extents(&routed), self.merge_gap);
        let (ws, rs) = (self.cost.seconds(&whole_reads), self.cost.seconds(&routed_reads));
        // A tie means the routed experts are every expert: the same reads, called a sweep.
        if ws <= rs {
            LayerPlan { layer, regime: Regime::WholeLayer, units: whole, groups, reads: whole_reads, seconds: ws, other_seconds: rs }
        } else {
            LayerPlan { layer, regime: Regime::RoutedExperts, units: routed, groups, reads: routed_reads, seconds: rs, other_seconds: ws }
        }
    }

    /// A whole step, layer-major: `routes[l]` is every active agent's routing at layer `l` (ignored for a dense
    /// model). The globals (embeddings, output head) are not planned: every token reads them, so a host keeps them in
    /// memory (`WeightIndex::unit(UnitKey::Globals)` says where they are).
    pub fn plan_step(&self, routes: &[Vec<Route>], resident: &dyn Fn(UnitKey) -> bool) -> Vec<LayerPlan> {
        (0..self.index.layers)
            .map(|l| self.plan_layer(l, routes.get(l as usize).map_or(&[][..], Vec::as_slice), resident))
            .collect()
    }

    /// The smallest number of agents at which reading the whole of `layer` is strictly cheaper than reading the
    /// experts they are expected to be routed to, if every agent picks `experts_used` distinct experts uniformly at
    /// random (an expert is left unrouted with probability p = (1 − k/E)ⁿ). None for a dense model, or when the sweep
    /// never wins within `max_agents`. The estimate counts, in each stacked tensor, the runs of unrouted experts (about
    /// E · (1 − p)² · pʳ runs of r): a run longer than the merge gap is skipped by the routed reads, saving its bytes for
    /// one more request, and a shorter one is read through, as by the sweep. Every term carries a power of p, so the
    /// gain vanishes as every expert gets routed and rounding cannot make the sweep look strictly cheaper where it only
    /// ties. Left out: the requests the shared tensors add when unrouted runs cut them off from each other (in
    /// llama.cpp's name order they sit on both sides of the stacked tensors, and they merge back into one sweep exactly
    /// when every expert is routed), runs that carry on from one tensor into the next, and sector rounding (a run saves
    /// only its whole sectors, which matters for slices of a few sectors).
    pub fn crossover_agents(&self, layer: u32, max_agents: u32) -> Option<u32> {
        let e = self.index.experts;
        let k = self.index.experts_used.min(e);
        if !self.index.is_moe() || k == 0 {
            return None;
        }
        // One slice length per stacked tensor: every expert's slice of a tensor is as long as expert 0's.
        let lens: Vec<f64> = self.index.unit(UnitKey::Expert { layer, expert: 0 })?.extents.iter().map(|x| x.len as f64).collect();
        let (bw, per_request, gap) = (self.cost.bytes_per_sec, self.cost.sec_per_request, self.merge_gap as f64);
        let (e, k) = (f64::from(e), f64::from(k));
        for n in 1..=max_agents {
            let p = (1.0 - k / e).powi(n as i32);
            let c = 1.0 - p;
            // What the routed reads gain over the sweep. Runs of r ≥ r0 unrouted slices are skipped, r0 the shortest
            // run longer than the gap; with Σ_{r ≥ r0} pʳ = p^r0 / c and Σ_{r ≥ r0} r · pʳ = p^r0 · (r0 − (r0 − 1) p) / c²,
            // E · c² · Σ pʳ (r · len / bw − per_request) is the line below.
            let mut gain = 0.0;
            for &len in &lens {
                let r0 = (gap / len).floor() + 1.0;
                let pr = p.powf(r0);
                gain += e * (pr * (r0 - (r0 - 1.0) * p) * len / bw - c * pr * per_request);
            }
            if gain < 0.0 {
                return Some(n);
            }
        }
        None
    }
}
