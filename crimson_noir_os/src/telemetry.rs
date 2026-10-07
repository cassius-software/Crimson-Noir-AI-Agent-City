//! Why does this file exist? It is the hosted runtime's side of the IIoT telemetry pipeline (the page's
//! src/10_Network/telemetry.ts): the Process kernel that digests a frame of eight 32-bit words, the chain fold that
//! folds a digest into a node's running head, and the vectors both twins and the WGSL shader
//! (shaders/telemetry.wgsl) are pinned to. The digest is FNV-1a over the words' little-endian bytes finished with the
//! swarm's mix32 (noir_core hash.rs): integer arithmetic only, so the edge (WebAssembly), the fog (the GPU) and the
//! cloud (the page) compute the same bits, and the cloud refuses any frame whose two digests differ. `gpu::digests`
//! runs the shader; the tests hold it to this kernel on every frame drawn, on lavapipe in CI.
//! What breaks if it is removed? The fog's shader has no reference, and the runtime cannot verify a telemetry ledger.

use noir_core::hash::{fnv1a_words, mix32};

/// Words in a frame: node, seq, tick, five values.
pub const FRAME_WORDS: usize = 8;
const FNV_OFFSET: u32 = 0x811c_9dc5;

/// The Process kernel: the digest of one frame (telemetry.ts `frameDigest`, telemetry.wgsl `digest`).
pub fn frame_digest(words: &[u32; FRAME_WORDS]) -> u32 {
    mix32(fnv1a_words(FNV_OFFSET, words.iter().copied()))
}

/// The chain fold: a node's head after the frame with `digest` at `seq` (telemetry.ts `chain`).
pub fn chain(head: u32, digest: u32, seq: u32) -> u32 {
    mix32(head ^ digest ^ seq.wrapping_mul(0x9e37_79b9))
}

/// The digests of `frames` frames laid flat (FRAME_WORDS words each), on the CPU.
pub fn digests(words: &[u32]) -> Vec<u32> {
    assert!(words.len().is_multiple_of(FRAME_WORDS), "frames are {FRAME_WORDS} words each");
    words.chunks_exact(FRAME_WORDS).map(|c| frame_digest(c.try_into().expect("a chunk of FRAME_WORDS"))).collect()
}

/// The vectors telemetry.ts pins (VECTORS): frames and their digests.
pub const VECTORS: [([u32; FRAME_WORDS], u32); 3] = [
    ([0, 0, 0, 0, 0, 0, 0, 0], 0xf8da_9ded),
    ([1, 2, 3, 4, 5, 6, 7, 8], 0x0543_e119),
    ([7, 41, 1000, 0xffff_ffff, 0x8000_0000, 0x7fff_ffff, 0xdead_beef, 0x0102_0304], 0x525f_35c4),
];
/// The head after folding the three vectors' digests at seq 0, 1, 2 from 0 (telemetry.ts VECTORS_CHAIN).
pub const VECTORS_CHAIN: u32 = 0xdeb2_0183;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vectors_digest_and_chain_as_the_page_pins_them() {
        let mut head = 0;
        for (seq, (words, digest)) in VECTORS.iter().enumerate() {
            assert_eq!(frame_digest(words), *digest, "vector {seq}");
            head = chain(head, *digest, seq as u32);
        }
        assert_eq!(head, VECTORS_CHAIN);
    }

    #[test]
    fn a_flipped_bit_in_any_word_changes_the_digest() {
        for (words, digest) in VECTORS {
            for w in 0..FRAME_WORDS {
                for b in [0, 7, 15, 31] {
                    let mut m = words;
                    m[w] ^= 1 << b;
                    assert_ne!(frame_digest(&m), digest, "word {w} bit {b}");
                }
            }
        }
    }

    #[test]
    fn flat_digests_are_the_frames_digests() {
        let flat: Vec<u32> = VECTORS.iter().flat_map(|(w, _)| w.iter().copied()).collect();
        assert_eq!(digests(&flat), VECTORS.iter().map(|(_, d)| *d).collect::<Vec<_>>());
    }
}
