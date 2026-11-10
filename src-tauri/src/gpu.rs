// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? Provider auto sizes Ollama's model by the GPUs' memory (src/09_Cognition/modelFit.ts),
//! and a page cannot read that: WebGPU tells it nothing of the kind. On NixOS the launcher reads it (nvidia-smi, the
//! amdgpu driver) and puts it in the page's address; in the Windows app the shell reads it here and lends the page
//! one command, `gpu_memory`: the dedicated memory of each hardware adapter DXGI lists, in bytes, in DXGI's order.
//! Software adapters (the Basic Render Driver) are left out. The page judges the list (modelFit.ts figureFromAdapters:
//! a floor and the launcher's sum), so the rule lives in one place it can be tested. Nothing is written, nothing is
//! opened but DXGI's factory, and nothing leaves the machine. Elsewhere than Windows the command exists and answers
//! with an empty list, so the page's code is one and the same.
//! DXGI lists graphics adapters only: a data-centre card in TCC or MCDM mode is not one, so it is not counted though
//! Ollama runs on it (the MANUAL says to type `ask vram` there). DXGI_ADAPTER_FLAG_REMOTE is not masked: Microsoft
//! documents it as reserved, always 0.
//! UNCONFIRMED on a physical Windows machine: written from the DXGI and windows-rs documentation, built by CI.
//! What breaks if it is removed? The Windows app gives auto no GPU figure, so `ask vram` has to be typed there.

/// The dedicated memory of each hardware adapter, in bytes (DXGI_ADAPTER_DESC1.DedicatedVideoMemory).
#[cfg(windows)]
fn adapters() -> Vec<u64> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

    // SAFETY: a plain COM factory call; the interface it returns is released when it is dropped.
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[app] DXGI gave no factory ({e}); the page gets no GPU figure");
            return Vec::new();
        }
    };
    let software = DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32;
    let mut bytes = Vec::new();
    // DXGI numbers its adapters from 0 and answers DXGI_ERROR_NOT_FOUND past the last; any error ends the list.
    for i in 0u32.. {
        // SAFETY: as above; the adapter is released when it is dropped.
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(i) }) else { break };
        // SAFETY: GetDesc1 fills a plain struct.
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
        if desc.Flags & software == 0 {
            bytes.push(desc.DedicatedVideoMemory as u64);
        }
    }
    bytes
}

#[cfg(not(windows))]
fn adapters() -> Vec<u64> {
    Vec::new()
}

/// The GPUs' dedicated memory, adapter by adapter, for auto's Ollama model. Off the main thread (`async`), as the
/// HID commands are: DXGI is quick, and the window must not wait on it even so.
#[tauri::command(async)]
pub fn gpu_memory() -> Vec<u64> {
    adapters()
}
