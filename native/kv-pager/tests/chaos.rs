//! Why does this file exist? It keeps a bounded slice of the chaos fuzzer (src/bin/chaos/core.rs) in `cargo test`, and
//! proves the fuzzer's own oracle and shrinker work, so a regression in the page table fails the ordinary test run.
//! What breaks if it is removed? Only the full `chaos` binary would catch a page-table regression.

#[path = "../src/bin/chaos/core.rs"]
#[allow(dead_code)]
mod core;

use crate::core::{generate, run, shrink_by, Keying, Op, Rng};

#[test]
fn chaotic_streams_keep_every_promise_under_every_keying() {
    for seed in 0..300u64 {
        for (capacity, keying) in [(6, Keying::Chain), (24, Keying::Colliding), (12, Keying::Private), (64, Keying::Chain)] {
            let stream = generate(&mut Rng(seed), 400);
            let stats = run(&stream, capacity, keying).unwrap_or_else(|e| panic!("seed {seed}, pool {capacity}, {keying:?}: {e}"));
            assert_eq!((stats.false_refusals, stats.orphaned_blocks, stats.reclaims), (0, 0, 1));
        }
    }
}

#[test]
fn a_stream_that_exercises_refusal_copy_on_write_and_waves_does_so() {
    let mut total = crate::core::Stats::default();
    for seed in 0..50 {
        total.merge(&run(&generate(&mut Rng(seed), 1000), 8, Keying::Chain).unwrap());
    }
    assert!(total.refusals > 0 && total.cow_copies > 0 && total.waves > 0 && total.prefix_hit_tokens > 0, "{total:?}");
}

#[test]
fn the_shrinker_finds_the_minimal_failing_stream() {
    // A failure that needs exactly two waves and one fork, anywhere in a 2,000-op stream: the minimum is those 3 ops.
    let fails = |ops: &[Op]| {
        ops.iter().filter(|o| matches!(o, Op::Wave { .. })).count() >= 2 && ops.iter().any(|o| matches!(o, Op::Fork { .. }))
    };
    let stream = generate(&mut Rng(11), 2000);
    assert!(fails(&stream));
    let s = shrink_by(&stream, fails);
    assert_eq!(s.len(), 3, "{s:?}");
    assert!(fails(&s));
}
