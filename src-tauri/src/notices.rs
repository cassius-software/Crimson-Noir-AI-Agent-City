// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? This app is built with some four hundred open-source Rust crates, and their licences ask
//! that the copyright notices and licence texts travel with every copy of it. `../notices/RUST-CRATES.txt` is those
//! notices (tools/license/notices.mjs writes it from the lockfile and the crates' own packages; CI fails when it is
//! not what the registry gives). It travels twice. Here it is compiled into the binary, so a copy that is one file
//! and nothing else (the bare Windows .exe, the library inside a phone's package) still carries it, whole and as
//! plain text. And tauri.conf.json puts the same file among every package's resources (`licenses/RUST-CRATES.txt`),
//! where a person can open it. `third_party_notices` lends the page the text, so the linker cannot drop it and a
//! screen of the page can show it. The page's own notices, for what the page is built with, are inside the page.
//! What breaks if it is removed? The apps go out without the notices their dependencies' licences ask for.

/// The notices of every Rust crate this app is built with, as tools/license/notices.mjs wrote them.
pub const RUST_CRATES: &str = include_str!("../notices/RUST-CRATES.txt");

/// The same text for the page: read only, the same in every app.
#[tauri::command]
pub fn third_party_notices() -> &'static str {
    RUST_CRATES
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file's first line, as tools/license/notices.mjs TITLE has it.
    const TITLE: &str = "THIRD-PARTY NOTICES: THE RUST CRATES THIS APP IS BUILT WITH\n";

    #[test]
    fn the_binary_carries_the_notices_whole() {
        assert!(RUST_CRATES.starts_with(TITLE), "the generated file, from its first line");
        assert!(RUST_CRATES.len() > 100_000, "four hundred crates' texts, not a stub");
        assert!(RUST_CRATES.ends_with('\n') && !RUST_CRATES.contains('\r'), "as the generator writes it");
        assert_eq!(third_party_notices(), RUST_CRATES, "the page is lent the same text");
    }
}
