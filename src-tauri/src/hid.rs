// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The page's DualSense driver (src/04_Connect_Hardware/dualsense.ts) writes its output
//! reports through WebHID, and the desktop shell's WebView2 offers no WebHID device chooser this project has seen
//! (the chooser is the browser's to provide; WebView2's documentation is silent). So on Windows the shell opens the
//! controller itself, with hidapi over hid.dll, and lends the page five commands: `hid_list`, `hid_open`,
//! `hid_write`, `hid_feature` and `hid_close` (src/04_Connect_Hardware/nativeHid.ts presents them as WebHID's own
//! shapes). Input reports come back as `hid-input` events, the newest report at most every 8 ms. Only Sony's
//! DualSense and DualSense Edge are listed and opened, the same two filters as the page's WebHID path, so nothing
//! else on the machine is reachable from the page. Elsewhere than Windows the commands exist and answer with an
//! empty list or an error, so the page's code is one and the same.
//! UNCONFIRMED on a physical Windows machine with a controller: written from hidapi's and Tauri's documentation.
//! What breaks if it is removed? In the Windows app a DualSense has no trigger effects, rumble or lightbar.

use serde::Serialize;

/// One controller the shell can open: hidapi's device path is its handle across the commands.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidInfo {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub usage_page: u16,
    pub usage: u16,
    /// "usb", "bluetooth" or "unknown": the page's driver frames its reports by it.
    pub bus: &'static str,
}

/// An input report, as the `hid-input` event carries it: the report ID apart from its data, as WebHID gives them.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidInput {
    pub path: String,
    pub report_id: u8,
    pub data: Vec<u8>,
}

/// The controllers the shell will list and open for the page: Sony's DualSense (0x0ce6) and DualSense Edge (0x0df2).
pub const ALLOWED: &[(u16, u16)] = &[(0x054c, 0x0ce6), (0x054c, 0x0df2)];

/// The longest wait between two input events for one controller, ms: more than the controller's own rate, and
/// still well inside the 250 ms the page's driver allows before it calls decoded input stale.
pub const INPUT_EVERY_MS: u64 = 8;

#[cfg(windows)]
mod native {
    use super::{HidInfo, HidInput, ALLOWED, INPUT_EVERY_MS};
    use hidapi::{BusType, DeviceInfo, HidApi, HidDevice};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    /// An open controller: one handle for the page's writes and feature reads, one (in its reader thread) for input.
    struct Open {
        writer: Mutex<HidDevice>,
        stop: Arc<AtomicBool>,
    }

    /// The open controllers by path, kept in Tauri's managed state.
    #[derive(Default)]
    pub struct HidState {
        open: Mutex<HashMap<String, Arc<Open>>>,
    }

    fn api() -> Result<HidApi, String> {
        HidApi::new().map_err(|e| e.to_string())
    }

    fn allowed(d: &DeviceInfo) -> bool {
        ALLOWED.contains(&(d.vendor_id(), d.product_id()))
    }

    /// hidapi's windows-native backend reads the bus off the device's compatible IDs (USB, BTHENUM, BTHLEDEVICE);
    /// where it answers Unknown the path is read instead: the Bluetooth HID service's UUID or "bthenum" in it is
    /// Bluetooth, "usb" or "vid_" is USB, and the rest is "unknown", which the page's driver treats as USB.
    fn bus_of(d: &DeviceInfo) -> &'static str {
        match d.bus_type() {
            BusType::Usb => "usb",
            BusType::Bluetooth => "bluetooth",
            _ => {
                let p = d.path().to_string_lossy().to_ascii_lowercase();
                if p.contains("00001124-0000-1000-8000-00805f9b34fb") || p.contains("bthenum") || p.contains("bthle") {
                    "bluetooth"
                } else if p.contains("usb") || p.contains("vid_") {
                    "usb"
                } else {
                    "unknown"
                }
            }
        }
    }

    fn info(d: &DeviceInfo) -> HidInfo {
        HidInfo {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product_name: d.product_string().unwrap_or("").to_string(),
            usage_page: d.usage_page(),
            usage: d.usage(),
            bus: bus_of(d),
        }
    }

    fn poisoned<T>(_: T) -> String {
        "the shell's HID state is poisoned".to_string()
    }

    pub fn list() -> Result<Vec<HidInfo>, String> {
        let api = api()?;
        Ok(api.device_list().filter(|d| allowed(d)).map(info).collect())
    }

    pub fn open(app: AppHandle, state: &HidState, path: String) -> Result<HidInfo, String> {
        let api = api()?;
        let d = api
            .device_list()
            .find(|d| allowed(d) && d.path().to_string_lossy() == path)
            .ok_or_else(|| "no such controller".to_string())?;
        let found = info(d);
        let mut open = state.open.lock().map_err(poisoned)?;
        if open.contains_key(&path) {
            return Ok(found);
        }
        let writer = api.open_path(d.path()).map_err(|e| e.to_string())?;
        let reader = api.open_path(d.path()).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        open.insert(path.clone(), Arc::new(Open { writer: Mutex::new(writer), stop: stop.clone() }));
        std::thread::Builder::new()
            .name("hid-reader".into())
            .spawn(move || pump(app, path, reader, stop))
            .map_err(|e| e.to_string())?;
        Ok(found)
    }

    /// Reads input reports and sends the newest to the page at most every INPUT_EVERY_MS, until told to stop or the
    /// controller goes away (a read error ends the thread; the page learns of it when its next write fails).
    fn pump(app: AppHandle, path: String, dev: HidDevice, stop: Arc<AtomicBool>) {
        let every = Duration::from_millis(INPUT_EVERY_MS);
        let mut buf = [0u8; 256];
        let mut last = Instant::now() - every;
        let mut pending: Option<Vec<u8>> = None;
        while !stop.load(Ordering::Relaxed) {
            match dev.read_timeout(&mut buf, INPUT_EVERY_MS as i32) {
                Ok(0) => {}
                Ok(n) => pending = Some(buf[..n].to_vec()),
                Err(_) => break,
            }
            if pending.is_some() && last.elapsed() >= every {
                let report = pending.take().unwrap_or_default();
                if let Some((id, data)) = report.split_first() {
                    last = Instant::now();
                    let _ = app.emit("hid-input", HidInput { path: path.clone(), report_id: *id, data: data.to_vec() });
                }
            }
        }
    }

    fn entry(state: &HidState, path: &str) -> Result<Arc<Open>, String> {
        state
            .open
            .lock()
            .map_err(poisoned)?
            .get(path)
            .cloned()
            .ok_or_else(|| "controller not open".to_string())
    }

    /// Writes one output report: hidapi wants the report ID first, as the page's `sendReport` keeps it apart.
    pub fn write(state: &HidState, path: &str, report_id: u8, data: &[u8]) -> Result<usize, String> {
        let open = entry(state, path)?;
        let mut report = Vec::with_capacity(data.len() + 1);
        report.push(report_id);
        report.extend_from_slice(data);
        let dev = open.writer.lock().map_err(poisoned)?;
        dev.write(&report).map_err(|e| e.to_string())
    }

    /// Reads one feature report of up to `length` bytes; the answer starts with the report ID, as hidapi returns it.
    pub fn feature(state: &HidState, path: &str, report_id: u8, length: usize) -> Result<Vec<u8>, String> {
        let open = entry(state, path)?;
        let mut buf = vec![0u8; length.clamp(2, 4096)];
        buf[0] = report_id;
        let dev = open.writer.lock().map_err(poisoned)?;
        let n = dev.get_feature_report(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n.min(buf.len()));
        Ok(buf)
    }

    pub fn close(state: &HidState, path: &str) -> Result<(), String> {
        if let Some(open) = state.open.lock().map_err(poisoned)?.remove(path) {
            open.stop.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod native {
    use super::HidInfo;

    #[derive(Default)]
    pub struct HidState;

    const ELSEWHERE: &str = "the shell opens controllers itself on Windows only";

    pub fn list() -> Result<Vec<HidInfo>, String> {
        Ok(Vec::new())
    }

    pub fn open(_app: tauri::AppHandle, _state: &HidState, _path: String) -> Result<HidInfo, String> {
        Err(ELSEWHERE.to_string())
    }

    pub fn write(_state: &HidState, _path: &str, _report_id: u8, _data: &[u8]) -> Result<usize, String> {
        Err(ELSEWHERE.to_string())
    }

    pub fn feature(_state: &HidState, _path: &str, _report_id: u8, _length: usize) -> Result<Vec<u8>, String> {
        Err(ELSEWHERE.to_string())
    }

    pub fn close(_state: &HidState, _path: &str) -> Result<(), String> {
        Ok(())
    }
}

pub use native::HidState;

// The commands run off the main thread (`async`): a HID write may wait on the controller, and the window must not.

/// The controllers the shell may open, as they are plugged in or paired right now.
#[tauri::command(async)]
pub fn hid_list() -> Result<Vec<HidInfo>, String> {
    native::list()
}

/// Opens one of them (a no-op when it is open already) and starts its input events.
#[tauri::command(async)]
pub fn hid_open(app: tauri::AppHandle, state: tauri::State<'_, HidState>, path: String) -> Result<HidInfo, String> {
    native::open(app, &state, path)
}

/// One output report: `data` excludes the report ID, as WebHID's sendReport has it.
#[tauri::command(async)]
pub fn hid_write(state: tauri::State<'_, HidState>, path: String, report_id: u8, data: Vec<u8>) -> Result<usize, String> {
    native::write(&state, &path, report_id, &data)
}

/// One feature report, the report ID first.
#[tauri::command(async)]
pub fn hid_feature(state: tauri::State<'_, HidState>, path: String, report_id: u8, length: usize) -> Result<Vec<u8>, String> {
    native::feature(&state, &path, report_id, length)
}

/// Closes it: the reader thread stops and both handles are dropped.
#[tauri::command(async)]
pub fn hid_close(state: tauri::State<'_, HidState>, path: String) -> Result<(), String> {
    native::close(&state, &path)
}
