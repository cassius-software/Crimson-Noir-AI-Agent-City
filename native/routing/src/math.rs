//! The few floating-point functions the arithmetic needs, chosen so the core gives the host's own numbers bit for
//! bit: sqrt, floor and ceil are IEEE-exact everywhere; atan2 comes from compiler-builtins' libm on wasm32 (the
//! fdlibm algorithm the JavaScript engine also uses); hypot is the engine's own Kahan-summed, max-normalised form,
//! which a plain sqrt(x² + z²) differs from in a third of all cases by one unit in the last place.
//!
//! Why does this file exist? `core` has no math; the crate links no library. On wasm32 the symbols below are the
//! ones compiler-builtins always provides (what `std` itself calls); on the host, for `cargo test`, they are std's.
//! What breaks if it is removed? The core does not compile without std, and its corner tangents stop matching the
//! TypeScript reference bit for bit.

#[cfg(target_arch = "wasm32")]
mod builtins {
    extern "C" {
        pub fn sqrt(x: f64) -> f64;
        pub fn floor(x: f64) -> f64;
        pub fn ceil(x: f64) -> f64;
        pub fn atan2(y: f64, x: f64) -> f64;
    }
}

#[inline]
pub fn sqrt(x: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        builtins::sqrt(x)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        x.sqrt()
    }
}

#[inline]
pub fn floor(x: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        builtins::floor(x)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        x.floor()
    }
}

#[inline]
pub fn ceil(x: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        builtins::ceil(x)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        x.ceil()
    }
}

#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        builtins::atan2(y, x)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        y.atan2(x)
    }
}

/// JavaScript's Math.hypot(a, b): both normalised by the larger magnitude, squared and Kahan-summed, then sqrt times
/// the larger. 0 for (0, 0); infinity if either is infinite; NaN otherwise if either is NaN.
pub fn hypot(a: f64, b: f64) -> f64 {
    let (aa, ab) = (a.abs(), b.abs());
    let nan = aa.is_nan() || ab.is_nan();
    let max = if aa.is_nan() { ab } else if ab.is_nan() || aa > ab { aa } else { ab };
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [aa, ab] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sqrt(sum) * max
}

/// JavaScript's Math.min(a, b) for the numbers that reach it (never NaN): the smaller; −0 under +0.
#[inline]
pub fn jmin(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else if b < a || !a.is_sign_negative() {
        b
    } else {
        a
    }
}

/// JavaScript's Math.max(a, b) for the numbers that reach it (never NaN): the larger; +0 over −0.
#[inline]
pub fn jmax(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else if b > a || a.is_sign_negative() {
        b
    } else {
        a
    }
}
