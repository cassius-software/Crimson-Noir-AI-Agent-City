// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the reading half of the app's model (model.rs lends it to the page): which file the
//! installer puts beside the app, how big it must be, and one bounded read of it as base64 text. Nothing here knows
//! Tauri, so it is tried on its own (the tests below) and model.rs stays the commands alone.
//! The file and its size are the page's pin (src/09_Cognition/siteModel.ts APP_MODEL; siteModel.test.ts holds the two
//! to each other). The page checks the SHA-256 itself, on every byte it reads, so a changed file is refused there;
//! here a file of any other size is not the model at all and is never read.
//! What breaks if it is removed? The shell has nothing to read the carried model with, and the page cannot get it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// The model the Windows installer puts beside the app, under `models/` in its resource folder.
pub const FILE: &str = "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf";
/// Its exact size in bytes.
pub const BYTES: u64 = 986_048_768;
/// The most one read gives, bytes (src/07_Execute_Actions/desktopShell.ts APP_READ_BYTES asks for exactly this).
pub const MAX_READ: u64 = 4 * 1024 * 1024;

/// Whether `path` is the model: a file of exactly `bytes`. A missing file, a folder or any other size is not.
pub fn is_model(path: &Path, bytes: u64) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.len() == bytes).unwrap_or(false)
}

/// Up to `len` bytes (1 to MAX_READ) of the file at `path` from `offset`, which must be a file of exactly `bytes`:
/// fewer only where the file ends first, none at its end, an error past it. Every error is a plain sentence.
pub fn read_at(path: &Path, bytes: u64, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    if len == 0 || len > MAX_READ {
        return Err(format!("a read of the app's model takes 1 to {MAX_READ} bytes, not {len}"));
    }
    let mut file = File::open(path).map_err(|e| format!("the app's model is not beside the app ({e})"))?;
    let size = file.metadata().map_err(|e| format!("the app's model could not be read ({e})"))?.len();
    if size != bytes {
        return Err(format!("the app's model is {size} bytes, not the {bytes} it was built with: install the app again"));
    }
    if offset > size {
        return Err(format!("a read at {offset} is past the end of the app's model ({size} bytes)"));
    }
    let want = len.min(size - offset);
    let mut buf = vec![0u8; usize::try_from(want).map_err(|_| "this machine cannot hold one read".to_string())?];
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("the app's model could not be read ({e})"))?;
    file.read_exact(&mut buf).map_err(|e| format!("the app's model could not be read ({e})"))?;
    Ok(buf)
}

/// The same read as base64 text (standard alphabet, padded), the form the page's IPC carries.
pub fn read_text(path: &Path, bytes: u64, offset: u64, len: u64) -> Result<String, String> {
    read_at(path, bytes, offset, len).map(|b| STANDARD.encode(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A file of `n` bytes counting 0, 1, 2, … (mod 251, so no run repeats on a power of two), and its path.
    fn sample(n: usize) -> (tempdir::Dir, std::path::PathBuf, Vec<u8>) {
        let dir = tempdir::Dir::new();
        let path = dir.0.join("model.gguf");
        let data: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
        File::create(&path).unwrap().write_all(&data).unwrap();
        (dir, path, data)
    }

    /// A scratch folder removed when dropped (std alone: no crate for it).
    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                use std::sync::atomic::{AtomicUsize, Ordering};
                static N: AtomicUsize = AtomicUsize::new(0);
                let p = std::env::temp_dir().join(format!("cn-model-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn reads_every_byte_in_order_and_ends_with_an_empty_read() {
        let (_d, path, data) = sample(10_000);
        let mut got = Vec::new();
        let mut offset = 0u64;
        loop {
            let piece = read_at(&path, 10_000, offset, 4096).unwrap();
            if piece.is_empty() {
                break;
            }
            assert!(piece.len() <= 4096);
            offset += piece.len() as u64;
            got.extend_from_slice(&piece);
        }
        assert_eq!(got, data);
        assert_eq!(read_at(&path, 10_000, 10_000, 1).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn refuses_a_read_too_big_or_empty_a_read_past_the_end_and_a_file_of_another_size() {
        let (_d, path, _) = sample(100);
        assert!(read_at(&path, 100, 0, 0).is_err());
        assert!(read_at(&path, 100, 0, MAX_READ + 1).is_err());
        assert!(read_at(&path, 100, 0, MAX_READ).is_ok());
        assert!(read_at(&path, 100, 101, 1).is_err());
        assert!(read_at(&path, 99, 0, 1).unwrap_err().contains("100 bytes, not the 99"));
        assert!(read_at(&path.with_file_name("none.gguf"), 100, 0, 1).is_err());
        assert!(is_model(&path, 100));
        assert!(!is_model(&path, 99));
        assert!(!is_model(path.parent().unwrap(), 100));
    }

    #[test]
    fn the_text_is_standard_padded_base64_of_the_same_bytes() {
        let (_d, path, data) = sample(5);
        assert_eq!(read_text(&path, 5, 0, 5).unwrap(), "AAECAwQ=");
        assert_eq!(read_text(&path, 5, 3, 5).unwrap(), "AwQ=");
        assert_eq!(STANDARD.decode(read_text(&path, 5, 0, 5).unwrap()).unwrap(), data);
    }
}
