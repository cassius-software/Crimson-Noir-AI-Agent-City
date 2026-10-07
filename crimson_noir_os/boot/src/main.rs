//! Why does this file exist? It is the bootable image's root. Built for `x86_64-unknown-uefi` it is a UEFI application
//! (`efi_main`, no standard library, no runtime): the firmware loads it from the boot medium and it takes the machine
//! over (image.rs). Built for any other target it is only a note saying how to build the image, so the workspace still
//! builds and tests on a desktop.
//! What breaks if it is removed? There is no bootable image.
#![cfg_attr(target_os = "uefi", no_std)]
#![cfg_attr(target_os = "uefi", no_main)]

#[cfg(target_os = "uefi")]
extern crate alloc;

#[cfg(target_os = "uefi")]
mod arch;
#[cfg(target_os = "uefi")]
mod heap;
#[cfg(target_os = "uefi")]
mod image;
#[cfg(target_os = "uefi")]
mod uefi;

/// The tables the image was built with (build.rs, from containment.nix; the hosted runtime reads the same tables, so
/// not every one is read here).
#[cfg(target_os = "uefi")]
#[allow(dead_code)]
mod locked {
    include!(concat!(env!("OUT_DIR"), "/locked.rs"));
}

#[cfg(not(target_os = "uefi"))]
fn main() {
    eprintln!("crimson_boot is the bootable image: build it with `cargo build -p crimson_boot --target x86_64-unknown-uefi --release` (tools/build-image.sh makes the disk image and the ISO).");
}
