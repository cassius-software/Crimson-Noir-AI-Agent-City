// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The bootable image is built for two machines, `x86_64-unknown-uefi` and
//! `aarch64-unknown-uefi`, and everything it does to the machine itself once the firmware lets go lives in one module per
//! architecture behind the same names: `serial_init` and `Serial` (the log, a line a test harness reads), `ticks` (the
//! only clock), `cli` and `halt`, `take_over` (the image's own exception handling, so every CPU exception lands on the
//! fault screen), `Keyboard` and `poll_keys` (the keys typed since the last frame, in the core's key codes), and `Fault`
//! (what a CPU exception says about itself). image.rs calls only these.
//! What breaks if it is removed? image.rs has no machine to run on.

#[cfg(target_arch = "x86_64")]
mod x86_64;
#[cfg(target_arch = "x86_64")]
pub use x86_64::*;

#[cfg(target_arch = "aarch64")]
mod aarch64;
#[cfg(target_arch = "aarch64")]
pub use aarch64::*;
