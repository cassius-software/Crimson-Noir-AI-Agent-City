//! Why does this file exist? It is the root of the Crimson Noir OS core: everything the bootable image and the hosted
//! runtime share, with no standard library under it (`no_std` + `alloc`), so the same code runs on the bare metal
//! and on a desktop. `generate` is what both build scripts call: it locks the declarative configuration, runs the
//! self-test's scripted swarm on the build machine and emits the tables the system is compiled with.
//! What breaks if it is removed? Neither the image nor the runtime builds.
#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod config;
pub mod hash;
pub mod kernels;
pub mod matrix;
pub mod sort;

#[cfg(test)]
mod tests;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

/// Locks `containment.nix` against `containment.lock`, runs the self-test's scripted swarm (the build machine's
/// answer, which the booted system must reproduce) and returns the Rust source of the locked tables.
pub fn generate(nix: &str, lock: &str) -> Result<String, String> {
    let (config, canon, digest) = config::load(nix, lock)?;
    let counts: Vec<u32> = config.roles.iter().map(|r| r.count).collect();
    let caps: Vec<u32> = config.roles.iter().map(|r| r.caps).collect();
    let mut m = matrix::new(&config.dims);
    let p = matrix::golden(&config.dims, &counts, &caps, &mut m);
    if !(p.rogue_dropped && p.rogue_reaped) {
        return Err(format!("the scripted run did not drop the rogue's pointer: {:?}", p));
    }
    if p.looper_flushed_at == u32::MAX {
        return Err(format!("the scripted run did not flush the looper: {:?}", p));
    }
    let mut out = config::emit_rust(&config, &canon, &digest, matrix::GOLDEN_TICKS, p.fingerprint);
    out.push_str(&format!(
        "pub const GOLDEN_PROOF: noir_core::matrix::Proof = noir_core::matrix::Proof {{ tick: {}, rogue: {}, \
         rogue_dropped: {}, rogue_reaped: {}, looper: {}, trap_cell: {}, trapped_at: {}, looper_flushed_at: {}, \
         totals: noir_core::kernels::Tally {{ dropped: {}, flushed: {}, reaped: {}, docked: {} }}, fingerprint: {:#010x} }};\n",
        p.tick,
        p.rogue,
        p.rogue_dropped,
        p.rogue_reaped,
        p.looper,
        p.trap_cell,
        p.trapped_at,
        p.looper_flushed_at,
        p.totals.dropped,
        p.totals.flushed,
        p.totals.reaped,
        p.totals.docked,
        p.fingerprint
    ));
    Ok(out)
}
