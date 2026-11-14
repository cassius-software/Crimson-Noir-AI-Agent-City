// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The Linux app carries a bigger model than the phones (Qwen2.5 1.5B Instruct, Q4_K_M:
//! APP_GGUF names it, src/09_Cognition/siteModel.ts APP_MODEL pins it) and runs it with its own plan
//! (src-tauri/src/runner.rs: an 8192-token context, 512-token batches, half the threads up to eight, the CPU alone).
//! This test loads that file with that plan, greedy instead of the app's sampling so the run is the same each time,
//! and reads a few tokens of its answer: text that arrives, no turn marker in it, and an end with a reason. It is
//! ignored by a plain `cargo test` (the file is 0.99 GB); the native-llm workflow runs it on its x86-64 job.
//! What breaks if it is removed? Nothing loads the desktop's model through the runner before a package carries it.

mod common;

use std::path::PathBuf;
use std::time::Instant;

use common::*;
use crimson_noir_llm::{half_the_threads, Engine, Gpu, Plan, Reason, Role, RunEvent, Sampling, Source};

/// The file the Linux packages carry (APP_MODEL's name).
const APP_FILE: &str = "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf";

fn app_model() -> PathBuf {
    let path = std::env::var_os("APP_GGUF").map(PathBuf::from).unwrap_or_default();
    assert!(path.is_file(), "APP_GGUF must name the desktop's model ({APP_FILE})");
    assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(APP_FILE), "APP_GGUF names the carried file");
    path
}

/// The Linux app's plan (src-tauri/src/runner.rs), greedy.
fn linux_plan() -> Plan {
    Plan { n_ctx: 8192, n_batch: 512, threads: half_the_threads(8), gpu: Gpu::Off, max_tokens: 2048, sampling: Sampling::Greedy }
}

#[test]
#[ignore = "needs APP_GGUF: the desktop's Qwen2.5 1.5B, 0.99 GB"]
fn desktop_model_answers_a_few_greedy_tokens_with_the_linux_plan() {
    let path = app_model();
    let plan = linux_plan();
    let t0 = Instant::now();
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan, scratch("desktop"));
    let messages = vec![
        msg(Role::System, "You are Sloane, a detective. You answer briefly."),
        msg(Role::User, "Who are you? One sentence."),
    ];
    let (events, answer) = ask(&engine, req(1, messages, 8));
    let done = answer.unwrap();
    let text = text_of(&events);
    println!(
        "desktop model: {:?} in {} tokens ({} of prompt, {} ms reading, {} ms answering, {:.1} tokens/s, {} threads), {:?} all told",
        text,
        done.tokens,
        done.prompt_tokens,
        done.prefill_ms,
        done.gen_ms,
        f64::from(done.tokens) * 1000.0 / done.gen_ms.max(1) as f64,
        done.threads,
        t0.elapsed()
    );
    assert!(events.iter().any(|e| matches!(e, RunEvent::Text { .. })), "the answer arrives as text: {events:?}");
    assert!(!text.trim().is_empty(), "{text:?}");
    assert!(!text.contains("<|im"), "no turn marker reaches the page: {text:?}");
    assert!((1..=8).contains(&done.tokens), "a few tokens, at most the request's cap: {done:?}");
    assert!(matches!(done.reason, Reason::Eog | Reason::MaxTokens), "it ends by itself or at the cap: {done:?}");
    assert_eq!(done.threads, plan.threads, "the Linux plan's threads: {done:?}");
    assert!(done.prompt_tokens < 60, "the prompt's markers are single tokens: {done:?}");
}
