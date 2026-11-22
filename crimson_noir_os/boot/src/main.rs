// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the bootable image's root. Built for `x86_64-unknown-uefi`, `aarch64-unknown-uefi`
//! or `riscv64gc-unknown-none-elf` (Rust has no riscv64 UEFI target: arch/riscv64.rs carries the header that makes
//! that build a UEFI application) it is a UEFI application (`efi_main`, no standard library, no runtime): the firmware
//! loads it from the boot medium and it takes the machine over (image.rs; the machine layer for each architecture is
//! arch.rs). Built for any other target it is only a note saying how to build the image, so the workspace still builds
//! and tests on a desktop.
//! What breaks if it is removed? There is no bootable image.
#![cfg_attr(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")), no_std)]
#![cfg_attr(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")), no_main)]

#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
extern crate alloc;

#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
mod arch;
#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
mod heap;
#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
mod image;
#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
mod uefi;

/// The tables the image was built with (build.rs, from containment.nix; the hosted runtime reads the same tables, so
/// not every one is read here).
#[cfg(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none")))]
#[allow(dead_code)]
mod locked {
    include!(concat!(env!("OUT_DIR"), "/locked.rs"));
}

#[cfg(not(any(target_os = "uefi", all(target_arch = "riscv64", target_os = "none"))))]
fn main() {
    eprintln!(
        "crimson_boot is the bootable image: build it with `cargo build -p crimson_boot --target x86_64-unknown-uefi --release` (or aarch64-unknown-uefi, or riscv64gc-unknown-none-elf; tools/build-image.sh makes the disk image and the ISO)."
    );
}
