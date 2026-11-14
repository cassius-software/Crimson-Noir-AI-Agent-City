// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the whole desktop shell: one borderless, transparent Tauri window over the built
//! page (tauri.conf.json names dist/index.html, the same single file the browser build ships). The page draws its own
//! title bar (src/07_Execute_Actions/TitleBar.tsx) and drives this window through Tauri's window API, which the
//! capabilities file admits command by command. On Windows 11 the window asks for Mica behind it, so the frosted
//! glass bar frosts the desktop where the page is transparent; a Windows that cannot (10, or a build older than
//! 22000) gets the page's own black and nothing else changes.
//! On Windows the shell also opens a DualSense for the page (hid.rs), since its web view has no WebHID chooser, and
//! reads the GPUs' memory for auto's Ollama model (gpu.rs), which a page cannot. And it lends the page a read of the
//! model the Windows installer carries beside the app (model.rs over model_file.rs), so Sloane talks from the first
//! launch. Built with the native-runner feature on Linux, it runs a model itself (runner.rs over native/llm:
//! llama.cpp in the app's own process) and lends the page three commands, what it carries, one answer streamed on a
//! channel, and a stop; a page that starts loading stops every answer it asked for. Everywhere else those three
//! commands answer that there is none.
//! What breaks if it is removed? There is no desktop app; the page is only a file for a browser.

mod gpu;
mod hid;
mod model;
mod model_file;
mod runner;

use tauri::webview::PageLoadEvent;
use tauri::Manager;

/// Builds and runs the app. Called from main.rs (and from a mobile entry point, should one ever exist).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(hid::HidState::default())
        .manage(runner::Runner::default())
        .invoke_handler(tauri::generate_handler![hid::hid_list, hid::hid_open, hid::hid_write, hid::hid_feature, hid::hid_close, gpu::gpu_memory, runner::native_model, runner::native_generate, runner::native_stop, model::app_model, model::app_model_read])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;
            frost(&window);
            runner::start(app.handle());
            Ok(())
        })
        // A reload does not fail the channel an answer streams on, so this is what stops the old page's answers.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                runner::page_loading(webview.app_handle());
            }
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
