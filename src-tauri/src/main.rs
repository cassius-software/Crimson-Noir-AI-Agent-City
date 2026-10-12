// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! The desktop executable. On Windows a release build is a GUI subsystem program, so a double-click opens no
//! console window beside the city.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    crimson_noir_app_lib::run()
}
