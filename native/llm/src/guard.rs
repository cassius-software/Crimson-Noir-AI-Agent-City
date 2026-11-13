// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? llama.cpp's CPU code is compiled for the processors of the last decade: on x86-64 its
//! build turns on SSE4.2, AVX, AVX2, FMA, F16C and BMI2 (ggml's defaults for a build that is not cross-compiled), so
//! on an older processor the first matrix product would stop the whole app on an illegal instruction. The runner
//! asks the processor first, before llama.cpp's backend starts, and answers a plain sentence instead. Other
//! architectures need nothing here: Arm builds are compiled for the base armv8-a.
//! What breaks if it is removed? The app dies without a word on an x86-64 processor older than about 2013.

/// The instruction sets the x86-64 build of llama.cpp uses, as `is_x86_feature_detected!` names them.
pub const X86_NEEDS: [&str; 6] = ["sse4.2", "avx", "avx2", "fma", "f16c", "bmi2"];

/// Why this processor cannot run the model, given which of `X86_NEEDS` it has; `None` when it has them all.
pub fn refusal_for(has: impl Fn(&str) -> bool) -> Option<String> {
    let missing: Vec<&str> = X86_NEEDS.iter().copied().filter(|f| !has(f)).collect();
    if missing.is_empty() {
        None
    } else {
        Some(format!(
            "this computer's processor is older than the app's model needs (it lacks {})",
            missing.iter().map(|f| f.to_uppercase()).collect::<Vec<_>>().join(", ")
        ))
    }
}

/// Why this processor cannot run the model; `None` when it can (always, off x86-64).
pub fn cpu_refusal() -> Option<String> {
    #[cfg(target_arch = "x86_64")]
    {
        refusal_for(|f| match f {
            "sse4.2" => std::arch::is_x86_feature_detected!("sse4.2"),
            "avx" => std::arch::is_x86_feature_detected!("avx"),
            "avx2" => std::arch::is_x86_feature_detected!("avx2"),
            "fma" => std::arch::is_x86_feature_detected!("fma"),
            "f16c" => std::arch::is_x86_feature_detected!("f16c"),
            "bmi2" => std::arch::is_x86_feature_detected!("bmi2"),
            _ => false,
        })
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_what_the_processor_lacks() {
        assert_eq!(refusal_for(|_| true), None);
        assert_eq!(
            refusal_for(|f| f != "avx2" && f != "bmi2").as_deref(),
            Some("this computer's processor is older than the app's model needs (it lacks AVX2, BMI2)")
        );
    }

    #[test]
    fn this_runner_can_run_it() {
        // CI's runners are all newer than the needs; a refusal here means the guard asks the wrong question.
        assert_eq!(cpu_refusal(), None);
    }
}
