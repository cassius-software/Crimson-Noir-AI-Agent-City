// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Tauri's build step: embeds tauri.conf.json, the icons and the capabilities into the binary. It also decides where
//! the native model runner is compiled: with the `native-runner` feature on a target whose operating system is in
//! `RUNNER_OS` (Linux and macOS), it sets the cfg `native_runner`, and main.rs, runner.rs and model_file.rs ask only
//! that, so the platforms cannot drift apart from one file to the next (Cargo.toml's target table names the same two;
//! src/07_Execute_Actions/desktopShell.test.ts holds the lists equal). Where the runner is compiled the linker also
//! writes its map beside the executable (`target/<profile>/crimson-noir-app.map`, one per slice of the macOS app):
//! which members of llama.cpp's static libraries it took and which of their sections (GNU ld, lld) or symbols (Apple's
//! linker) it kept. The shipped binary is stripped, so tools/build/linuxAudit.mjs and macAudit.mjs `symbols` read that
//! map to prove no download, HTTP or subprocess code of llama.cpp's common library is inside. The map changes nothing
//! in the binary.
use std::path::Path;

/// The operating systems whose apps run the model themselves when built with the native-runner feature. Windows runs
/// it in the page (WebView2); the phones join in later slices.
const RUNNER_OS: [&str; 2] = ["linux", "macos"];

fn main() {
    println!("cargo:rustc-check-cfg=cfg(native_runner)");
    let feature = std::env::var_os("CARGO_FEATURE_NATIVE_RUNNER").is_some();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if feature && RUNNER_OS.contains(&os.as_str()) {
        println!("cargo:rustc-cfg=native_runner");
        let out = std::env::var("OUT_DIR").unwrap_or_default();
        // OUT_DIR is target/<profile>/build/<package>-<hash>/out: three folders up is where the executable lands.
        if let Some(profile) = Path::new(&out).ancestors().nth(3) {
            let map = profile.join("crimson-noir-app.map");
            // GNU ld and lld take -Map=<file>; Apple's linker takes -map <file>.
            let arg = if os == "macos" { format!("-Wl,-map,{}", map.display()) } else { format!("-Wl,-Map={}", map.display()) };
            println!("cargo:rustc-link-arg-bins={arg}");
        }
    }
    tauri_build::build()
}
