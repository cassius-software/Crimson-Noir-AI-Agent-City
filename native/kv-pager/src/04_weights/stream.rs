// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04b: reading units of weights from the disk, sector-aligned, ahead of the code that uses them.
//!
//! Why does this file exist? A model larger than memory runs only if its weights arrive from the SSD as fast as the
//! drive allows and while the previous unit is being computed. This file does the disk side of that:
//! - `ReadPlan` turns a unit's extents (gguf.rs) into reads whose offsets and lengths are multiples of the 4,096-byte
//!   sector, merging neighbours, and says where each extent's exact bytes land in the buffer;
//! - `SectorFile` opens the file unbuffered where the system allows it (O_DIRECT on Linux and Android,
//!   FILE_FLAG_NO_BUFFERING on Windows), so a model streamed through RAM does not also evict everything else from the
//!   page cache, and falls back to ordinary reads where it does not (macOS, tmpfs, other systems);
//! - `Streamer` is the ring: a reader thread fills a fixed set of aligned buffers (two is double buffering) with the
//!   units requested, in order, splitting a unit's reads over several file handles so the drive sees a queue, and hands
//!   each back as a `Staged` whose drop returns its buffer. While the caller works on unit L, unit L+1 is being read;
//!   with every buffer full, the reader waits, so memory stays bounded however far ahead the caller asks. A caller that
//!   holds every buffer and asks for another unit is refused (`WouldBlock`) rather than left waiting for a drop that,
//!   from its own thread, would never come.
//!
//! The buffers are ordinary aligned heap memory, not page-locked: wgpu offers no pinned host memory, and nothing in this
//! crate runs a model's layers yet, so the GPU upload side is not built here.
//! What breaks if it is removed? The swarm planner (swarm.rs) plans reads nothing performs, and the `stream` run has
//! nothing to measure.

use super::gguf::Extent;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The alignment of every unbuffered read: the 4 KiB sector of current SSDs, which also satisfies 512-byte sectors.
pub const SECTOR: u64 = 4096;
/// A merged span is split into reads of at most this, so a unit's reads can be in flight together.
pub const MAX_READ: u64 = 8 << 20;

/// Memory whose start and length are multiples of `SECTOR`, as unbuffered reads demand. Safe code: an over-sized
/// vector and the aligned window inside it.
pub struct AlignedBuf {
    raw: Vec<u8>,
    start: usize,
    len: usize,
}

impl AlignedBuf {
    /// At least `len` zeroed bytes, rounded up to a whole sector.
    pub fn new(len: usize) -> Self {
        let sector = SECTOR as usize;
        let len = len.next_multiple_of(sector);
        let raw = vec![0u8; len + sector];
        let start = (raw.as_ptr() as usize).wrapping_neg() & (sector - 1);
        AlignedBuf { raw, start, len }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.raw[self.start..self.start + self.len]
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.raw[self.start..self.start + self.len]
    }
}

/// One read: `len` bytes from file offset `offset` into the unit's buffer at `at`. All three are sector multiples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadOp {
    pub offset: u64,
    pub len: u64,
    pub at: u64,
}

/// Where a requested extent's exact bytes sit in the unit's buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub at: u64,
    pub len: u64,
}

/// The reads that fetch a set of extents, and where each extent lands.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReadPlan {
    /// Sorted by file offset; consecutive in the buffer.
    pub reads: Vec<ReadOp>,
    /// One per requested extent, in the order requested.
    pub placements: Vec<Placement>,
    /// Discontiguous regions of the file the reads cover (each costs the drive a fresh request).
    pub spans: usize,
    /// Bytes the extents asked for.
    pub useful: u64,
}

impl ReadPlan {
    /// Plans `extents`: each widened to whole sectors, neighbours merged when the gap between them is at most
    /// `merge_gap` bytes (reading a small gap is cheaper than a second request), spans cut into reads of at most
    /// `MAX_READ`.
    pub fn new(extents: &[Extent], merge_gap: u64) -> Self {
        let mut order: Vec<usize> = (0..extents.len()).filter(|&i| extents[i].len > 0).collect();
        order.sort_by_key(|&i| (extents[i].offset, extents[i].len));
        // Merged spans as (start, end) in the file, and which span each extent fell in.
        let mut spans: Vec<(u64, u64)> = Vec::new();
        let mut span_of = vec![usize::MAX; extents.len()];
        for &i in &order {
            let lo = extents[i].offset / SECTOR * SECTOR;
            let hi = extents[i].end().next_multiple_of(SECTOR);
            match spans.last_mut() {
                Some(last) if lo <= last.1.saturating_add(merge_gap) => last.1 = last.1.max(hi),
                _ => spans.push((lo, hi)),
            }
            span_of[i] = spans.len() - 1;
        }
        let mut reads = Vec::new();
        let mut span_at = Vec::with_capacity(spans.len());
        let mut at = 0;
        for &(lo, hi) in &spans {
            span_at.push(at);
            let mut off = lo;
            while off < hi {
                let len = (hi - off).min(MAX_READ);
                reads.push(ReadOp { offset: off, len, at });
                off += len;
                at += len;
            }
        }
        let placements = extents
            .iter()
            .enumerate()
            .map(|(i, e)| match span_of[i] {
                usize::MAX => Placement { at: 0, len: 0 },
                s => Placement { at: span_at[s] + (e.offset - spans[s].0), len: e.len },
            })
            .collect();
        ReadPlan { reads, placements, spans: spans.len(), useful: extents.iter().map(|e| e.len).sum() }
    }

    /// Bytes the reads cover (what the drive transfers).
    pub fn read_bytes(&self) -> u64 {
        self.reads.iter().map(|r| r.len).sum()
    }

    /// The buffer a unit with this plan needs.
    pub fn buffer_len(&self) -> u64 {
        self.reads.last().map_or(0, |r| r.at + r.len)
    }
}

/// How a file is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoMode {
    /// Around the page cache: O_DIRECT (Linux, Android) or FILE_FLAG_NO_BUFFERING (Windows).
    Direct,
    /// Through the page cache.
    Buffered,
}

impl IoMode {
    /// Direct when the model is larger than the memory the OS could cache it in (the cache would only thrash and push
    /// everything else out), buffered when it fits (the cache then keeps the whole model after one pass, for free).
    pub fn for_model(model_bytes: u64, cache_budget_bytes: u64) -> IoMode {
        if model_bytes > cache_budget_bytes {
            IoMode::Direct
        } else {
            IoMode::Buffered
        }
    }
}

/// The O_DIRECT flag of this target, where it is known.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn o_direct() -> Option<i32> {
    if cfg!(any(target_arch = "x86", target_arch = "x86_64", target_arch = "riscv64", target_arch = "loongarch64", target_arch = "s390x")) {
        Some(0o40000)
    } else if cfg!(any(target_arch = "arm", target_arch = "aarch64")) {
        Some(0o200000)
    } else {
        None
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn open_direct(path: &Path) -> Option<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().read(true).custom_flags(o_direct()?).open(path).ok()
}

#[cfg(windows)]
fn open_direct(path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    /// winbase.h FILE_FLAG_NO_BUFFERING.
    const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
    OpenOptions::new().read(true).custom_flags(FILE_FLAG_NO_BUFFERING).open(path).ok()
}

#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
fn open_direct(_path: &Path) -> Option<File> {
    None
}

#[cfg(unix)]
fn pread(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

#[cfg(windows)]
fn pread(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

#[cfg(not(any(unix, windows)))]
fn pread(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = file;
    f.seek(SeekFrom::Start(offset))?;
    f.read(buf)
}

/// A file opened for positioned, sector-aligned reads.
pub struct SectorFile {
    file: File,
    path: PathBuf,
    mode: IoMode,
    len: u64,
}

impl SectorFile {
    /// Opens `path` as `want` asks, or buffered where unbuffered reads are not available.
    pub fn open(path: &Path, want: IoMode) -> io::Result<Self> {
        let direct = if want == IoMode::Direct { open_direct(path) } else { None };
        let (file, mode) = match direct {
            Some(f) => (f, IoMode::Direct),
            None => (File::open(path)?, IoMode::Buffered),
        };
        let len = file.metadata()?.len();
        Ok(SectorFile { file, path: path.to_path_buf(), mode, len })
    }

    pub fn mode(&self) -> IoMode {
        self.mode
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Fills `buf` from `offset`; short only where the file ends. In direct mode `offset`, the address of `buf` and its
    /// length are sector multiples (a `ReadPlan` into an `AlignedBuf` always is). A file system that refuses an
    /// unbuffered read (EINVAL) is reopened buffered and the read retried, once.
    pub fn read_full(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
        let mut done = 0;
        while done < buf.len() {
            match pread(&self.file, &mut buf[done..], offset + done as u64) {
                Ok(0) => break,
                Ok(n) => {
                    done += n;
                    // A short read that reached the end of the file: asking again would be an unaligned read on an
                    // unbuffered handle (Windows refuses it, which would turn the handle buffered for good).
                    if offset + done as u64 >= self.len {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if self.mode == IoMode::Direct && e.kind() == io::ErrorKind::InvalidInput => {
                    self.file = File::open(&self.path)?;
                    self.mode = IoMode::Buffered;
                }
                Err(e) => return Err(e),
            }
        }
        if done < buf.len() && offset + (done as u64) < self.len {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("{} ended at {} reading {} bytes at {offset}", self.path.display(), offset + done as u64, buf.len()),
            ));
        }
        Ok(done)
    }
}

/// How a `Streamer` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamConfig {
    pub mode: IoMode,
    /// Buffers in the ring (2 = double buffering: one being read while the caller holds the other).
    pub depth: usize,
    /// File handles a unit's reads are spread over.
    pub threads: usize,
    /// Gaps up to this many bytes between extents are read through rather than split into two requests.
    pub merge_gap: u64,
}

impl Default for StreamConfig {
    fn default() -> Self {
        StreamConfig { mode: IoMode::Direct, depth: 2, threads: 4, merge_gap: 64 << 10 }
    }
}

/// One requested unit, read. Its extents' exact bytes are `extent(i)`; dropping it returns its buffer to the ring.
pub struct Staged {
    /// The ticket `Streamer::request` gave.
    pub ticket: u64,
    /// Bytes transferred and time taken by the reads.
    pub read_bytes: u64,
    pub read_time: Duration,
    plan: ReadPlan,
    buf: Option<AlignedBuf>,
    back: Sender<AlignedBuf>,
    /// The ring's count of units handed to the caller and not yet dropped.
    held: Arc<AtomicUsize>,
    /// Whether `next_unit` handed it to the caller (counted in `held`).
    handed: bool,
}

impl Staged {
    pub fn extents(&self) -> usize {
        self.plan.placements.len()
    }

    /// The `i`-th requested extent's bytes.
    pub fn extent(&self, i: usize) -> &[u8] {
        let p = self.plan.placements[i];
        &self.buf.as_ref().expect("held until drop").as_slice()[p.at as usize..(p.at + p.len) as usize]
    }
}

impl std::fmt::Debug for Staged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Staged")
            .field("ticket", &self.ticket)
            .field("extents", &self.extents())
            .field("read_bytes", &self.read_bytes)
            .field("read_time", &self.read_time)
            .finish_non_exhaustive()
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(b) = self.buf.take() {
            // The buffer is back in the ring before the count says so, so a caller that sees a free slot finds it.
            let _ = self.back.send(b);
            if self.handed {
                self.held.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}

struct Request {
    ticket: u64,
    plan: ReadPlan,
}

/// The ring: requested units are read in order by a reader thread into `depth` reusable aligned buffers.
pub struct Streamer {
    requests: Option<Sender<Request>>,
    ready: Option<Receiver<io::Result<Staged>>>,
    reader: Option<JoinHandle<()>>,
    held: Arc<AtomicUsize>,
    depth: usize,
    stop: Arc<AtomicBool>,
    read: Arc<AtomicU64>,
    mode: IoMode,
    file_len: u64,
    merge_gap: u64,
    next_ticket: u64,
    pending: usize,
}

impl Streamer {
    /// Opens `path` once per thread and starts the reader. Fails if the file cannot be opened at all.
    pub fn open(path: &Path, cfg: StreamConfig) -> io::Result<Self> {
        let threads = cfg.threads.max(1);
        let depth = cfg.depth.max(1);
        let mut files = Vec::with_capacity(threads);
        for _ in 0..threads {
            files.push(SectorFile::open(path, cfg.mode)?);
        }
        let mode = files[0].mode();
        let file_len = files[0].len();
        let (req_tx, req_rx) = channel::<Request>();
        let (ready_tx, ready_rx) = sync_channel::<io::Result<Staged>>(depth);
        let (free_tx, free_rx) = channel::<AlignedBuf>();
        for _ in 0..depth {
            free_tx.send(AlignedBuf::new(0)).expect("the receiver is here");
        }
        let stop = Arc::new(AtomicBool::new(false));
        let read = Arc::new(AtomicU64::new(0));
        let held = Arc::new(AtomicUsize::new(0));
        let ring = Ring { ready: ready_tx, free_tx, free_rx, stop: Arc::clone(&stop), read: Arc::clone(&read), held: Arc::clone(&held) };
        let reader = thread::Builder::new().name("weights-reader".into()).spawn(move || reader_loop(files, req_rx, ring))?;
        Ok(Streamer {
            requests: Some(req_tx),
            ready: Some(ready_rx),
            reader: Some(reader),
            held,
            depth,
            stop,
            read,
            mode,
            file_len,
            merge_gap: cfg.merge_gap,
            next_ticket: 0,
            pending: 0,
        })
    }

    /// The mode the file actually opened in (direct may have fallen back to buffered).
    pub fn mode(&self) -> IoMode {
        self.mode
    }

    /// Units requested and not yet taken with `next_unit`.
    pub fn pending(&self) -> usize {
        self.pending
    }

    /// Units the reader has finished reading so far (taken or not).
    pub fn units_read(&self) -> u64 {
        self.read.load(Ordering::Acquire)
    }

    /// Queues a unit (its extents) for reading and returns its ticket. Units arrive from `next_unit` in request order.
    pub fn request(&mut self, extents: &[Extent]) -> io::Result<u64> {
        if let Some(e) = extents.iter().find(|e| e.offset.checked_add(e.len).is_none_or(|end| end > self.file_len)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} bytes at {} are outside the {}-byte file", e.len, e.offset, self.file_len),
            ));
        }
        let ticket = self.next_ticket;
        let plan = ReadPlan::new(extents, self.merge_gap);
        let sent = self.requests.as_ref().map(|tx| tx.send(Request { ticket, plan }));
        if !matches!(sent, Some(Ok(()))) {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the reader has stopped"));
        }
        self.next_ticket += 1;
        self.pending += 1;
        Ok(ticket)
    }

    /// Units taken with `next_unit` and not yet dropped (on any thread).
    pub fn held(&self) -> usize {
        self.held.load(Ordering::Acquire)
    }

    /// The oldest requested unit, waiting for its reads; None when nothing is pending. While the caller holds every
    /// buffer of the ring (`depth` units taken and not dropped) the reader can read nothing more, so instead of a wait
    /// that from the holder's own thread would never end, this returns `WouldBlock` and the unit stays pending: drop a
    /// unit (or let the thread holding it drop it) and ask again. Not an `Iterator`, so that `collect` cannot hold every
    /// buffer and loop on the refusals.
    pub fn next_unit(&mut self) -> Option<io::Result<Staged>> {
        if self.pending == 0 {
            return None;
        }
        // `held` only falls behind `next_unit`'s back (a drop sends its buffer back before it counts down), so below
        // `depth` a buffer is free, being filled or ready, and the wait below ends.
        if self.held.load(Ordering::Acquire) >= self.depth {
            return Some(Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("all {} buffers of the ring are held: drop a unit before taking another", self.depth),
            )));
        }
        self.pending -= 1;
        let got = self.ready.as_ref().and_then(|r| r.recv().ok());
        Some(match got {
            Some(Ok(mut unit)) => {
                unit.handed = true;
                self.held.fetch_add(1, Ordering::AcqRel);
                Ok(unit)
            }
            Some(Err(e)) => Err(e),
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "the reader has stopped")),
        })
    }
}

impl Drop for Streamer {
    fn drop(&mut self) {
        // The reader stops at its next wait: a free buffer (the stop flag), a request (the closed queue) or a hand-over
        // (the closed ready channel), so this join returns even while the caller still holds a unit.
        self.stop.store(true, Ordering::Release);
        self.requests = None;
        self.ready = None;
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
    }
}

/// The reader's ends of the ring's channels.
struct Ring {
    ready: SyncSender<io::Result<Staged>>,
    free_tx: Sender<AlignedBuf>,
    free_rx: Receiver<AlignedBuf>,
    stop: Arc<AtomicBool>,
    read: Arc<AtomicU64>,
    held: Arc<AtomicUsize>,
}

fn reader_loop(mut files: Vec<SectorFile>, requests: Receiver<Request>, ring: Ring) {
    let Ring { ready, free_tx, free_rx, stop, read, held } = ring;
    while let Ok(Request { ticket, plan }) = requests.recv() {
        if stop.load(Ordering::Acquire) {
            return;
        }
        // A free buffer, waiting while the caller holds every one (that wait is what bounds the read-ahead).
        let mut buf = loop {
            match free_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(b) => break b,
                Err(RecvTimeoutError::Timeout) if !stop.load(Ordering::Acquire) => {}
                Err(_) => return,
            }
        };
        let need = plan.buffer_len() as usize;
        if buf.len() < need {
            buf = AlignedBuf::new(need);
        }
        let started = Instant::now();
        let result = read_plan(&mut files, &plan, &mut buf);
        read.fetch_add(1, Ordering::AcqRel);
        let staged = match result {
            Ok(read_bytes) => Ok(Staged {
                ticket,
                read_bytes,
                read_time: started.elapsed(),
                plan,
                buf: Some(buf),
                back: free_tx.clone(),
                held: Arc::clone(&held),
                handed: false,
            }),
            Err(e) => {
                let _ = free_tx.send(buf);
                Err(e)
            }
        };
        if ready.send(staged).is_err() {
            return;
        }
    }
}

/// Performs a plan's reads into `buf`, spread round-robin over the file handles when there is more than one read.
fn read_plan(files: &mut [SectorFile], plan: &ReadPlan, buf: &mut AlignedBuf) -> io::Result<u64> {
    let mut jobs: Vec<(u64, &mut [u8])> = Vec::with_capacity(plan.reads.len());
    let mut rest = &mut buf.as_mut_slice()[..plan.buffer_len() as usize];
    for r in &plan.reads {
        let (head, tail) = rest.split_at_mut(r.len as usize);
        jobs.push((r.offset, head));
        rest = tail;
    }
    if jobs.len() <= 1 || files.len() == 1 {
        let f = &mut files[0];
        let mut total = 0;
        for (offset, dst) in jobs {
            total += f.read_full(offset, dst)? as u64;
        }
        return Ok(total);
    }
    let lanes = files.len();
    let mut per_lane: Vec<Vec<(u64, &mut [u8])>> = (0..lanes).map(|_| Vec::new()).collect();
    for (i, job) in jobs.into_iter().enumerate() {
        per_lane[i % lanes].push(job);
    }
    thread::scope(|s| {
        let handles: Vec<_> = files
            .iter_mut()
            .zip(per_lane)
            .filter(|(_, lane)| !lane.is_empty())
            .map(|(f, lane)| {
                s.spawn(move || -> io::Result<u64> {
                    let mut total = 0;
                    for (offset, dst) in lane {
                        total += f.read_full(offset, dst)? as u64;
                    }
                    Ok(total)
                })
            })
            .collect();
        let mut total = 0;
        for h in handles {
            total += h.join().map_err(|_| io::Error::other("a read thread panicked"))??;
        }
        Ok(total)
    })
}
