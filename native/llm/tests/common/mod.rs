// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? What the runner's tests share: where the test models are, a pin made from a file, a
//! plan, a fresh folder for stamps, and `ask`, which collects an answer's events in order.
//! What breaks if it is removed? Every test writes its own copy of these.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crimson_noir_llm::{Answer, Engine, GenRequest, Gpu, Message, Pin, Plan, Role, RunEvent, Sampling};
use sha2::{Digest, Sha256};

/// The folder tools/browser/tinyGguf.mjs wrote: tiny-a.gguf, its two shards (--split, for the refusal of a split
/// model) and tiny-a-plain.gguf (--plain).
pub fn tiny_dir() -> PathBuf {
    let dir = std::env::var_os("TINY_GGUF_DIR").map(PathBuf::from).unwrap_or_default();
    assert!(
        dir.join("tiny-a.gguf").is_file(),
        "TINY_GGUF_DIR must name a folder holding the tiny models: node tools/browser/tinyGguf.mjs <dir>, again with \
         --split and with --plain, then TINY_GGUF_DIR=<dir> cargo test"
    );
    dir
}

pub fn tiny(name: &str) -> PathBuf {
    tiny_dir().join(name)
}

/// The pin of a file as it is: its name, size and SHA-256.
pub fn pin_of(path: &Path) -> Pin {
    let bytes = fs::read(path).unwrap();
    let sha256 = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    Pin { file: path.file_name().unwrap().to_string_lossy().into_owned(), bytes: bytes.len() as u64, sha256 }
}

/// A plan for the tiny model on a CI runner: greedy, no GPU, two threads.
pub fn plan() -> Plan {
    Plan { n_ctx: 6144, n_batch: 512, threads: 2, gpu: Gpu::Off, max_tokens: 4096, sampling: Sampling::Greedy }
}

/// A fresh, empty folder of its own for each call.
pub fn scratch(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "crimson-noir-llm-{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn msg(role: Role, content: &str) -> Message {
    Message { role, content: content.to_string() }
}

pub fn chat() -> Vec<Message> {
    vec![msg(Role::System, "You are Sloane."), msg(Role::User, "Say hi.")]
}

pub fn req(id: u32, messages: Vec<Message>, max_tokens: u32) -> GenRequest {
    GenRequest { id, messages, max_tokens, think: false }
}

/// The events an answer streamed, in order, and how it ended.
pub fn ask(engine: &Engine, request: GenRequest) -> (Vec<RunEvent>, Answer) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let into = events.clone();
    let answer = engine
        .submit(
            request,
            Box::new(move |e| {
                into.lock().unwrap().push(e);
                true
            }),
        )
        .recv()
        .unwrap();
    let events = events.lock().unwrap().clone();
    (events, answer)
}

/// The text an answer streamed.
pub fn text_of(events: &[RunEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            RunEvent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}
