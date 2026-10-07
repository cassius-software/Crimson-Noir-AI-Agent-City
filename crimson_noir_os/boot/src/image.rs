//! Why does this file exist? It is the bootable image's life, from the firmware's call to the system's loop: the
//! screen (the Graphics Output Protocol's linear framebuffer), the declared arena taken from the firmware, the clock
//! calibrated against the firmware's stall, the hand-over (ExitBootServices: from then on the machine is the image's
//! alone, interrupts off, its own GDT and IDT), the system's memory allocated as declared and sealed, and the loop
//! that draws frames and reads the keyboard. It also owns the two ways the system stops: the fault screen (a CPU
//! exception, a panic, an allocation the configuration never declared, a failed self-test) and a halt.
//! What breaks if it is removed? The image boots into nothing.

use core::fmt::Write as _;
use core::ptr::null;

use log::{error, info};
use noir_core::config::{self, Dims};
use noir_core::system::{self, System};
use noir_core::text::{self, Target};

use crate::uefi::{self, BootServices, Handle, Status, SystemTable};
use crate::{arch, heap, locked};

// -------------------------------------------------------------------------------------------------------------------
// The log: the serial line

struct SerialLog;

impl log::Log for SerialLog {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, r: &log::Record) {
        let _ = writeln!(arch::Serial, "[{}] {}", r.level(), r.args());
    }
    fn flush(&self) {}
}

static LOGGER: SerialLog = SerialLog;

// -------------------------------------------------------------------------------------------------------------------
// The screen

/// The linear framebuffer the firmware set up, and how its pixels are laid out.
#[derive(Clone, Copy)]
pub struct Screen {
    pub base: *mut u32,
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub format: u32,
    pub masks: [u32; 4],
}

struct Shared<T>(core::cell::UnsafeCell<Option<T>>);
// SAFETY: one CPU, interrupts off; the fault path only reads.
unsafe impl<T> Sync for Shared<T> {}

static SCREEN: Shared<Screen> = Shared(core::cell::UnsafeCell::new(None));

fn screen() -> Option<Screen> {
    // SAFETY: as Shared; set once before the system runs.
    unsafe { *SCREEN.0.get() }
}

/// The firmware's graphics output: the mode nearest 1280×720 that has a linear framebuffer.
fn open_screen(bs: &BootServices) -> Result<Screen, &'static str> {
    let mut gop: *mut uefi::Gop = core::ptr::null_mut();
    let found = (bs.locate_protocol)(&uefi::GOP_GUID, core::ptr::null_mut(), &mut gop as *mut _ as *mut *mut core::ffi::c_void);
    if found != uefi::SUCCESS || gop.is_null() {
        return Err("no graphics output: the system needs a framebuffer");
    }
    // SAFETY: the protocol the firmware returned, valid while boot services run.
    unsafe {
        let g = &mut *gop;
        let max = (*g.mode).max_mode;
        let mut best: Option<(u32, i64)> = None;
        for mode in 0..max {
            let mut size = 0usize;
            let mut info: *mut uefi::ModeInfo = core::ptr::null_mut();
            if (g.query_mode)(gop, mode, &mut size, &mut info) != uefi::SUCCESS || info.is_null() {
                continue;
            }
            let i = &*info;
            if i.pixel_format > uefi::PIXEL_BITMASK || i.horizontal_resolution < 640 || i.vertical_resolution < 360 {
                continue;
            }
            let w = i.horizontal_resolution as i64;
            let h = i.vertical_resolution as i64;
            let score = (w - 1280).abs() + (h - 720).abs() + if w > 1920 || h > 1200 { 10_000 } else { 0 };
            if best.is_none_or(|(_, s)| score < s) {
                best = Some((mode, score));
            }
        }
        if let Some((mode, _)) = best {
            if mode != (*g.mode).mode {
                (g.set_mode)(gop, mode);
            }
        }
        let m = &*g.mode;
        let i = &*m.info;
        if i.pixel_format > uefi::PIXEL_BITMASK || m.frame_buffer_base == 0 {
            return Err("the graphics output has no linear framebuffer");
        }
        Ok(Screen {
            base: m.frame_buffer_base as *mut u32,
            width: i.horizontal_resolution as usize,
            height: i.vertical_resolution as usize,
            stride: i.pixels_per_scan_line as usize,
            format: i.pixel_format,
            masks: i.pixel_information,
        })
    }
}

/// 0x00RRGGBB as the screen's own pixel.
fn native(s: &Screen, rgb: u32) -> u32 {
    let (r, g, b) = ((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
    match s.format {
        uefi::PIXEL_BGR => rgb,
        uefi::PIXEL_RGB => r | (g << 8) | (b << 16),
        _ => {
            let put = |v: u32, mask: u32| if mask == 0 { 0 } else { (v << mask.trailing_zeros()) & mask };
            put(r, s.masks[0]) | put(g, s.masks[1]) | put(b, s.masks[2])
        }
    }
}

/// The framebuffer as a pixel slice.
fn framebuffer(s: &Screen) -> &'static mut [u32] {
    // SAFETY: the firmware mapped stride × height pixels at base, and nothing else in the image touches them.
    unsafe { core::slice::from_raw_parts_mut(s.base, s.stride * s.height) }
}

/// Shows a frame (`w` × `h`, 0x00RRGGBB): scaled by the largest whole factor that fits, centred, black around it.
fn present(s: &Screen, frame: &[u32], w: usize, h: usize) {
    let fb = framebuffer(s);
    let scale = (s.width / w).min(s.height / h).max(1);
    let (ox, oy) = ((s.width.saturating_sub(w * scale)) / 2, (s.height.saturating_sub(h * scale)) / 2);
    for y in 0..h.min(s.height / scale) {
        let src = &frame[y * w..y * w + w];
        for k in 0..scale {
            let row = &mut fb[(oy + y * scale + k) * s.stride..][..s.width];
            for (x, &p) in src.iter().enumerate().take(s.width / scale) {
                let v = native(s, p);
                for j in 0..scale {
                    row[ox + x * scale + j] = v;
                }
            }
        }
    }
}

/// The display self-test: a test card written into the framebuffer's corner and read back, pixel for pixel. Returns the
/// pixels that came back wrong.
fn display_test(s: &Screen) -> usize {
    let fb = framebuffer(s);
    let side = 64.min(s.width).min(s.height);
    let mut wrong = 0;
    for pass in 0..2u32 {
        for y in 0..side {
            for x in 0..side {
                let v = native(s, noir_core::hash::mix32((y * side + x) as u32 ^ pass.wrapping_mul(0x9e37_79b9)) & 0x00ff_ffff);
                // SAFETY: inside the framebuffer; volatile, so the read is the device's answer, not the store's echo.
                unsafe { core::ptr::write_volatile(&mut fb[y * s.stride + x], v) };
            }
        }
        for y in 0..side {
            for x in 0..side {
                let v = native(s, noir_core::hash::mix32((y * side + x) as u32 ^ pass.wrapping_mul(0x9e37_79b9)) & 0x00ff_ffff);
                // SAFETY: as above.
                let got = unsafe { core::ptr::read_volatile(&fb[y * s.stride + x]) };
                wrong += (got & 0x00ff_ffff != v & 0x00ff_ffff) as usize;
            }
        }
    }
    wrong
}

// -------------------------------------------------------------------------------------------------------------------
// Faults

/// A line of text in a fixed buffer (the fault path allocates nothing).
struct Line {
    buf: [u8; 120],
    len: usize,
}

impl Line {
    fn new() -> Self {
        Line { buf: [0; 120], len: 0 }
    }
    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("?")
    }
}

impl core::fmt::Write for Line {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for b in s.bytes() {
            if self.len < self.buf.len() {
                self.buf[self.len] = if b.is_ascii() { b } else { b'?' };
                self.len += 1;
            }
        }
        Ok(())
    }
}

/// The fault screen: what failed, on the screen and the serial line, then a halt. The system does not go on after a
/// hardware fault or a failed self-test.
pub fn fault_screen(title: &str, lines: &[&str]) -> ! {
    arch::cli();
    error!("HARDWARE FAULT: {title}");
    for l in lines {
        error!("  {l}");
    }
    if let Some(s) = screen() {
        let fb = framebuffer(&s);
        let mut t = Target { pixels: fb, width: s.width, height: s.height, stride: s.stride };
        text::fill(&mut t, 0, 0, s.width as i32, s.height as i32, native(&s, 0x1a0006));
        let scale = if s.width >= 1024 { 3 } else { 2 };
        let mut y = 48;
        text::draw(&mut t, 48, y, scale + 1, native(&s, 0xff3b3b), "HARDWARE FAULT");
        y += 12 * (scale + 1);
        text::draw(&mut t, 48, y, scale, native(&s, 0xffd7d7), title);
        y += 14 * scale;
        for l in lines {
            text::draw(&mut t, 48, y, 2, native(&s, 0xe0e0e0), l);
            y += 20;
        }
        text::draw(&mut t, 48, y + 20, 2, native(&s, 0xa08080), "The system has halted. Power it off, or reset it.");
    }
    arch::halt()
}

/// A CPU exception (arch.rs fault_entry).
pub fn cpu_fault(f: &arch::FaultFrame, cr2: u64) -> ! {
    const NAMES: [&str; 32] = [
        "divide error", "debug", "non-maskable interrupt", "breakpoint", "overflow", "bound range", "invalid opcode",
        "device not available", "double fault", "coprocessor overrun", "invalid TSS", "segment not present",
        "stack fault", "general protection fault", "page fault", "reserved", "x87 floating point", "alignment check",
        "machine check", "SIMD floating point", "virtualization", "control protection", "reserved", "reserved",
        "reserved", "reserved", "reserved", "reserved", "hypervisor injection", "VMM communication", "security",
        "reserved",
    ];
    let name = NAMES.get(f.vector as usize).copied().unwrap_or("an interrupt the system never enabled");
    let (mut a, mut b) = (Line::new(), Line::new());
    let _ = write!(a, "vector {} ({name}), error code {:#x}", f.vector, f.error);
    let _ = write!(b, "at rip {:#018x}, rsp {:#018x}, cr2 {:#018x}", f.rip, f.rsp, cr2);
    fault_screen("A CPU exception", &[a.as_str(), b.as_str()])
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    let mut a = Line::new();
    let _ = write!(a, "{}", info.message());
    let mut b = Line::new();
    if let Some(l) = info.location() {
        let _ = write!(b, "at {}:{}", l.file(), l.line());
    }
    let title = if heap::refused() > 0 { "An allocation the configuration never declared" } else { "A panic" };
    fault_screen(title, &[a.as_str(), b.as_str()])
}

// -------------------------------------------------------------------------------------------------------------------
// From the firmware to the system

/// The memory map's buffer: the firmware's map is written here, so taking it allocates nothing.
static mut MAP: [u8; 65536] = [0; 65536];

/// Ends the firmware's boot services (retrying once if the map changed under it). Returns the conventional memory, in
/// bytes, from the final map.
fn exit_boot_services(bs: &BootServices, image: Handle) -> Result<u64, &'static str> {
    let map = &raw mut MAP;
    for _ in 0..3 {
        let mut size = 65536usize;
        let (mut key, mut dsize, mut dver) = (0usize, 0usize, 0u32);
        // The static buffer is the image's own, and nothing else reads it until this returns.
        let got = (bs.get_memory_map)(&mut size, map as *mut u8, &mut key, &mut dsize, &mut dver);
        if got != uefi::SUCCESS || dsize == 0 {
            return Err("the firmware's memory map would not fit 64 KiB");
        }
        if (bs.exit_boot_services)(image, key) == uefi::SUCCESS {
            let mut ram = 0u64;
            for k in 0..size / dsize {
                // SAFETY: k × dsize is inside the map the firmware wrote.
                let d = unsafe { &*((map as *const u8).add(k * dsize) as *const uefi::MemoryDescriptor) };
                if d.ty == uefi::CONVENTIONAL_MEMORY {
                    ram += d.number_of_pages * 4096;
                }
            }
            return Ok(ram);
        }
    }
    Err("the firmware would not hand the machine over (ExitBootServices)")
}

/// The firmware's entry into the image.
#[unsafe(no_mangle)]
pub extern "efiapi" fn efi_main(image: Handle, st: *mut SystemTable) -> Status {
    arch::serial_init();
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    info!("Crimson Noir OS {} ({}), containment {}", locked::VERSION, locked::NAME, locked::DIGEST);
    // SAFETY: the system table the firmware passed; its boot services are valid until they are exited below.
    let bs = unsafe { &*(*st).boot_services };
    // No firmware watchdog: the system runs for as long as the machine is on.
    (bs.set_watchdog_timer)(0, 0, 0, null());
    let s = match open_screen(bs) {
        Ok(s) => s,
        Err(why) => {
            uefi::print(st, why);
            error!("{why}");
            return uefi::UNSUPPORTED;
        }
    };
    info!("screen: {}x{} pixels, {} a row, pixel format {}", s.width, s.height, s.stride, s.format);
    // The declared arena, and nothing more.
    let d: Dims = locked::DIMS;
    let mut arena = 0u64;
    if (bs.allocate_pages)(uefi::ALLOCATE_ANY_PAGES, uefi::LOADER_DATA, d.arena_bytes / 4096, &mut arena) != uefi::SUCCESS {
        uefi::print(st, "the firmware would not give the declared memory (memory.arenaBytes)");
        return uefi::OUT_OF_RESOURCES;
    }
    // The clock: 50 ms of the firmware's stall against the time-stamp counter.
    let t0 = arch::rdtsc();
    (bs.stall)(50_000);
    let tsc_per_us = ((arch::rdtsc() - t0) / 50_000).max(1);
    let ram = match exit_boot_services(bs, image) {
        Ok(ram) => ram,
        Err(why) => {
            uefi::print(st, why);
            return uefi::UNSUPPORTED;
        }
    };
    // The machine is the image's alone from here.
    arch::cli();
    // SAFETY: interrupts are off; the GDT is loaded before the IDT that names its code segment.
    unsafe {
        arch::load_gdt();
        arch::load_idt();
    }
    // SAFETY: as Shared; nothing reads it yet.
    unsafe { *SCREEN.0.get() = Some(s) };
    info!("boot services exited: {} MiB of free RAM, the image's own GDT and IDT, TSC at {} MHz", ram >> 20, tsc_per_us);
    run(s, arena as usize, d, tsc_per_us)
}

/// Writes and reads back every word of [start, end) twice (an address-dependent pattern, then its complement). Returns
/// the words that came back wrong.
fn march(start: usize, end: usize) -> usize {
    let words = (end - start) / 4;
    let p = start as *mut u32;
    let mut wrong = 0;
    for pass in 0..2u32 {
        let flip = 0u32.wrapping_sub(pass);
        for i in 0..words {
            // SAFETY: [start, end) is the arena the firmware gave the image, and nothing lives in it yet.
            unsafe { core::ptr::write_volatile(p.add(i), noir_core::hash::mix32(i as u32) ^ flip) };
        }
        for i in 0..words {
            // SAFETY: as above.
            let got = unsafe { core::ptr::read_volatile(p.add(i)) };
            wrong += (got != noir_core::hash::mix32(i as u32) ^ flip) as usize;
        }
    }
    wrong
}

fn run(s: Screen, arena: usize, d: Dims, tsc_per_us: u64) -> ! {
    // Memory, before anything lives in it.
    let t = arch::rdtsc();
    let wrong = march(arena, arena + d.arena_bytes);
    info!("memory: {} bytes written and read back twice, {} wrong, in {} ms", d.arena_bytes, wrong, (arch::rdtsc() - t) / tsc_per_us / 1000);
    if wrong > 0 {
        fault_screen("Memory does not hold what was written to it", &["the arena failed its write-and-read-back test"]);
    }
    heap::init(arena, d.arena_bytes);
    let mut sys: System = system::allocate(&d);
    heap::seal();
    let declared = config::declared_bytes(&d);
    info!("memory: {} bytes declared, {} allocated, the allocator sealed", declared, heap::used());
    if heap::used() != declared {
        fault_screen("Memory was not allocated as declared", &["the layout and the allocations differ"]);
    }
    // Compute: the self-test's scripted run, against the fingerprint the build computed.
    let t = arch::rdtsc();
    let p = noir_core::matrix::golden(&d, &locked::ROLE_COUNTS, &locked::ROLE_CAPS, &mut sys.m);
    info!(
        "compute: {} ticks of {} agents in {} ms, fingerprint {:#010x} (built {:#010x})",
        p.tick,
        d.capacity,
        (arch::rdtsc() - t) / tsc_per_us / 1000,
        p.fingerprint,
        locked::GOLDEN
    );
    if p != locked::GOLDEN_PROOF {
        fault_screen("The compute kernels disagree with the build", &["the scripted run's fingerprint differs"]);
    }
    // Display: a test card read back.
    let wrong = display_test(&s);
    info!("display: test card read back, {} pixels wrong", wrong);
    if wrong > 0 {
        fault_screen("The display does not show what was drawn", &["the framebuffer's test card read back wrong"]);
    }
    info!("SELFTEST PASS");
    // A first screen until the tutorial runs: what the checks found, and the keyboard echoed.
    let (w, h) = (d.display_width, d.display_height);
    let mut typed = [0u8; 64];
    let mut n = 0usize;
    let mut kb = arch::Keyboard { shift: false, caps: false, extended: false };
    loop {
        {
            let mut t = Target { pixels: &mut sys.b.color, width: w, height: h, stride: w };
            text::fill(&mut t, 0, 0, w as i32, h as i32, 0x0b0b10);
            text::draw(&mut t, 24, 24, 2, 0xe0283c, "CRIMSON NOIR OS");
            text::draw(&mut t, 24, 52, 1, 0xd0d0d0, "memory, compute, containment and display checked");
            let mut l = Line::new();
            let _ = write!(l, "fingerprint {:#010x}, as built", p.fingerprint);
            text::draw(&mut t, 24, 68, 1, 0xd0d0d0, l.as_str());
            text::draw(&mut t, 24, 92, 1, 0x909090, "type:");
            text::draw(&mut t, 72, 92, 1, 0xffffff, core::str::from_utf8(&typed[..n]).unwrap_or(""));
        }
        present(&s, &sys.b.color, w, h);
        while let Some(sc) = arch::ps2_byte() {
            if let Some(k) = arch::key(&mut kb, sc) {
                if k == 8 {
                    n = n.saturating_sub(1);
                } else if (32..127).contains(&k) && n < typed.len() {
                    typed[n] = k as u8;
                    n += 1;
                }
                info!("key {k:#x}");
            }
        }
    }
}
