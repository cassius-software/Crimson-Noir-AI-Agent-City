// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the whole desktop shell: one borderless, transparent Tauri window over the built
//! page (tauri.conf.json names dist/index.html, the same single file the browser build ships). The page draws its own
//! title bar (src/07_Execute_Actions/TitleBar.tsx) and drives this window through Tauri's window API, which the
//! capabilities file admits command by command. On Windows 11 the window asks for Mica behind it, so the frosted
//! glass bar frosts the desktop where the page is transparent; a Windows that cannot (10, or a build older than
//! 22000) gets the page's own black and nothing else changes.
//! What breaks if it is removed? There is no desktop app; the page is only a file for a browser.

use tauri::Manager;

/// Builds and runs the app. Called from main.rs (and from a mobile entry point, should one ever exist).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;
            frost(&window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Crimson Noir desktop app could not start");
}

/// Mica behind the window, dark, on Windows 11; best effort, because the page is complete without it.
/// Where there is none (Windows 10, or a build older than 22000), the window itself is painted the brand's black, so
/// the title bar strip (the one part of the page left transparent) is dark glass over black rather than a hole.
#[cfg(windows)]
fn frost(window: &tauri::WebviewWindow) {
    if let Err(e) = window_vibrancy::apply_mica(window, Some(true)) {
        eprintln!("[app] no Mica behind the window ({e}); the window is painted black instead");
        opaque(window);
    }
}

#[cfg(not(windows))]
fn frost(window: &tauri::WebviewWindow) {
    opaque(window);
}

/// The brand's black (brand/tokens.json `black`) behind the page.
fn opaque(window: &tauri::WebviewWindow) {
    if let Err(e) = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255))) {
        eprintln!("[app] the window's background could not be set ({e})");
    }
}
