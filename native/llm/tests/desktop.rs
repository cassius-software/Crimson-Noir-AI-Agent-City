// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The desktop apps (Linux and macOS) carry a bigger model than the phones (Qwen2.5 1.5B
//! Instruct, Q4_K_M: APP_GGUF names it, src/09_Cognition/siteModel.ts APP_MODEL pins it) and run it with their own
//! plan (src-tauri/src/runner.rs: an 8192-token context, 512-token batches, half the threads up to eight, the GPU on
//! Apple silicon alone, through Metal, and the processor alone everywhere else). This test loads that file with the
//! plan of the computer it runs on, greedy instead of the app's sampling so the run is the same each time, and reads a
//! few tokens of its answer: text that arrives, no turn marker in it, and an end with a reason. It prints the devices
//! llama.cpp found and where the model's weights went, read from llama.cpp's own log of its weight buffers (the GPU
//! only when a buffer that is not the processor's holds some), and does not fail because there is no GPU (a virtual
//! Mac may show Metal none), only when no token comes or llama.cpp logs no weight buffer. It is ignored by a plain
//! `cargo test` (the file is 0.99 GB); the native-llm workflow runs it on its x86-64 Linux job and its Apple silicon
//! macOS job. How those log lines are read is tested on its own, with no model.
//! What breaks if it is removed? Nothing loads the desktop's model through the runner before a package carries it.

mod common;

use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use common::*;
use crimson_noir_llm::{backend, half_the_threads, Engine, Gpu, Plan, Reason, Role, RunEvent, Sampling, Source};
use llama_cpp_2::{list_llama_ggml_backend_devices, LlamaBackendDeviceType};

/// The file the Linux packages and the macOS app carry (APP_MODEL's name).
const APP_FILE: &str = "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf";

fn app_model() -> PathBuf {
    let path = std::env::var_os("APP_GGUF").map(PathBuf::from).unwrap_or_default();
    assert!(path.is_file(), "APP_GGUF must name the desktop's model ({APP_FILE})");
    assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(APP_FILE), "APP_GGUF names the carried file");
    path
}

/// Where the desktop app's plan puts the model's layers: on the GPU on Apple silicon (Metal), on the processor alone on
/// Linux and on an Intel Mac (src-tauri/src/runner.rs GPU, the same expression).
const GPU: Gpu = if cfg!(all(target_os = "macos", target_arch = "aarch64")) { Gpu::All } else { Gpu::Off };

/// The desktop app's plan on this computer (src-tauri/src/runner.rs), greedy.
fn desktop_plan() -> Plan {
    Plan { n_ctx: 8192, n_batch: 512, threads: half_the_threads(8), gpu: GPU, max_tokens: 2048, sampling: Sampling::Greedy }
}

/// The devices llama.cpp registered, each printed; the first GPU among them, if any, by name.
fn devices() -> Option<String> {
    let list = list_llama_ggml_backend_devices();
    for d in &list {
        println!("device {}: {} ({}, {}, {:?}, {} MiB)", d.index, d.name, d.description, d.backend, d.device_type, d.memory_total >> 20);
    }
    let gpu = list.iter().find(|d| matches!(d.device_type, LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu));
    gpu.map(|d| format!("{} ({}, {})", d.name, d.description, d.backend))
}

/// llama.cpp's lines naming the buffers the model's weights were loaded into (llama-model.cpp load_tensors, one per
/// buffer: `load_tensors:  MTL0_Mapped model buffer size =  1001.50 MiB`), kept by `keep_buffers`.
static BUFFERS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// llama.cpp's log callback for this test (the engine silences the log in release builds): it keeps the weight
/// buffers' lines and drops every other line. It is process-wide, so it also hears the engine thread load the model.
unsafe extern "C" fn keep_buffers(_: llama_cpp_sys_2::ggml_log_level, text: *const c_char, _: *mut c_void) {
    if text.is_null() {
        return;
    }
    // SAFETY: llama.cpp passes a NUL-terminated line that it owns for the length of the call.
    let line = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    if line.contains(" model buffer size = ") {
        if let Ok(mut kept) = BUFFERS.lock() {
            kept.push(line.trim().to_string());
        }
    }
}

/// One weight buffer from such a line: its name (CPU, CPU_Mapped or CPU_REPACK for the processor, MTL0 or
/// MTL0_Mapped for Metal) and its size in MiB.
fn weight_buffer(line: &str) -> Option<(String, f64)> {
    let (head, tail) = line.split_once(" model buffer size = ")?;
    let name = head.split_whitespace().last()?.to_string();
    let mib = tail.trim().strip_suffix("MiB")?.trim().parse().ok()?;
    Some((name, mib))
}

/// Where the model's weights went, read from llama.cpp's buffer lines: the GPU only when a buffer that is not the
/// processor's holds some of them. A processor buffer proves nothing, because the input embeddings stay in one
/// whatever the plan; llama.cpp's "offloaded N/M layers to GPU" line is worked out from the plan's layer count alone,
/// so it is not read. `gpu` is the GPU llama.cpp listed, if any.
fn weights_on(plan: Gpu, lines: &[String], gpu: Option<&str>) -> String {
    let buffers: Vec<(String, f64)> = lines.iter().filter_map(|l| weight_buffer(l)).collect();
    let off: Vec<String> =
        buffers.iter().filter(|(name, mib)| !name.starts_with("CPU") && *mib > 0.0).map(|(name, mib)| format!("{name}, {mib:.2} MiB")).collect();
    if !off.is_empty() {
        return format!("the GPU {} (weights in {})", gpu.unwrap_or("that llama.cpp did not list"), off.join("; "));
    }
    if buffers.is_empty() {
        return "not known: llama.cpp logged no weight buffer".to_string();
    }
    match (plan, gpu) {
        (Gpu::All, Some(d)) => format!("the processor: the plan asks for the GPU {d}, and every weight buffer is the processor's"),
        (Gpu::All, None) => "the processor: the plan asks for the GPU, and llama.cpp found none here".to_string(),
        (Gpu::Off, _) => "the processor: the plan keeps the GPU out".to_string(),
    }
}

#[test]
fn where_the_weights_went_is_read_from_llama_cpps_buffer_lines_not_from_the_devices_it_lists() {
    let line = |name: &str, mib: f64| format!("load_tensors: {name:>12} model buffer size = {mib:>8.2} MiB");
    assert_eq!(weight_buffer(&line("CPU_REPACK", 123.0)), Some(("CPU_REPACK".to_string(), 123.0)));
    assert_eq!(weight_buffer("load_tensors: offloaded 29/29 layers to GPU"), None);
    let metal = "MTL0 (Apple Paravirtual device, MTL)";
    // A GPU listed and asked for, and every weight on the processor (an offload that fell back): not the GPU.
    let fell_back = [line("CPU_Mapped", 1059.89)];
    assert_eq!(
        weights_on(Gpu::All, &fell_back, Some(metal)),
        format!("the processor: the plan asks for the GPU {metal}, and every weight buffer is the processor's")
    );
    // Metal holding the layers, the input embeddings on the processor beside them.
    let on_metal = [line("CPU_Mapped", 167.25), line("MTL0_Mapped", 1001.5)];
    assert_eq!(weights_on(Gpu::All, &on_metal, Some(metal)), format!("the GPU {metal} (weights in MTL0_Mapped, 1001.50 MiB)"));
    assert_eq!(weights_on(Gpu::All, &[line("CPU_Mapped", 1000.0), line("MTL0", 0.0)], Some(metal)).split(':').next(), Some("the processor"));
    assert_eq!(weights_on(Gpu::All, &fell_back, None), "the processor: the plan asks for the GPU, and llama.cpp found none here");
    assert_eq!(weights_on(Gpu::Off, &fell_back, None), "the processor: the plan keeps the GPU out");
    assert_eq!(weights_on(Gpu::All, &[], Some(metal)), "not known: llama.cpp logged no weight buffer");
}

#[test]
#[ignore = "needs APP_GGUF: the desktop's Qwen2.5 1.5B, 0.99 GB"]
fn desktop_model_answers_a_few_greedy_tokens_with_the_desktop_plan() {
    let path = app_model();
    let plan = desktop_plan();
    // llama.cpp started first (the engine's silent log in place), then this test's callback, before the model loads.
    assert!(backend().is_ok(), "llama.cpp's backend started");
    // SAFETY: llama_log_set only stores the callback and its user data in llama.cpp's and ggml's globals.
    unsafe { llama_cpp_sys_2::llama_log_set(Some(keep_buffers), std::ptr::null_mut()) };
    let t0 = Instant::now();
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan, scratch("desktop"));
    let messages = vec![
        msg(Role::System, "You are Sloane, a detective. You answer briefly."),
        msg(Role::User, "Who are you? One sentence."),
    ];
    let (events, answer) = ask(&engine, req(1, messages, 8));
    let done = answer.unwrap();
    let text = text_of(&events);
    let gpu = devices();
    let buffers = BUFFERS.lock().map(|kept| kept.clone()).unwrap_or_default();
    for line in &buffers {
        println!("{line}");
    }
    let weights = weights_on(plan.gpu, &buffers, gpu.as_deref());
    println!("desktop model on {}/{}: plan {plan:?}; its weights on {weights}", std::env::consts::OS, std::env::consts::ARCH);
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
    assert!(buffers.iter().any(|l| weight_buffer(l).is_some()), "llama.cpp logged where the weights went: {buffers:?}");
    assert!(!text.trim().is_empty(), "{text:?}");
    assert!(!text.contains("<|im"), "no turn marker reaches the page: {text:?}");
    assert!((1..=8).contains(&done.tokens), "a few tokens, at most the request's cap: {done:?}");
    assert!(matches!(done.reason, Reason::Eog | Reason::MaxTokens), "it ends by itself or at the cap: {done:?}");
    assert_eq!(done.threads, plan.threads, "the desktop plan's threads: {done:?}");
    assert!(done.prompt_tokens < 60, "the prompt's markers are single tokens: {done:?}");
}
