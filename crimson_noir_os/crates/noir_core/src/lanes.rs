// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the SIMD lane type the swarm's tick runs on: four 32-bit lanes, one agent each,
//! with the handful of operations the branchless kernel needs (and, or, xor, add, the low word of a product, shifts,
//! equal, unsigned less-than, signed greater-than, the 1/0-mask select, and the float add and multiply of the step).
//! On x86_64 with SSE2 (every x86_64 host, and the CI runners) each operation is one packed instruction over a
//! `__m128i`; everywhere else (the UEFI target builds with SSE off, under soft float) the same operations are plain
//! loops over a `[u32; 4]`, so the kernel reads the same and computes the same bits on both. The float minimum and
//! maximum, the float-to-integer conversion, the integer division and remainder, and the gathers and scatters into
//! the Global Matrix are done lane by lane with the scalar operation itself (`f32::max`, `as u32`, `/`), because
//! those are where a packed instruction's corner cases (a NaN, a saturating conversion) differ from Rust's, and the
//! kernel is held to the scalar reference bit for bit (tests.rs, kernels_fuzz.rs; the fingerprint the build pins).
//! Like kernels.rs, this file has no `if`, `else`, `match`, `while`, `loop` or `return` (the same test reads it).
//! What breaks if it is removed? The tick runs one agent at a time.

/// Agents one lane group holds.
pub const LANES: usize = 4;

#[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
mod imp {
    // SAFETY (every block below): this module is compiled only when SSE2 is enabled in the build configuration
    // (the cfg above), so every intrinsic's target feature is present; the stores write exactly the 16 bytes of
    // the local array they are given.
    use core::arch::x86_64::*;

    /// Four 32-bit words, one packed register.
    #[derive(Clone, Copy)]
    pub struct U32x4(pub(super) __m128i);

    /// Four f32 values, one packed register.
    #[derive(Clone, Copy)]
    pub struct F32x4(pub(super) __m128);

    #[allow(clippy::should_implement_trait)]
    impl U32x4 {
        #[inline(always)]
        pub fn splat(v: u32) -> Self {
            Self(unsafe { _mm_set1_epi32(v as i32) })
        }

        #[inline(always)]
        pub fn from_array(a: [u32; 4]) -> Self {
            Self(unsafe { _mm_set_epi32(a[3] as i32, a[2] as i32, a[1] as i32, a[0] as i32) })
        }

        #[inline(always)]
        pub fn to_array(self) -> [u32; 4] {
            let mut out = [0u32; 4];
            // SAFETY: the destination is four u32 (16 bytes), which the unaligned store writes in full.
            unsafe { _mm_storeu_si128(out.as_mut_ptr() as *mut __m128i, self.0) };
            out
        }

        #[inline(always)]
        pub fn load(s: &[u32]) -> Self {
            let a: [u32; 4] = [s[0], s[1], s[2], s[3]];
            Self::from_array(a)
        }

        #[inline(always)]
        pub fn store(self, s: &mut [u32]) {
            let a = self.to_array();
            s[0] = a[0];
            s[1] = a[1];
            s[2] = a[2];
            s[3] = a[3];
        }

        #[inline(always)]
        pub fn and(self, o: Self) -> Self {
            Self(unsafe { _mm_and_si128(self.0, o.0) })
        }

        #[inline(always)]
        pub fn or(self, o: Self) -> Self {
            Self(unsafe { _mm_or_si128(self.0, o.0) })
        }

        #[inline(always)]
        pub fn xor(self, o: Self) -> Self {
            Self(unsafe { _mm_xor_si128(self.0, o.0) })
        }

        /// Wrapping lane addition.
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self(unsafe { _mm_add_epi32(self.0, o.0) })
        }

        /// Wrapping lane subtraction.
        #[inline(always)]
        pub fn sub(self, o: Self) -> Self {
            Self(unsafe { _mm_sub_epi32(self.0, o.0) })
        }

        /// The low 32 bits of each lane's product (wrapping multiplication): SSE2 multiplies the even lanes as
        /// 32x32->64, so the odd lanes are shifted down, multiplied the same way, and the low words interleaved back.
        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            let even = unsafe { _mm_mul_epu32(self.0, o.0) };
            let odd = unsafe { _mm_mul_epu32(_mm_srli_si128::<4>(self.0), _mm_srli_si128::<4>(o.0)) };
            let even_lo = unsafe { _mm_shuffle_epi32::<0b10_00_10_00>(even) };
            let odd_lo = unsafe { _mm_shuffle_epi32::<0b10_00_10_00>(odd) };
            Self(unsafe { _mm_unpacklo_epi32(even_lo, odd_lo) })
        }

        /// Logical right shift of every lane by a constant.
        #[inline(always)]
        pub fn shr<const N: i32>(self) -> Self {
            Self(unsafe { _mm_srli_epi32::<N>(self.0) })
        }

        /// Left shift of every lane by a constant.
        #[inline(always)]
        pub fn shl<const N: i32>(self) -> Self {
            Self(unsafe { _mm_slli_epi32::<N>(self.0) })
        }

        /// Arithmetic (signed) right shift of every lane by the same count `n` (below 32).
        #[inline(always)]
        pub fn sra(self, n: u32) -> Self {
            Self(unsafe { _mm_sra_epi32(self.0, _mm_cvtsi32_si128(n as i32)) })
        }

        /// 1 where the lanes are equal, else 0.
        #[inline(always)]
        pub fn eq(self, o: Self) -> Self {
            Self(unsafe { _mm_srli_epi32::<31>(_mm_cmpeq_epi32(self.0, o.0)) })
        }

        /// 1 where `self < o` as unsigned words, else 0 (the sign bit flipped turns the signed compare unsigned).
        #[inline(always)]
        pub fn lt_u(self, o: Self) -> Self {
            let bias = unsafe { _mm_set1_epi32(i32::MIN) };
            Self(unsafe { _mm_srli_epi32::<31>(_mm_cmplt_epi32(_mm_xor_si128(self.0, bias), _mm_xor_si128(o.0, bias))) })
        }

        /// 1 where `self > o` as signed words, else 0.
        #[inline(always)]
        pub fn gt_i(self, o: Self) -> Self {
            Self(unsafe { _mm_srli_epi32::<31>(_mm_cmpgt_epi32(self.0, o.0)) })
        }

        /// Each lane's bits as a float (a bit cast).
        #[inline(always)]
        pub fn as_f32(self) -> F32x4 {
            F32x4(unsafe { _mm_castsi128_ps(self.0) })
        }

        /// Each lane's signed value as a float (exact for the small integers the kernel converts).
        #[inline(always)]
        pub fn to_f32(self) -> F32x4 {
            F32x4(unsafe { _mm_cvtepi32_ps(self.0) })
        }
    }

    #[allow(clippy::should_implement_trait)]
    impl F32x4 {
        #[inline(always)]
        pub fn splat(v: f32) -> Self {
            Self(unsafe { _mm_set1_ps(v) })
        }

        #[inline(always)]
        pub fn from_array(a: [f32; 4]) -> Self {
            Self(unsafe { _mm_set_ps(a[3], a[2], a[1], a[0]) })
        }

        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            let mut out = [0f32; 4];
            // SAFETY: the destination is four f32 (16 bytes), which the unaligned store writes in full.
            unsafe { _mm_storeu_ps(out.as_mut_ptr(), self.0) };
            out
        }

        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self(unsafe { _mm_add_ps(self.0, o.0) })
        }

        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            Self(unsafe { _mm_mul_ps(self.0, o.0) })
        }

        /// Each lane's bits as a word (a bit cast).
        #[inline(always)]
        pub fn bits(self) -> U32x4 {
            U32x4(unsafe { _mm_castps_si128(self.0) })
        }
    }
}

#[cfg(not(all(target_arch = "x86_64", target_feature = "sse2")))]
mod imp {
    /// Four 32-bit words (the portable form: the same operations as loops over the lanes).
    #[derive(Clone, Copy)]
    pub struct U32x4(pub(super) [u32; 4]);

    /// Four f32 values.
    #[derive(Clone, Copy)]
    pub struct F32x4(pub(super) [f32; 4]);

    #[inline(always)]
    fn map2(a: [u32; 4], b: [u32; 4], f: impl Fn(u32, u32) -> u32) -> [u32; 4] {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }

    #[allow(clippy::should_implement_trait)]
    impl U32x4 {
        #[inline(always)]
        pub fn splat(v: u32) -> Self {
            Self([v; 4])
        }

        #[inline(always)]
        pub fn from_array(a: [u32; 4]) -> Self {
            Self(a)
        }

        #[inline(always)]
        pub fn to_array(self) -> [u32; 4] {
            self.0
        }

        #[inline(always)]
        pub fn load(s: &[u32]) -> Self {
            Self([s[0], s[1], s[2], s[3]])
        }

        #[inline(always)]
        pub fn store(self, s: &mut [u32]) {
            s[..4].copy_from_slice(&self.0);
        }

        #[inline(always)]
        pub fn and(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| a & b))
        }

        #[inline(always)]
        pub fn or(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| a | b))
        }

        #[inline(always)]
        pub fn xor(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| a ^ b))
        }

        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self(map2(self.0, o.0, u32::wrapping_add))
        }

        #[inline(always)]
        pub fn sub(self, o: Self) -> Self {
            Self(map2(self.0, o.0, u32::wrapping_sub))
        }

        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            Self(map2(self.0, o.0, u32::wrapping_mul))
        }

        #[inline(always)]
        pub fn shr<const N: i32>(self) -> Self {
            Self(self.0.map(|a| a >> N))
        }

        #[inline(always)]
        pub fn shl<const N: i32>(self) -> Self {
            Self(self.0.map(|a| a << N))
        }

        #[inline(always)]
        pub fn sra(self, n: u32) -> Self {
            Self(self.0.map(|a| ((a as i32) >> n) as u32))
        }

        #[inline(always)]
        pub fn eq(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| (a == b) as u32))
        }

        #[inline(always)]
        pub fn lt_u(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| (a < b) as u32))
        }

        #[inline(always)]
        pub fn gt_i(self, o: Self) -> Self {
            Self(map2(self.0, o.0, |a, b| ((a as i32) > (b as i32)) as u32))
        }

        #[inline(always)]
        pub fn as_f32(self) -> F32x4 {
            F32x4(self.0.map(f32::from_bits))
        }

        #[inline(always)]
        pub fn to_f32(self) -> F32x4 {
            F32x4(self.0.map(|a| a as i32 as f32))
        }
    }

    #[allow(clippy::should_implement_trait)]
    impl F32x4 {
        #[inline(always)]
        pub fn splat(v: f32) -> Self {
            Self([v; 4])
        }

        #[inline(always)]
        pub fn from_array(a: [f32; 4]) -> Self {
            Self(a)
        }

        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            self.0
        }

        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            Self([self.0[0] + o.0[0], self.0[1] + o.0[1], self.0[2] + o.0[2], self.0[3] + o.0[3]])
        }

        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            Self([self.0[0] * o.0[0], self.0[1] * o.0[1], self.0[2] * o.0[2], self.0[3] * o.0[3]])
        }

        #[inline(always)]
        pub fn bits(self) -> U32x4 {
            U32x4(self.0.map(f32::to_bits))
        }
    }
}

pub use imp::{F32x4, U32x4};

/// Whether the packed (SSE2) form is compiled in, for the tests and the runtime's report.
pub const PACKED: bool = cfg!(all(target_arch = "x86_64", target_feature = "sse2"));

#[allow(clippy::should_implement_trait)]
impl U32x4 {
    /// The zero word in every lane.
    #[inline(always)]
    pub fn zero() -> Self {
        Self::splat(0)
    }

    /// Every lane's two's-complement negation: a 1/0 mask widened to all ones or all zeros (kernels::wide).
    #[inline(always)]
    pub fn wide(self) -> Self {
        Self::zero().sub(self)
    }

    /// 1 where the lane is not zero, else 0 (kernels::nz).
    #[inline(always)]
    pub fn nz(self) -> Self {
        self.or(self.wide()).shr::<31>()
    }

    /// `a` where the 1/0 mask lane is 1, else `b` (kernels::sel).
    #[inline(always)]
    pub fn sel(self, a: Self, b: Self) -> Self {
        b.xor(a.xor(b).and(self.wide()))
    }

    /// The unsigned minimum of the lanes.
    #[inline(always)]
    pub fn min_u(self, o: Self) -> Self {
        self.lt_u(o).sel(self, o)
    }

    /// Every lane of `s` at the index each lane holds.
    #[inline(always)]
    pub fn gather(s: &[u32], at: Self) -> Self {
        let i = at.to_array();
        Self::from_array([s[i[0] as usize], s[i[1] as usize], s[i[2] as usize], s[i[3] as usize]])
    }

    /// The same, from an array of signed words.
    #[inline(always)]
    pub fn gather_i(s: &[i32], at: Self) -> Self {
        let i = at.to_array();
        Self::from_array([s[i[0] as usize] as u32, s[i[1] as usize] as u32, s[i[2] as usize] as u32, s[i[3] as usize] as u32])
    }

    /// Writes each lane of `v` into `s` at the index each lane of `self` holds.
    #[inline(always)]
    pub fn scatter(self, s: &mut [u32], v: Self) {
        let i = self.to_array();
        let v = v.to_array();
        s[i[0] as usize] = v[0];
        s[i[1] as usize] = v[1];
        s[i[2] as usize] = v[2];
        s[i[3] as usize] = v[3];
    }

    /// The same, into an array of signed words.
    #[inline(always)]
    pub fn scatter_i(self, s: &mut [i32], v: Self) {
        let i = self.to_array();
        let v = v.to_array();
        s[i[0] as usize] = v[0] as i32;
        s[i[1] as usize] = v[1] as i32;
        s[i[2] as usize] = v[2] as i32;
        s[i[3] as usize] = v[3] as i32;
    }

    /// Every lane divided by the same divisor (not zero): the scalar division, lane by lane.
    #[inline(always)]
    pub fn div_each(self, by: Self) -> Self {
        let a = self.to_array();
        let b = by.to_array();
        Self::from_array([a[0] / b[0], a[1] / b[1], a[2] / b[2], a[3] / b[3]])
    }

    /// Every lane modulo the same divisor (not zero): the scalar remainder, lane by lane.
    #[inline(always)]
    pub fn rem(self, by: u32) -> Self {
        let a = self.to_array();
        Self::from_array([a[0] % by, a[1] % by, a[2] % by, a[3] % by])
    }

    /// The sum of the four lanes (wrapping).
    #[inline(always)]
    pub fn sum(self) -> u32 {
        let a = self.to_array();
        a[0].wrapping_add(a[1]).wrapping_add(a[2]).wrapping_add(a[3])
    }

    /// The lane indices `first`, `first + 1`, `first + 2`, `first + 3`.
    #[inline(always)]
    pub fn iota(first: u32) -> Self {
        Self::from_array([first, first.wrapping_add(1), first.wrapping_add(2), first.wrapping_add(3)])
    }
}

impl F32x4 {
    #[inline(always)]
    pub fn load(s: &[f32]) -> Self {
        Self::from_array([s[0], s[1], s[2], s[3]])
    }

    #[inline(always)]
    pub fn store(self, s: &mut [f32]) {
        let a = self.to_array();
        s[0] = a[0];
        s[1] = a[1];
        s[2] = a[2];
        s[3] = a[3];
    }

    /// Each lane clamped as the kernel clamps a position: `v.max(lo).min(hi)`, Rust's own minimum and maximum
    /// (a NaN lane becomes `lo`), lane by lane.
    #[inline(always)]
    pub fn clamp_each(self, lo: f32, hi: f32) -> Self {
        let a = self.to_array();
        Self::from_array([a[0].max(lo).min(hi), a[1].max(lo).min(hi), a[2].max(lo).min(hi), a[3].max(lo).min(hi)])
    }

    /// Each lane as `f32 as u32` (saturating; a NaN is 0), lane by lane.
    #[inline(always)]
    pub fn to_u32_sat(self) -> U32x4 {
        let a = self.to_array();
        U32x4::from_array([a[0] as u32, a[1] as u32, a[2] as u32, a[3] as u32])
    }
}

/// lowbias32 over every lane (hash::mix32).
#[inline(always)]
pub fn mix32x4(x: U32x4) -> U32x4 {
    let x = x.xor(x.shr::<16>());
    let x = x.mul(U32x4::splat(0x7feb_352d));
    let x = x.xor(x.shr::<15>());
    let x = x.mul(U32x4::splat(0x846c_a68b));
    x.xor(x.shr::<16>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::mix32;

    fn cases() -> std::vec::Vec<u32> {
        let mut v = std::vec![0, 1, 2, 3, 7, 0x7fff_ffff, 0x8000_0000, 0x8000_0001, u32::MAX, u32::MAX - 1, 0x1234_5678];
        let mut h = 0x9e37_79b9u32;
        for _ in 0..40 {
            h = mix32(h);
            v.push(h);
        }
        v
    }

    #[test]
    fn every_lane_operation_is_the_scalar_one() {
        let cs = cases();
        for (k, &a) in cs.iter().enumerate() {
            let b = cs[(k * 7 + 3) % cs.len()];
            let c = cs[(k * 11 + 5) % cs.len()];
            let x = U32x4::from_array([a, b, c, a ^ b]);
            let y = U32x4::from_array([b, c, a, c ^ a]);
            let xs = x.to_array();
            let ys = y.to_array();
            for l in 0..4 {
                let (p, q) = (xs[l], ys[l]);
                assert_eq!(x.and(y).to_array()[l], p & q);
                assert_eq!(x.or(y).to_array()[l], p | q);
                assert_eq!(x.xor(y).to_array()[l], p ^ q);
                assert_eq!(x.add(y).to_array()[l], p.wrapping_add(q));
                assert_eq!(x.sub(y).to_array()[l], p.wrapping_sub(q));
                assert_eq!(x.mul(y).to_array()[l], p.wrapping_mul(q), "mul {p:#x} {q:#x}");
                assert_eq!(x.shr::<16>().to_array()[l], p >> 16);
                assert_eq!(x.shr::<31>().to_array()[l], p >> 31);
                assert_eq!(x.shl::<4>().to_array()[l], p << 4);
                for n in [1u32, 5, 15, 31] {
                    assert_eq!(x.sra(n).to_array()[l], ((p as i32) >> n) as u32, "sra {p:#x} {n}");
                }
                assert_eq!(x.eq(y).to_array()[l], (p == q) as u32);
                assert_eq!(x.lt_u(y).to_array()[l], (p < q) as u32, "lt_u {p:#x} {q:#x}");
                assert_eq!(x.gt_i(y).to_array()[l], ((p as i32) > (q as i32)) as u32, "gt_i {p:#x} {q:#x}");
                assert_eq!(x.min_u(y).to_array()[l], p.min(q));
                assert_eq!(x.nz().to_array()[l], (p != 0) as u32);
                assert_eq!(x.wide().to_array()[l], p.wrapping_neg());
                let m = U32x4::splat((k & 1) as u32);
                assert_eq!(m.sel(x, y).to_array()[l], crate::kernels::sel((k & 1) as u32, p, q));
                assert_eq!(mix32x4(x).to_array()[l], mix32(p));
                assert_eq!(x.rem(1 + (q & 0xffff)).to_array()[l], p % (1 + (q & 0xffff)));
                assert_eq!(x.div_each(U32x4::splat(64 + (q & 0xfff))).to_array()[l], p / (64 + (q & 0xfff)));
                assert_eq!(x.as_f32().bits().to_array()[l], p);
                let small = U32x4::from_array([1, 0, u32::MAX, 0xffff_fffe]);
                assert_eq!(small.to_f32().to_array(), [1.0, 0.0, -1.0, -2.0]);
            }
            assert_eq!(x.sum(), xs[0].wrapping_add(xs[1]).wrapping_add(xs[2]).wrapping_add(xs[3]));
        }
        assert_eq!(U32x4::iota(u32::MAX - 1).to_array(), [u32::MAX - 1, u32::MAX, 0, 1]);
    }

    // `max(lo).min(hi)` is the kernel's own form, not `clamp` (which keeps a NaN where the kernel's form lands on `lo`).
    #[allow(clippy::manual_clamp)]
    #[test]
    fn the_float_lanes_are_the_scalar_operations_nan_included() {
        let xs = [0.5f32, -0.125, f32::NAN, 63.875, f32::INFINITY, -0.0, 1e30, 3.0];
        for k in 0..xs.len() - 3 {
            let a = F32x4::from_array([xs[k], xs[k + 1], xs[k + 2], xs[k + 3]]);
            let b = F32x4::from_array([xs[k + 3], xs[k + 2], xs[k + 1], xs[k]]);
            for l in 0..4 {
                let (p, q) = (a.to_array()[l], b.to_array()[l]);
                assert_eq!(a.add(b).to_array()[l].to_bits(), (p + q).to_bits());
                assert_eq!(a.mul(b).to_array()[l].to_bits(), (p * q).to_bits());
                assert_eq!(a.clamp_each(0.0, 63.875).to_array()[l].to_bits(), p.max(0.0).min(63.875).to_bits(), "clamp {p}");
                assert_eq!(a.to_u32_sat().to_array()[l], p as u32, "as u32 {p}");
                assert_eq!(a.bits().to_array()[l], p.to_bits());
            }
        }
    }
}
