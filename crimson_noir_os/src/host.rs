//! Why does this file exist? It is what a desktop gives the system in place of the bare machine. A global allocator
//! that counts what the system allocates (rounded as the image's arena rounds it, so the count can be held against
//! config::declared_bytes) and can be sealed for the calling thread, so the tutorial's and the terminal's frames run
//! under the same rule as on the image: an allocation there is refused, and a refused allocation stops the program.
//! The tutorial's platform: a live march over host memory the size of the image's free arena, a framebuffer to read
//! back, and the seal probe. And a PNG writer (stored deflate blocks, no compression library), for the frames.
//! What breaks if it is removed? The hosted runtime could not show that the tutorial and the terminal allocate nothing,
//! and could not write frames.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use noir_core::config::ALLOC_ALIGN;
use noir_core::hash::mix32;
use noir_core::tutorial::{March, Platform};

pub struct Sealable;

thread_local! {
    static SEALED: Cell<bool> = const { Cell::new(false) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
    static REFUSED: Cell<usize> = const { Cell::new(0) };
}

fn admit(size: usize) -> bool {
    if SEALED.with(Cell::get) {
        REFUSED.with(|r| r.set(r.get() + 1));
        return false;
    }
    BYTES.with(|b| b.set(b.get() + size.div_ceil(ALLOC_ALIGN) * ALLOC_ALIGN));
    true
}

// SAFETY: every admitted call goes to the system allocator unchanged; a refused one returns null, which GlobalAlloc
// allows. The bookkeeping is thread-local integers, which never allocate.
unsafe impl GlobalAlloc for Sealable {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if !admit(l.size()) {
            return std::ptr::null_mut();
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        if !admit(l.size()) {
            return std::ptr::null_mut();
        }
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        if !admit(size) {
            return std::ptr::null_mut();
        }
        unsafe { System.realloc(p, l, size) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

/// Seals (or unseals) the allocator for this thread.
pub fn seal(on: bool) {
    SEALED.with(|s| s.set(on));
}

/// Bytes this thread has allocated (each rounded up to ALLOC_ALIGN, as the image's arena carves them).
pub fn allocated() -> usize {
    BYTES.with(Cell::get)
}

/// Allocations refused on this thread.
pub fn refused() -> usize {
    REFUSED.with(Cell::get)
}

/// Asks the sealed allocator for 64 bytes: true when it refuses. The call goes to the allocator itself, not through
/// `std::alloc::alloc`, whose result the optimizer may assume (an allocation nobody uses can be elided as a success).
pub fn probe() -> bool {
    let before = refused();
    let was = SEALED.with(Cell::get);
    seal(true);
    let layout = Layout::from_size_align(64, 64).expect("a valid layout");
    // SAFETY: a valid, non-zero layout; were a pointer returned it would be freed at once.
    let p = std::hint::black_box(unsafe { Sealable.alloc(layout) });
    seal(was);
    if !p.is_null() {
        // SAFETY: allocated just above with this layout.
        unsafe { Sealable.dealloc(p, layout) };
        return false;
    }
    refused() == before + 1
}

/// Runs `f` with this thread's allocator sealed.
pub fn sealed<T>(f: impl FnOnce() -> T) -> T {
    seal(true);
    let out = f();
    seal(false);
    out
}

/// The tutorial's platform on a desktop.
pub struct Host {
    /// Memory standing in for the image's free arena, marched live.
    pub arena: Vec<u32>,
    pub at: usize,
    pub wrong: usize,
    /// A framebuffer standing in for the screen.
    pub screen: Vec<u32>,
}

impl Host {
    pub fn new(free_bytes: usize, screen_pixels: usize) -> Host {
        Host { arena: vec![0; free_bytes / 4], at: 0, wrong: 0, screen: vec![0; screen_pixels] }
    }
}

/// Writes an address-dependent pattern and its complement over `words`, reading each back; the words that came back
/// wrong (the image's march, on host memory).
pub fn march(words: &mut [u32]) -> usize {
    let mut wrong = 0;
    for pass in 0..2u32 {
        let flip = 0u32.wrapping_sub(pass);
        for (i, w) in words.iter_mut().enumerate() {
            // SAFETY: a valid, aligned element of the slice; volatile, so the read is the memory's answer.
            unsafe { std::ptr::write_volatile(w, mix32(i as u32) ^ flip) };
        }
        for (i, w) in words.iter().enumerate() {
            // SAFETY: as above.
            let got = unsafe { std::ptr::read_volatile(w) };
            wrong += (got != mix32(i as u32) ^ flip) as usize;
        }
    }
    wrong
}

impl Platform for Host {
    fn march(&mut self, bytes: usize) -> March {
        let n = (self.arena.len() - self.at).min(bytes / 4);
        self.wrong += march(&mut self.arena[self.at..self.at + n]);
        self.at += n;
        March { done: self.at * 4, total: self.arena.len() * 4, wrong: self.wrong }
    }

    fn display_test(&mut self) -> (usize, usize) {
        // The image's test: a 64 x 64 card, two patterns, written and read back.
        let side = 64.min(self.screen.len());
        let mut wrong = 0;
        for pass in 0..2u32 {
            for i in 0..side * side {
                let v = mix32(i as u32 ^ pass.wrapping_mul(0x9e37_79b9)) & 0x00ff_ffff;
                // SAFETY: inside the framebuffer.
                unsafe { std::ptr::write_volatile(&mut self.screen[i], v) };
            }
            for i in 0..side * side {
                let v = mix32(i as u32 ^ pass.wrapping_mul(0x9e37_79b9)) & 0x00ff_ffff;
                // SAFETY: as above.
                wrong += (unsafe { std::ptr::read_volatile(&self.screen[i]) } != v) as usize;
            }
        }
        (side * side * 2, wrong)
    }

    fn seal_holds(&mut self) -> bool {
        probe()
    }
}

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
};

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for p in parts {
        for &b in *p {
            c = CRC_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
        }
    }
    c ^ 0xffff_ffff
}

/// A PNG of `w` x `h` pixels (0x00RRGGBB), each scaled up `scale` times: RGB, 8 bits, zlib with stored blocks.
pub fn png(pixels: &[u32], w: usize, h: usize, scale: usize) -> Vec<u8> {
    let (ow, oh) = (w * scale, h * scale);
    let mut raw = Vec::with_capacity((ow * 3 + 1) * oh);
    for y in 0..oh {
        raw.push(0);
        for x in 0..ow {
            let p = pixels[(y / scale) * w + x / scale];
            raw.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8]);
        }
    }
    let mut z = vec![0x78, 0x01];
    let chunks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (k, c) in chunks.iter().enumerate() {
        z.push((k + 1 == chunks.len()) as u8);
        z.extend_from_slice(&(c.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(c.len() as u16)).to_le_bytes());
        z.extend_from_slice(c);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |kind: &[u8], body: &[u8]| {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out.extend_from_slice(&crc32(&[kind, body]).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(ow as u32).to_be_bytes());
    ihdr.extend_from_slice(&(oh as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_png_checksums_are_the_standard_ones() {
        // CRC-32 of "123456789" is 0xcbf43926 (the standard check value).
        assert_eq!(crc32(&[b"1234", b"56789"]), 0xcbf4_3926);
        let img = png(&[0xff0000, 0x00ff00, 0x0000ff, 0xffffff], 2, 2, 2);
        assert_eq!(&img[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&img[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(img[16..20].try_into().unwrap()), 4);
    }

    #[test]
    fn a_sealed_thread_is_refused_and_an_unsealed_one_is_not() {
        let before = refused();
        let reserve = || std::hint::black_box(Vec::<u8>::new()).try_reserve(32).is_ok();
        let v = sealed(reserve);
        assert!(!v && refused() == before + 1, "a sealed thread's allocation is refused");
        assert!(probe(), "the probe sees the seal");
        assert!(reserve(), "unsealed again");
        let mut h = Host::new(4096, 64 * 64);
        assert!(h.seal_holds());
        assert_eq!(h.display_test(), (8192, 0));
        let m = h.march(usize::MAX);
        assert_eq!((m.done, m.total, m.wrong), (4096, 4096, 0));
        let _ = Vec::<u8>::with_capacity(16);
    }
}
