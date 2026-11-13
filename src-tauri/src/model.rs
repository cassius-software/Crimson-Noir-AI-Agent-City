// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The Windows installer carries a model beside the app (tauri.model.conf.json puts
//! models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf, its LICENSE and its NOTICE in the app's resource folder), so Sloane can
//! talk from the first launch with nothing to find or download. A page cannot open a file by itself, so the shell lends
//! it two commands over that one file, and nothing else of the disk. `app_model` answers the file's name and size when
//! it is there with exactly the size it was built with, else nothing (the bare .exe, which carries no model, and every
//! app that is not the Windows installer's answer nothing). `app_model_read` answers up to 4 MiB of it from an offset,
//! as base64 text (model_file.rs), because the page's IPC answers arrive as text: the binary path is a request to
//! ipc.localhost that the page's air gap refuses, so Tauri falls back to the message path, which carries text.
//!
//! The page takes no path and names no file: the file is fixed here. It reads the model piece by piece
//! (src/07_Execute_Actions/desktopShell.ts shellModelFetch), checks its size and SHA-256 against its pin on every byte
//! (src/09_Cognition/siteModel.ts APP_MODEL), and keeps it in its own storage as the web copy keeps the site's model.
//! Both commands run off the main thread (`async`), so the window never waits on the disk.
//! UNCONFIRMED on a physical Windows machine: written from the Tauri documentation and Tauri 2.12.3's sources,
//! checked with cargo check and clippy for x86_64-pc-windows-msvc; windows-app.yml builds it.
//! What breaks if it is removed? The installer carries a model the page cannot reach, and Sloane waits for a model the
//! person has to find.

use std::path::PathBuf;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::model_file::{is_model, read_text, BYTES, FILE};

/// What `app_model` answers: the file's name and size, as the page's pin names them.
#[derive(Serialize)]
pub struct AppModel {
    file: &'static str,
    bytes: u64,
}

/// Where the installer puts the model: `models/<FILE>` in the app's resource folder.
fn model_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().resolve(format!("models/{FILE}"), BaseDirectory::Resource).ok()
}

/// The carried model's name and size, or nothing where the app carries none (or one of another size).
#[tauri::command(async)]
pub fn app_model(app: AppHandle) -> Option<AppModel> {
    let path = model_path(&app)?;
    is_model(&path, BYTES).then_some(AppModel { file: FILE, bytes: BYTES })
}

/// Up to `len` bytes (1 to 4 MiB) of the carried model from `offset`, as base64 text; empty text at its end.
#[tauri::command(async)]
pub fn app_model_read(app: AppHandle, offset: u64, len: u64) -> Result<String, String> {
    let path = model_path(&app).ok_or_else(|| "this app has no resource folder to read its model from".to_string())?;
    read_text(&path, BYTES, offset, len)
}
