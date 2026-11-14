// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Tauri's build step: embeds tauri.conf.json, the icons and the capabilities into the binary. Where the native runner
//! is compiled (the feature on a Linux target) the linker also writes its map beside the executable
//! (`target/<profile>/crimson-noir-app.map`): which members of llama.cpp's static libraries it took and which of their
//! sections it kept. The shipped binary is stripped, so tools/build/linuxAudit.mjs `symbols` reads that map to prove no
//! download, HTTP or subprocess code of llama.cpp's common library is inside. The map changes nothing in the binary.
use std::path::Path;

fn main() {
    let runner = std::env::var_os("CARGO_FEATURE_NATIVE_RUNNER").is_some();
    if runner && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        let out = std::env::var("OUT_DIR").unwrap_or_default();
        // OUT_DIR is target/<profile>/build/<package>-<hash>/out: three folders up is where the executable lands.
        if let Some(profile) = Path::new(&out).ancestors().nth(3) {
            println!("cargo:rustc-link-arg-bins=-Wl,-Map={}", profile.join("crimson-noir-app.map").display());
        }
    }
    tauri_build::build()
}
