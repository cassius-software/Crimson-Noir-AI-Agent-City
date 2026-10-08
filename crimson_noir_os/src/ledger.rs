// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the hosted runtime's weight ledger: the record of how the swarm's learned weights
//! came to be, hash-chained, so the Phase 12 host's ledger door (src/10_Network/ledger.ts in the repository root) can
//! verify it and share the result with other runtimes of the same configuration.
//! The kernel changes a weight two ways only, and both are recorded:
//! - A learn: an agent whose role holds `learn` docks, and its weight for that station takes in the trip's reward
//!   (kernels.rs agent_tick).
//! - A wipe: a dropped pointer is reaped, or the loop breaker flushes an index; the row, weights included, goes to zero.
//!
//! The recorder watches ticks from outside the kernel, which stays branch-free and unchanged. Before a tick it keeps
//! each agent's goal and clock; after it, the fate bits say who docked and who was wiped. It replays its own entries
//! (`fold`) and must arrive at exactly the matrix's weights before anything is sent. Entries and links are the door's
//! own: [kind, tick, agent, station, reward], each linked as SHA-256 of the canonical body followed by the hash before
//! it. One fixed link is pinned in both languages' tests.
//! Weights fetched from the host are checked again here before they are adopted (`adopt`): their digest, their range,
//! and that only roles declared with `learn` hold any.
//! What breaks if it is removed? The bridge has nothing to send, and fetched weights nothing to be checked against.

use noir_core::config::{CAP_LEARN, Dims};
use noir_core::kernels::{FATE_DOCKED, FATE_FLUSHED, FATE_REAPED};
use noir_core::matrix::{self, Matrix, Proof};

use crate::wire::{Json, canonical_string, sha256_hex};

/// The hash before the first entry.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
pub const LEARN: u32 = 0;
pub const WIPE: u32 = 1;
/// The rewards the kernel can produce: (1 << 22) / (min(clock, 1 << 20) + 64), at clock 0 and at the cap.
pub const REWARD_MAX: i32 = (1 << 22) / 64;
#[cfg(test)]
pub const REWARD_MIN: i32 = (1 << 22) / ((1 << 20) + 64);

/// One entry: [kind, tick, agent, station, reward] and its link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub body: [u32; 5],
    pub hash: String,
}

/// The link: SHA-256 of the body's canonical text followed by the hash before it.
pub fn link(body: &[u32; 5], previous: &str) -> String {
    let text = format!("[{},{},{},{},{}]{previous}", body[0], body[1], body[2], body[3], body[4]);
    sha256_hex(text.as_bytes())
}

#[derive(Clone, Debug, Default)]
pub struct Ledger {
    pub entries: Vec<Entry>,
    head: String,
}

impl Ledger {
    pub fn new() -> Ledger {
        Ledger { entries: Vec::new(), head: GENESIS.to_string() }
    }
    pub fn head(&self) -> &str {
        &self.head
    }
    pub(crate) fn push(&mut self, body: [u32; 5]) {
        let hash = link(&body, &self.head);
        self.head.clone_from(&hash);
        self.entries.push(Entry { body, hash });
    }
    /// One entry as the door reads it: [kind, tick, agent, station, reward, hash].
    pub fn json(e: &Entry) -> Json {
        let mut v: Vec<Json> = e.body.iter().map(|&x| Json::Int(x as i64)).collect();
        v.push(Json::Str(e.hash.clone()));
        Json::Arr(v)
    }
}

/// The reward the kernel folds in for a trip that took `clock` ticks.
pub fn reward(clock: u32) -> i32 {
    ((1u32 << 22) / (clock.min(1 << 20) + 64)) as i32
}

/// One tick of the self-test's scripted run, recorded: who learned (and from which station, for what reward) and who
/// was wiped. Returns false once the run is over.
pub fn record_step(d: &Dims, m: &mut Matrix, p: &mut Proof, l: &mut Ledger, goal: &mut [u32], clock: &mut [u32]) -> bool {
    goal.copy_from_slice(&m.goal);
    clock.copy_from_slice(&m.clock);
    let t = p.tick;
    if !matrix::golden_step(d, m, p) {
        return false;
    }
    let stations = d.stations as u32;
    for i in 0..d.capacity {
        let fate = m.fate[i];
        // A docked agent took in a reward exactly when its role holds learn (the kernel's learned = learns & ok);
        // it is never wiped in the tick it docks.
        if fate & FATE_DOCKED != 0 && m.caps[i] & CAP_LEARN != 0 {
            l.push([LEARN, t, i as u32, goal[i] & (stations - 1), reward(clock[i]) as u32]);
        }
        if fate & (FATE_FLUSHED | FATE_REAPED) != 0 {
            l.push([WIPE, t, i as u32, 0, 0]);
        }
    }
    true
}

/// The scripted run from the start, recorded: the matrix it leaves, its proof, and its ledger.
pub fn record_golden(d: &Dims, role_counts: &[u32], role_caps: &[u32]) -> (Matrix, Proof, Ledger) {
    let mut m = matrix::new(d);
    let mut p = matrix::golden_begin(d, role_counts, role_caps, &mut m);
    let mut l = Ledger::new();
    let (mut goal, mut clock) = (vec![0u32; d.capacity], vec![0u32; d.capacity]);
    while record_step(d, &mut m, &mut p, &mut l, &mut goal, &mut clock) {}
    (m, p, l)
}

/// The weights a ledger folds to from nothing: the kernel's integer arithmetic for a learn, zeros for a wipe.
pub fn fold(d: &Dims, entries: &[Entry]) -> Vec<i32> {
    let mut w = vec![0i32; d.capacity * d.stations];
    for e in entries {
        let [kind, _, agent, station, r] = e.body;
        let row = agent as usize * d.stations;
        if kind == LEARN {
            let lw = w[row + station as usize];
            w[row + station as usize] = lw.wrapping_add((r as i32).wrapping_sub(lw) >> d.learn_shift);
        } else {
            w[row..row + d.stations].fill(0);
        }
    }
    w
}

/// The seal of a run as crimson_noir_os/containment.seal pins it for the host (`cargo run -- seal` writes it): the
/// ledger's head, its count and its weights' digest, under the lock they belong to. The host's ledger door keeps a
/// verified ledger for the fleet only if its seal is this one.
pub fn seal_text(l: &Ledger, weights: &[i32], lock: &str) -> String {
    format!(
        "# The seal of the scripted run under containment.lock {lock}: its ledger's head, its entries, and its weights'\n\
         # digest. The host's ledger door keeps a verified ledger for the fleet only if its seal is this one.\n\
         # Regenerate it with `cargo run -- seal` whenever containment.nix changes.\n\
         head {}\ncount {}\nweights {}\n",
        l.head(),
        l.entries.len(),
        weights_digest(weights)
    )
}

/// The non-zero weights as [index, weight] pairs, in index order.
pub fn pairs(weights: &[i32]) -> Vec<(usize, i32)> {
    weights.iter().enumerate().filter(|(_, w)| **w != 0).map(|(i, w)| (i, *w)).collect()
}

/// The digest both ends compute: SHA-256 of the canonical pairs, as ledger.ts weightsDigest.
pub fn weights_digest(weights: &[i32]) -> String {
    let list = Json::Arr(pairs(weights).into_iter().map(|(i, w)| Json::Arr(vec![Json::Int(i as i64), Json::Int(w as i64)])).collect());
    sha256_hex(canonical_string(&list).as_bytes())
}

/// Whether slot `agent`'s role (the roles fill the pool in their declared order) was declared with `learn`.
pub fn learns(role_counts: &[u32], role_caps: &[u32], agent: usize) -> bool {
    let mut first = 0usize;
    for (&count, &caps) in role_counts.iter().zip(role_caps) {
        if agent < first + count as usize {
            return caps & CAP_LEARN != 0;
        }
        first += count as usize;
    }
    false
}

/// Weights fetched from the host, checked before a runtime takes them: indices rising and in the pool, every weight in
/// the rewards' range and in a row whose role learns, and their digest the one the host sealed. Then they replace the
/// matrix's weights. Returns how many were adopted.
pub fn adopt(d: &Dims, role_counts: &[u32], role_caps: &[u32], fetched: &[(i64, i64)], digest: &str, m: &mut Matrix) -> Result<usize, String> {
    let mut w = vec![0i32; d.capacity * d.stations];
    let mut last: i64 = -1;
    for &(i, v) in fetched {
        if i <= last || i < 0 || i as usize >= w.len() {
            return Err(format!("weight index {i} is out of order or outside the pool"));
        }
        if v <= 0 || v > REWARD_MAX as i64 {
            return Err(format!("weight {i} ({v}) is outside 1..{REWARD_MAX}"));
        }
        if !learns(role_counts, role_caps, i as usize / d.stations) {
            return Err(format!("weight {i} belongs to a role never declared with learn"));
        }
        w[i as usize] = v as i32;
        last = i;
    }
    if weights_digest(&w) != digest {
        return Err(String::from("the fetched weights are not the ones the host sealed"));
    }
    m.weights.copy_from_slice(&w);
    Ok(fetched.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use noir_core::config::{parse, validate};

    fn sample() -> (Dims, Vec<u32>, Vec<u32>) {
        let c = validate(&parse(include_str!("../containment.nix")).unwrap()).unwrap();
        (c.dims, c.roles.iter().map(|r| r.count).collect(), c.roles.iter().map(|r| r.caps).collect())
    }

    /// The same link is pinned in src/10_Network/ledger.test.ts: both languages hash the same bytes the same way.
    #[test]
    fn one_fixed_link_pinned_in_both_languages() {
        assert_eq!(link(&[LEARN, 5, 17, 3, 1234], GENESIS), "946cde523d47a899b5ae0179dfe233a94397a936c2b0a4f43d0c1be9b34d76fd");
    }

    /// The recorder sees every change the kernel makes to a weight: its ledger folds to the matrix's weights exactly,
    /// and the run is still the self-test's (the fingerprint the build pinned).
    #[test]
    fn the_recorded_ledger_folds_to_the_kernels_weights_exactly() {
        let (d, counts, caps) = sample();
        let (m, p, l) = record_golden(&d, &counts, &caps);
        let mut plain = matrix::new(&d);
        assert_eq!(p, matrix::golden(&d, &counts, &caps, &mut plain), "recording does not change the run");
        assert_eq!(fold(&d, &l.entries), m.weights);
        let learned = l.entries.iter().filter(|e| e.body[0] == LEARN).count();
        let wiped = l.entries.iter().filter(|e| e.body[0] == WIPE).count();
        assert!(learned > 1000 && wiped == (p.totals.flushed + p.totals.reaped) as usize, "{learned} learns, {wiped} wipes");
        // Every learn is by a role declared with learn, at a station of the world, for a reward the kernel can make.
        for e in &l.entries {
            let [kind, _, agent, station, r] = e.body;
            if kind == LEARN {
                assert!(learns(&counts, &caps, agent as usize) && (station as usize) < d.stations);
                assert!((REWARD_MIN..=REWARD_MAX).contains(&(r as i32)));
            }
        }
        // And the chain holds from GENESIS to the head.
        let mut prev = GENESIS.to_string();
        for e in &l.entries {
            assert_eq!(e.hash, link(&e.body, &prev));
            prev.clone_from(&e.hash);
        }
        assert_eq!(prev, l.head());
    }

    /// containment.seal is what `cargo run -- seal` prints: the host's ledger door pins the run by it.
    #[test]
    fn the_committed_seal_is_the_scripted_runs() {
        let (d, counts, caps) = sample();
        let (m, _, l) = record_golden(&d, &counts, &caps);
        let lock = include_str!("../containment.lock").lines().filter(|l| !l.starts_with('#')).find(|l| !l.trim().is_empty()).unwrap().trim().to_string();
        assert_eq!(include_str!("../containment.seal"), seal_text(&l, &m.weights, &lock));
    }

    #[test]
    fn fetched_weights_are_checked_before_they_are_adopted() {
        let (d, counts, caps) = sample();
        let (m, _, _) = record_golden(&d, &counts, &caps);
        let good: Vec<(i64, i64)> = pairs(&m.weights).into_iter().map(|(i, w)| (i as i64, w as i64)).collect();
        let digest = weights_digest(&m.weights);
        let mut fresh = matrix::new(&d);
        assert_eq!(adopt(&d, &counts, &caps, &good, &digest, &mut fresh), Ok(good.len()));
        assert_eq!(fresh.weights, m.weights);
        // A sentry's weight, an impossible value, a disorder, or a digest that is not the host's: refused, and
        // nothing is written.
        let sentry = (3072 * d.stations) as i64;
        let cases: Vec<Vec<(i64, i64)>> = vec![
            vec![(sentry, 100)],
            vec![(good[0].0, REWARD_MAX as i64 + 1)],
            vec![(good[0].0, -5)],
            vec![good[1], good[0]],
            vec![((d.capacity * d.stations) as i64, 7)],
        ];
        for bad in cases {
            let mut t = matrix::new(&d);
            assert!(adopt(&d, &counts, &caps, &bad, &weights_digest(&t.weights), &mut t).is_err(), "{bad:?}");
            assert!(t.weights.iter().all(|&w| w == 0));
        }
        let mut t = matrix::new(&d);
        assert!(adopt(&d, &counts, &caps, &good, &weights_digest(&t.weights), &mut t).is_err(), "digest mismatch");
    }
}
