// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Sloane's model run by the app itself: llama.cpp in the app's process, through llama-cpp-2.
//!
//! Why does this file exist? The page runs its model in the page (wllama) only where the web view has JSPI and shared
//! WebAssembly Memory64: Chromium and WebView2. The macOS, Linux and iOS apps are WebKit and have neither, and Android's
//! web view is not counted on, so on those apps the shell runs the model itself and the page asks it for an answer.
//! This crate is that runner, with no Tauri in it, so every part of it is tested on a plain CI runner:
//! - one thread named "model" owns llama.cpp's backend, the loaded model and its context (`engine`);
//! - the model file is checked against its pin (size, SHA-256) once and remembered, or copied out and checked on the
//!   way where the platform keeps it inside a package (`verify`);
//! - an answer is a job: the chat rendered with the model's own template, the prompt read in chunks (reusing what the
//!   last answer left in the context), then one token at a time, streamed as small text events (`gen`, `text`);
//! - a Stop sets the job's flag, read between decode calls; jobs run in order, and a queued one is told it waits;
//! - what the shell and the page exchange is plain data with fixed names (`wire`), pinned by tests/wire.json.
//!
//! The shell (src-tauri) chooses the plan for its platform (context, batch, threads, GPU) and the pin of the model it
//! carries; nothing here reads the network, starts a process or opens any file but the one model file and its stamp.
//! What breaks if it is removed? The apps on macOS, Linux, Android and iOS have nothing to run a model with.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod backend;
pub mod engine;
mod gen;
pub mod guard;
pub mod template;
pub mod text;
pub mod verify;
pub mod wire;

pub use backend::backend;
pub use engine::{half_the_threads, Answer, Engine, Gpu, Opener, Plan, Sampling, Sink, Source};
pub use verify::Pin;
pub use wire::{ErrorCode, GenDone, GenRequest, Message, Reason, Role, RunError, RunEvent, Status};
