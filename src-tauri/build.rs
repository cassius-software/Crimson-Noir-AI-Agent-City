// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Tauri's build step: embeds tauri.conf.json, the icons and the capabilities into the binary.
fn main() {
    tauri_build::build()
}
