//! Why does this file exist? The tutorial's last proof is a sort, and the sort is a bitonic network: a fixed list of
//! comparators that does not depend on the data, each one branchless (kernels::compare_exchange). Because the list is
//! fixed it can be proved, not just tested: by the 0-1 principle a comparator network sorts every input if and only if
//! it sorts every input of zeros and ones, and there are only 2^n of those (`zero_one_proof` runs them all; the boot
//! self-test runs it too). The same passes sort larger arrays on the GPU in the hosted runtime.
//! What breaks if it is removed? The tutorial agent has nothing to sort and the self-test nothing to prove.

use crate::kernels::{bitonic_pass, compare_exchange};

/// The files the tutorial agent sorts.
pub const FILES: usize = 8;

/// The comparators of the bitonic network for `N` keys (a power of two), in order: (low index, high index, ascending).
/// `C` must be the comparator count, N/2 × log2(N) × (log2(N) + 1) / 2.
pub const fn network<const N: usize, const C: usize>() -> [(u8, u8, bool); C] {
    let mut out = [(0u8, 0u8, true); C];
    let mut n = 0;
    let mut k = 2;
    while k <= N {
        let mut j = k / 2;
        while j > 0 {
            let mut i = 0;
            while i < N {
                let l = i ^ j;
                if l > i {
                    out[n] = (i as u8, l as u8, (i & k) == 0);
                    n += 1;
                }
                i += 1;
            }
            j /= 2;
        }
        k *= 2;
    }
    assert!(n == C, "the comparator count");
    out
}

/// The tutorial's network: 24 comparators for 8 files.
pub const NETWORK8: [(u8, u8, bool); 24] = network::<8, 24>();

/// Runs a network over `keys`. Returns the swaps it made.
pub fn run_network(keys: &mut [u32], net: &[(u8, u8, bool)]) -> u32 {
    net.iter().map(|&(lo, hi, up)| compare_exchange(keys, lo as usize, hi as usize, up as u32)).sum()
}

/// A full bitonic sort of a power-of-two array, pass by pass. Returns the swaps it made.
pub fn bitonic_sort(keys: &mut [u32]) -> u32 {
    if keys.len() < 2 {
        return 0;
    }
    assert!(keys.len().is_power_of_two(), "a bitonic sort needs a power-of-two length");
    let mut swaps = 0;
    let mut k = 2;
    while k <= keys.len() {
        let mut j = k / 2;
        while j > 0 {
            swaps += bitonic_pass(keys, k, j);
            j /= 2;
        }
        k *= 2;
    }
    swaps
}

/// The 0-1 principle, exhausted: the network sorts every one of the 2^N inputs of zeros and ones, so it sorts every
/// input. Returns how many inputs it checked, or None at the first it fails.
pub fn zero_one_proof(net: &[(u8, u8, bool)], n: usize) -> Option<u32> {
    assert!(n <= 16, "the 0-1 proof holds up to 16 keys");
    let mut keys = [0u32; 16];
    for bits in 0..(1u32 << n) {
        for (k, key) in keys[..n].iter_mut().enumerate() {
            *key = (bits >> k) & 1;
        }
        run_network(&mut keys[..n], net);
        if !is_sorted(&keys[..n]) {
            return None;
        }
    }
    Some(1 << n)
}

pub fn is_sorted(keys: &[u32]) -> bool {
    keys.windows(2).all(|w| w[0] <= w[1])
}

/// The sorted copy of `keys` by a different method (insertion sort), into `out`: what a correct sort must equal.
pub fn reference_sort(keys: &[u32], out: &mut [u32]) {
    out[..keys.len()].copy_from_slice(keys);
    for i in 1..keys.len() {
        let mut j = i;
        while j > 0 && out[j - 1] > out[j] {
            out.swap(j - 1, j);
            j -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::mix32;

    #[test]
    fn the_network_is_proved_by_the_zero_one_principle() {
        assert_eq!(zero_one_proof(&NETWORK8, 8), Some(256));
        const N16: [(u8, u8, bool); 80] = network::<16, 80>();
        assert_eq!(zero_one_proof(&N16, 16), Some(65536));
        // A network missing one comparator is caught.
        for skip in 0..NETWORK8.len() {
            let mut broken = NETWORK8.to_vec();
            broken.remove(skip);
            assert_eq!(zero_one_proof(&broken, 8), None, "without comparator {skip}");
        }
    }

    #[test]
    fn the_passes_sort_any_power_of_two_array_like_the_reference() {
        for n in [2usize, 8, 64, 1024, 4096] {
            for seed in 0..20u32 {
                let keys: std::vec::Vec<u32> = (0..n as u32).map(|i| mix32(i ^ seed.wrapping_mul(0x9e37_79b9)) % 1000).collect();
                let mut sorted = keys.clone();
                bitonic_sort(&mut sorted);
                let mut want = std::vec![0; n];
                reference_sort(&keys, &mut want);
                assert_eq!(sorted, want, "n={n} seed={seed}");
            }
        }
        // The network and the passes agree on the eight files.
        let files = [42u32, 7, 19, 88, 3, 64, 25, 51];
        let (mut a, mut b) = (files, files);
        run_network(&mut a, &NETWORK8);
        bitonic_sort(&mut b);
        assert_eq!(a, b);
        assert_eq!(a, [3, 7, 19, 25, 42, 51, 64, 88]);
    }
}
