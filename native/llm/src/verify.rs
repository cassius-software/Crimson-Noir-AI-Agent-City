// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The runner loads only the model the app was built with: the file's name, its exact size
//! and its SHA-256 are its pin (the page's own: src/09_Cognition/siteModel.ts). Reading a gigabyte to hash it on every
//! launch would cost seconds, so the hash is checked once and remembered in a stamp beside the app's data (the pin's
//! hash, the size and the file's modification time); a stamp that does not match any of them is checked again.
//! Where a platform keeps the model inside its package (Android's assets), `copy_checked` copies it out to a real file
//! that llama.cpp can map, hashing every byte on the way, into a `.part` file renamed only once the hash is right,
//! after making sure the copy fits.
//! What breaks if it is removed? The runner would load any file of the right name, or hash a gigabyte every launch.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

/// The size of each read while hashing or copying.
const PIECE: usize = 4 << 20;
/// Room left over after a copy, so the copy never fills the disk.
pub const SPARE: u64 = 64 << 20;

/// The model the app carries: its file name, exact size and SHA-256 (lowercase hex).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
}

/// How a file was found good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checked {
    /// The stamp matched: nothing was read.
    Stamp,
    /// Every byte was hashed (and a stamp written).
    Hashed,
}

fn stamp_path(stamp_dir: &Path, pin: &Pin) -> PathBuf {
    stamp_dir.join(format!("{}.verified", pin.file))
}

fn stamp_text(pin: &Pin, path: &Path) -> io::Result<String> {
    let modified = fs::metadata(path)?.modified()?;
    let since = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    Ok(format!("{} {} {}.{:09}\n", pin.sha256, pin.bytes, since.as_secs(), since.subsec_nanos()))
}

/// The SHA-256 of a reader, `progress(done)` after each piece.
fn hash_reader(reader: &mut dyn Read, mut progress: impl FnMut(u64)) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; PIECE];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        progress(done);
    }
    Ok((hex(&hasher.finalize()), done))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `path` is the pinned file: the right size, and either a matching stamp or the right SHA-256 (then stamped).
/// `progress(done, total)` while hashing. The error is a sentence the page can show.
pub fn check_file(path: &Path, pin: &Pin, stamp_dir: &Path, mut progress: impl FnMut(u64, u64)) -> Result<Checked, String> {
    let meta = fs::metadata(path).map_err(|_| format!("the app's model ({}) is not where the app put it", pin.file))?;
    if !meta.is_file() {
        return Err(format!("the app's model ({}) is not a file", pin.file));
    }
    if meta.len() != pin.bytes {
        return Err(format!(
            "the app's model ({}) is {} bytes, not the {} it was built with",
            pin.file,
            meta.len(),
            pin.bytes
        ));
    }
    let stamp = stamp_path(stamp_dir, pin);
    if let (Ok(want), Ok(have)) = (stamp_text(pin, path), fs::read_to_string(&stamp)) {
        if want == have {
            return Ok(Checked::Stamp);
        }
    }
    let mut file = File::open(path).map_err(|e| format!("the app's model ({}) could not be read ({e})", pin.file))?;
    let (sha, _) = hash_reader(&mut file, |done| progress(done, pin.bytes))
        .map_err(|e| format!("the app's model ({}) could not be read ({e})", pin.file))?;
    if sha != pin.sha256 {
        return Err(format!("the app's model ({}) is not the file the app was built with (its SHA-256 differs)", pin.file));
    }
    // A stamp that cannot be written only means the next launch hashes again.
    if fs::create_dir_all(stamp_dir).is_ok() {
        if let Ok(text) = stamp_text(pin, path) {
            let _ = fs::write(&stamp, text);
        }
    }
    Ok(Checked::Hashed)
}

/// The bytes free for an unprivileged writer on the file system holding `dir`, where it can be asked.
pub fn free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a NUL-terminated path and `st` a statvfs the call fills in.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

/// Copies the pinned model from `reader` to `dest`, checking the size and SHA-256 of every byte, through `dest.part`
/// renamed into place only when both are right (and synced). Refused before it starts when `free(dir)` says the copy
/// and `SPARE` do not fit. A failed copy leaves no `.part` behind. `progress(done, total)` after each piece.
pub fn copy_checked(
    reader: &mut dyn Read,
    dest: &Path,
    pin: &Pin,
    free: impl Fn(&Path) -> Option<u64>,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let dir = dest.parent().ok_or_else(|| "the model's folder has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("the model's folder could not be made ({e})"))?;
    if let Some(have) = free(dir) {
        if have < pin.bytes.saturating_add(SPARE) {
            return Err(format!(
                "the device has {} MB free, and the app's model needs {} MB",
                have >> 20,
                pin.bytes.saturating_add(SPARE) >> 20
            ));
        }
    }
    let part = dest.with_extension("part");
    let result = (|| -> Result<(), String> {
        let mut out = File::create(&part).map_err(|e| format!("the model could not be written ({e})"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; PIECE];
        let mut done = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("the app's model could not be read ({e})"))?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > pin.bytes {
                return Err(format!("the app's model ({}) is longer than the {} bytes it was built with", pin.file, pin.bytes));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| format!("the model could not be written ({e})"))?;
            progress(done, pin.bytes);
        }
        if done != pin.bytes {
            return Err(format!("the app's model ({}) ended after {} of its {} bytes", pin.file, done, pin.bytes));
        }
        if hex(&hasher.finalize()) != pin.sha256 {
            return Err(format!("the app's model ({}) is not the file the app was built with (its SHA-256 differs)", pin.file));
        }
        out.sync_all().map_err(|e| format!("the model could not be written ({e})"))?;
        drop(out);
        fs::rename(&part, dest).map_err(|e| format!("the model could not be put in place ({e})"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

/// Writes the stamp for a file just copied and checked, so the next launch reads nothing.
pub fn stamp(path: &Path, pin: &Pin, stamp_dir: &Path) {
    if fs::create_dir_all(stamp_dir).is_ok() {
        if let Ok(text) = stamp_text(pin, path) {
            let _ = fs::write(stamp_path(stamp_dir, pin), text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{Duration, SystemTime};

    fn scratch(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("crimson-noir-llm-verify-{name}-{stamp}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pin_of(bytes: &[u8]) -> Pin {
        let (sha256, n) = hash_reader(&mut Cursor::new(bytes), |_| {}).unwrap();
        Pin { file: "m.gguf".into(), bytes: n, sha256 }
    }

    #[test]
    fn check_hashes_once_then_trusts_the_stamp_until_the_file_changes() {
        let dir = scratch("stamp");
        let data = b"a model of eleven".repeat(1000);
        let path = dir.join("m.gguf");
        fs::write(&path, &data).unwrap();
        let pin = pin_of(&data);
        let stamps = dir.join("stamps");
        let mut seen = 0;
        assert_eq!(check_file(&path, &pin, &stamps, |done, total| { seen = done; assert_eq!(total, pin.bytes) }), Ok(Checked::Hashed));
        assert_eq!(seen, pin.bytes);
        assert_eq!(check_file(&path, &pin, &stamps, |_, _| panic!("read")), Ok(Checked::Stamp));
        // A new modification time is checked again.
        let f = File::options().write(true).open(&path).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        drop(f);
        assert_eq!(check_file(&path, &pin, &stamps, |_, _| {}), Ok(Checked::Hashed));
        // A stamp for another hash is not trusted.
        let other = Pin { sha256: "0".repeat(64), ..pin.clone() };
        let err = check_file(&path, &other, &stamps, |_, _| {}).unwrap_err();
        assert!(err.contains("SHA-256 differs"), "{err}");
    }

    #[test]
    fn check_refuses_a_missing_file_and_a_wrong_size_in_a_sentence() {
        let dir = scratch("size");
        let pin = Pin { file: "m.gguf".into(), bytes: 10, sha256: "0".repeat(64) };
        let err = check_file(&dir.join("m.gguf"), &pin, &dir, |_, _| {}).unwrap_err();
        assert_eq!(err, "the app's model (m.gguf) is not where the app put it");
        fs::write(dir.join("m.gguf"), b"short").unwrap();
        let err = check_file(&dir.join("m.gguf"), &pin, &dir, |_, _| {}).unwrap_err();
        assert_eq!(err, "the app's model (m.gguf) is 5 bytes, not the 10 it was built with");
    }

    #[test]
    fn copy_checks_every_byte_and_leaves_nothing_behind_on_failure() {
        let dir = scratch("copy");
        let data = vec![7u8; PIECE + 123];
        let pin = pin_of(&data);
        let dest = dir.join("models").join("m.gguf");
        let room = |_: &Path| Some(u64::MAX);

        let err = copy_checked(&mut Cursor::new(&data[..data.len() - 1]), &dest, &pin, room, |_, _| {}).unwrap_err();
        assert!(err.contains("ended after"), "{err}");
        assert!(!dest.exists() && !dest.with_extension("part").exists());

        let mut wrong = data.clone();
        wrong[5] = 8;
        let err = copy_checked(&mut Cursor::new(&wrong), &dest, &pin, room, |_, _| {}).unwrap_err();
        assert!(err.contains("SHA-256 differs"), "{err}");
        assert!(!dest.exists() && !dest.with_extension("part").exists());

        let mut longer = data.clone();
        longer.push(0);
        assert!(copy_checked(&mut Cursor::new(&longer), &dest, &pin, room, |_, _| {}).unwrap_err().contains("longer"));

        let err = copy_checked(&mut Cursor::new(&data), &dest, &pin, |_: &Path| Some(pin.bytes), |_, _| {}).unwrap_err();
        assert!(err.contains("MB free"), "{err}");
        assert!(!dest.with_extension("part").exists());

        let mut last = 0;
        copy_checked(&mut Cursor::new(&data), &dest, &pin, room, |done, _| last = done).unwrap();
        assert_eq!(last, pin.bytes);
        assert_eq!(fs::read(&dest).unwrap(), data);
        stamp(&dest, &pin, &dir);
        assert_eq!(check_file(&dest, &pin, &dir, |_, _| panic!("read")), Ok(Checked::Stamp));
    }

    #[test]
    fn free_space_is_known_here() {
        assert!(free_bytes(&std::env::temp_dir()).is_some_and(|b| b > 0) || cfg!(not(unix)));
    }
}
