// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? llama.cpp's backend is started once per process: a second `LlamaBackend::init` fails
//! (llama-cpp-2 keeps a process-wide flag), and it is reset only when the one backend is dropped. Every engine, and
//! every test running in parallel in one test binary, borrows this one. Its logs are silenced in release builds, before
//! it starts (on Apple, starting it registers Metal, which logs its device and shader library), so llama.cpp's log
//! lines never reach a terminal.
//! What breaks if it is removed? The second engine of a process cannot start, and tests fail at random.

use std::sync::OnceLock;

use llama_cpp_2::llama_backend::LlamaBackend;

static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();

/// The process's one llama.cpp backend, started on first use; anything else in the process that loads a model with
/// llama-cpp-2 (a test) borrows it too.
pub fn backend() -> Result<&'static LlamaBackend, String> {
    BACKEND
        .get_or_init(|| {
            if !cfg!(debug_assertions) {
                // Before init: on Apple, llama_backend_init registers Metal, which logs its device and shader library.
                unsafe extern "C" fn void_log(
                    _: llama_cpp_sys_2::ggml_log_level,
                    _: *const std::os::raw::c_char,
                    _: *mut std::os::raw::c_void,
                ) {
                }
                // SAFETY: llama_log_set only stores the callback and its user data in llama.cpp's and ggml's globals.
                unsafe { llama_cpp_sys_2::llama_log_set(Some(void_log), std::ptr::null_mut()) };
            }
            LlamaBackend::init().map_err(|e| format!("llama.cpp could not start ({e})"))
        })
        .as_ref()
        .map_err(Clone::clone)
}
