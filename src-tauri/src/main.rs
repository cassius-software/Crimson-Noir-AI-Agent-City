// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! The desktop executable. On Windows a release build is a GUI subsystem program, so a double-click opens no
//! console window beside the city. Where the native runner is compiled (the feature on Linux), main first turns off
//! llama.cpp's debugger backtrace (below; src/runner.rs pins it).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Where llama.cpp is compiled in, its abort handler forks and runs gdb (or lldb) on the app to print a backtrace
    // (ggml.c, ggml_print_backtrace) unless GGML_NO_BACKTRACE is set. The app starts no process of its own, so the
    // variable is set here, first: a failed assertion in llama.cpp then aborts the app without starting a debugger.
    // SAFETY: changing the environment is sound only while no other thread reads or writes it. This is the first
    // statement of main: Tauri, GTK, WebKitGTK and llama.cpp start their threads later, inside run(), and nothing the
    // app links starts a thread before main.
    #[cfg(all(target_os = "linux", feature = "native-runner"))]
    std::env::set_var("GGML_NO_BACKTRACE", "1");
    crimson_noir_app_lib::run()
}
