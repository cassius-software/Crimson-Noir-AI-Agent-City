// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The tiny model proves the plumbing but has no special tokens, no attention and a
//! one-byte vocabulary. These tests run the real model the phones carry (the site's Qwen2.5 0.5B Instruct, Q4_K_M:
//! REAL_GGUF names it) on the processor: its turn markers read as one special token each, its template rendered
//! exactly as ChatML, its quantized kernels answering and ending their turn by themselves, and the context kept from
//! the last answer giving the same greedy text as reading everything again. They are ignored by a plain `cargo test`
//! (the file is 0.4 GB); the native-llm workflow runs them with `-- --ignored` on each runner it has.
//! What breaks if it is removed? Nothing checks that a real model answers through the runner.

mod common;

use std::path::PathBuf;
use std::time::Instant;

use common::*;
use crimson_noir_llm::{backend, half_the_threads, template, Engine, Gpu, Plan, Reason, Role, Sampling, Source};
use llama_cpp_2::model::params::{LlamaModelParams, LlamaSplitMode};
use llama_cpp_2::model::LlamaModel;

fn real() -> PathBuf {
    let path = std::env::var_os("REAL_GGUF").map(PathBuf::from).unwrap_or_default();
    assert!(path.is_file(), "REAL_GGUF must name the site's model (Qwen2.5-0.5B-Instruct-Q4_K_M.gguf)");
    path
}

fn phone_plan() -> Plan {
    Plan { n_ctx: 4096, n_batch: 256, threads: half_the_threads(4), gpu: Gpu::Off, max_tokens: 512, sampling: Sampling::Greedy }
}

#[test]
#[ignore = "needs REAL_GGUF: the site's Qwen2.5 0.5B, 0.4 GB"]
fn real_model_reads_its_turn_markers_as_special_tokens_and_its_template_as_chatml() {
    let params = LlamaModelParams::default().with_n_gpu_layers(0).with_split_mode(LlamaSplitMode::None).with_main_gpu(-1);
    let model = LlamaModel::load_from_file(backend().unwrap(), real(), &params).unwrap();
    let vocab = model.vocab();
    for marker in ["<|im_start|>", "<|im_end|>"] {
        assert_eq!(vocab.tokenize(marker.as_bytes(), false, true).len(), 1, "{marker} is one special token");
        assert!(vocab.tokenize(marker.as_bytes(), false, false).len() > 1, "{marker} as plain text is several");
    }
    let rendered = template::render(&model, &[msg(Role::System, "Be brief."), msg(Role::User, "Hi.")]).unwrap();
    assert_eq!(rendered, "<|im_start|>system\nBe brief.<|im_end|>\n<|im_start|>user\nHi.<|im_end|>\n<|im_start|>assistant\n");
}

#[test]
#[ignore = "needs REAL_GGUF: the site's Qwen2.5 0.5B, 0.4 GB"]
fn real_model_answers_and_ends_its_turn_by_itself() {
    let path = real();
    let engine = Engine::start(pin_of(&path), Source::Path(path), phone_plan(), scratch("real"));
    let messages = vec![
        msg(Role::System, "You answer with one word."),
        msg(Role::User, "Is water wet? Answer yes or no."),
    ];
    let t0 = Instant::now();
    let (events, answer) = ask(&engine, req(1, messages, 64));
    let done = answer.unwrap();
    let text = text_of(&events);
    println!(
        "real model: {:?} in {} tokens ({} of prompt, {} ms reading, {} ms answering, {:.1} tokens/s, {} threads), {:?} all told",
        text,
        done.tokens,
        done.prompt_tokens,
        done.prefill_ms,
        done.gen_ms,
        f64::from(done.tokens) * 1000.0 / done.gen_ms.max(1) as f64,
        done.threads,
        t0.elapsed()
    );
    assert_eq!(done.reason, Reason::Eog, "the model ends its own turn: {text:?}");
    assert!(!text.trim().is_empty() && text.len() < 200, "{text:?}");
    assert!(!text.contains("<|im"), "no turn marker reaches the page: {text:?}");
    assert!(done.prompt_tokens < 40, "the prompt's markers are single tokens: {done:?}");
}

#[test]
#[ignore = "needs REAL_GGUF: the site's Qwen2.5 0.5B, 0.4 GB"]
fn real_model_gives_the_same_greedy_answer_with_the_kept_context_as_without() {
    let path = real();
    let first = vec![msg(Role::System, "You are a helpful assistant."), msg(Role::User, "Name three colours.")];
    let kept = Engine::start(pin_of(&path), Source::Path(path.clone()), phone_plan(), scratch("kept"));
    let (events, _) = ask(&kept, req(1, first.clone(), 24));
    let mut second = first;
    second.push(msg(Role::Assistant, &text_of(&events)));
    second.push(msg(Role::User, "Now name one animal."));
    let (with_events, with) = ask(&kept, req(2, second.clone(), 16));
    let with = with.unwrap();
    assert!(with.reused > 10, "the second answer kept the first's context: {with:?}");
    let fresh = Engine::start(pin_of(&path), Source::Path(path), phone_plan(), scratch("fresh"));
    let (fresh_events, fresh_done) = ask(&fresh, req(1, second, 16));
    assert_eq!(fresh_done.unwrap().reused, 0);
    assert_eq!(text_of(&with_events), text_of(&fresh_events), "the kept context changes nothing in the answer");
}
