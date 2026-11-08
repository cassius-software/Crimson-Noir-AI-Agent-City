// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is what the bootable image does to an aarch64 machine itself once the firmware has let go
//! (arch.rs names what every architecture provides): the serial line the log is written to and the keys are read from
//! (the UART the firmware's ACPI SPCR table names, a PL011 or an SBSA generic UART; a test harness reads the log and
//! types into it); the generic timer's virtual count, the only clock it needs; and its own exception vectors (VBAR_EL1,
//! or VBAR_EL2 where the firmware runs at EL2), so every synchronous exception, interrupt and SError lands in
//! `fault_entry` and the fault screen instead of the firmware's handler on memory that is no longer reserved. Interrupts
//! stay masked (DAIF): the system polls, so no device can preempt the hot path. An Arm machine has no PS/2 controller and
//! the image has no USB stack, so the keyboard is the serial console: plain bytes, and a terminal's escape sequences for
//! the arrows and the page keys.
//! What breaks if it is removed? The image does not build for aarch64-unknown-uefi: after ExitBootServices it would
//! have no log, no clock, no keys, and no way to catch a hardware fault.

use core::arch::{asm, global_asm};
use core::fmt::Write;
use core::ptr::{read_unaligned, read_volatile, write_volatile};

use noir_core::system::{KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_LEFT, KEY_PAGE_DOWN, KEY_PAGE_UP, KEY_RIGHT, KEY_UP};

use crate::uefi::{self, SystemTable};

// -------------------------------------------------------------------------------------------------------------------
// The serial line: the UART the firmware's SPCR table names

/// Where the UART's registers are (0 until serial_init finds one: then the log goes nowhere and no key arrives).
struct Uart(core::cell::UnsafeCell<usize>);
// SAFETY: one CPU, interrupts off; written once in serial_init, before anything reads it.
unsafe impl Sync for Uart {}
static UART: Uart = Uart(core::cell::UnsafeCell::new(0));

fn uart() -> usize {
    // SAFETY: as Uart.
    unsafe { *UART.0.get() }
}

/// The data register and the flag register (PL011 and SBSA generic UART alike, both 32-bit accessible).
const DR: usize = 0x00;
const FR: usize = 0x18;
/// FR: the transmit FIFO is full; the receive FIFO is empty.
const TXFF: u32 = 1 << 5;
const RXFE: u32 = 1 << 4;

/// SPCR interface types the image can drive: an Arm PL011, the SBSA 2.x subset, the SBSA generic UART.
const PL011_TYPES: [u8; 3] = [0x03, 0x0d, 0x0e];

/// The UART's base address from the ACPI tables the firmware publishes: RSDP (ACPI 2.0, from the configuration
/// table) to XSDT to SPCR, whose generic address must be in system memory and whose interface a PL011's registers
/// drive. None where any link is missing: the image then writes to no address it was not told about.
///
/// # Safety
/// `st` is the firmware's system table and boot services are running (the tables it names are mapped).
unsafe fn spcr_uart(st: *const SystemTable) -> Option<usize> {
    unsafe {
        let rsdp = uefi::configuration_table(st, &uefi::ACPI_20_GUID)? as *const u8;
        if read_unaligned(rsdp as *const [u8; 8]) != *b"RSD PTR " || *rsdp.add(15) < 2 {
            return None;
        }
        let xsdt = read_unaligned(rsdp.add(24) as *const u64) as *const u8;
        if xsdt.is_null() || read_unaligned(xsdt as *const [u8; 4]) != *b"XSDT" {
            return None;
        }
        let len = read_unaligned(xsdt.add(4) as *const u32) as usize;
        for k in 0..len.saturating_sub(36) / 8 {
            // The entries start 36 bytes in: not 8-byte aligned, so every read is an unaligned one.
            let t = read_unaligned(xsdt.add(36 + 8 * k) as *const u64) as *const u8;
            if t.is_null() || read_unaligned(t as *const [u8; 4]) != *b"SPCR" {
                continue;
            }
            let interface = *t.add(36);
            let space = *t.add(40);
            let base = read_unaligned(t.add(44) as *const u64) as usize;
            return (PL011_TYPES.contains(&interface) && space == 0 && base != 0).then_some(base);
        }
        None
    }
}

/// Finds the serial line (spcr_uart) while the firmware's tables are still the firmware's to read. The UART is left as
/// the firmware set it (rate and framing are the firmware's console's): the image only writes and reads bytes.
pub fn serial_init(st: *const SystemTable) {
    // SAFETY: efi_main calls this first, with the firmware's system table, before ExitBootServices.
    let base = unsafe { spcr_uart(st) }.unwrap_or(0);
    // SAFETY: as Uart; nothing has read it yet.
    unsafe { *UART.0.get() = base };
}

fn reg(offset: usize) -> *mut u32 {
    (uart() + offset) as *mut u32
}

fn serial_byte(b: u8) {
    if uart() == 0 {
        return;
    }
    // SAFETY: the UART the firmware's SPCR named, mapped by the firmware for its own console. The wait is bounded: a
    // stuck FIFO is given up on.
    unsafe {
        let mut spins = 0;
        while read_volatile(reg(FR)) & TXFF != 0 && spins < 100_000 {
            spins += 1;
        }
        write_volatile(reg(DR), b as u32);
    }
}

/// The next byte the serial line received, if one waits.
fn serial_read() -> Option<u8> {
    if uart() == 0 {
        return None;
    }
    // SAFETY: as serial_byte; reading DR takes the byte off the FIFO.
    unsafe { (read_volatile(reg(FR)) & RXFE == 0).then(|| read_volatile(reg(DR)) as u8) }
}

/// The serial line as a `core::fmt::Write` (newlines sent as CR LF).
pub struct Serial;

impl Write for Serial {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for b in s.bytes() {
            if b == b'\n' {
                serial_byte(b'\r');
            }
            serial_byte(b);
        }
        Ok(())
    }
}

// -------------------------------------------------------------------------------------------------------------------
// Time and stopping

/// The clock every architecture's image counts in (calibrated against the firmware's stall): the generic timer's
/// virtual count, which runs at a fixed rate whatever the cores' clocks do.
pub fn ticks() -> u64 {
    let v: u64;
    // SAFETY: CNTVCT_EL0 is readable at EL1 and EL2; the ISB keeps the read from being taken early.
    unsafe { asm!("isb", "mrs {}, cntvct_el0", out(reg) v, options(nomem, nostack, preserves_flags)) }
    v
}

/// The clock's name, for the boot log.
pub const CLOCK: &str = "the generic timer";
/// What `take_over` installs, for the boot log.
pub const TAKEN: &str = "the image's own exception vectors";

/// Interrupts off: debug, SError, IRQ and FIQ masked.
pub fn cli() {
    // SAFETY: masks exceptions nothing of the image relies on.
    unsafe { asm!("msr daifset, #0xf", options(nomem, nostack)) }
}

/// Stops the CPU for good.
pub fn halt() -> ! {
    loop {
        // SAFETY: with everything masked, WFI waits for an event that changes nothing (and comes back to this loop).
        unsafe { asm!("msr daifset, #0xf", "wfi", options(nomem, nostack)) }
    }
}

/// The exception level the image runs at (UEFI hands an application EL1, or EL2 where no hypervisor is in place).
fn current_el() -> u64 {
    let el: u64;
    // SAFETY: CurrentEL is readable at every level above EL0.
    unsafe { asm!("mrs {}, CurrentEL", out(reg) el, options(nomem, nostack, preserves_flags)) }
    (el >> 2) & 3
}

// -------------------------------------------------------------------------------------------------------------------
// The exception vectors: sixteen 128-byte entries (four sources × synchronous, IRQ, FIQ, SError), all to fault_entry

// Entry k at noir_vectors + 128k puts k in x0 and branches to the common path, which passes the stack pointer the
// exception arrived with, aligns the stack and calls fault_entry (it never returns). The table must sit on a 2 KiB
// boundary: VBAR's low 11 bits are zero.
global_asm!(
    ".text",
    ".balign 2048",
    ".global noir_vectors",
    "noir_vectors:",
    ".balign 128", "mov x0, #0", "b noir_vector_common",
    ".balign 128", "mov x0, #1", "b noir_vector_common",
    ".balign 128", "mov x0, #2", "b noir_vector_common",
    ".balign 128", "mov x0, #3", "b noir_vector_common",
    ".balign 128", "mov x0, #4", "b noir_vector_common",
    ".balign 128", "mov x0, #5", "b noir_vector_common",
    ".balign 128", "mov x0, #6", "b noir_vector_common",
    ".balign 128", "mov x0, #7", "b noir_vector_common",
    ".balign 128", "mov x0, #8", "b noir_vector_common",
    ".balign 128", "mov x0, #9", "b noir_vector_common",
    ".balign 128", "mov x0, #10", "b noir_vector_common",
    ".balign 128", "mov x0, #11", "b noir_vector_common",
    ".balign 128", "mov x0, #12", "b noir_vector_common",
    ".balign 128", "mov x0, #13", "b noir_vector_common",
    ".balign 128", "mov x0, #14", "b noir_vector_common",
    ".balign 128", "mov x0, #15", "b noir_vector_common",
    ".balign 128",
    "noir_vector_common:",
    "mov x1, sp",
    "and x2, x1, #0xfffffffffffffff0",
    "mov sp, x2",
    "bl {entry}",
    "3:",
    "msr daifset, #0xf",
    "wfi",
    "b 3b",
    entry = sym fault_entry,
);

unsafe extern "C" {
    fn noir_vectors();
}

/// The image's own exception handling, once boot services are over: VBAR at the level the image runs at points at its
/// vectors (the firmware's live in memory that is no longer reserved). At EL3, or with a table off its 2 KiB boundary
/// (the linker's doing, never seen), the firmware's vectors stay and the log says so.
///
/// # Safety
/// Interrupts must be off.
pub unsafe fn take_over() {
    let base = noir_vectors as *const () as usize;
    if base & 0x7ff != 0 {
        log::error!("the exception vectors are not on a 2 KiB boundary ({base:#x}); the firmware's stay");
        return;
    }
    // SAFETY: the table is the image's, aligned, and every entry ends in fault_entry; interrupts are masked.
    unsafe {
        match current_el() {
            1 => asm!("msr vbar_el1, {}", "isb", in(reg) base, options(nostack)),
            2 => asm!("msr vbar_el2, {}", "isb", in(reg) base, options(nostack)),
            el => log::error!("the image runs at EL{el}; the firmware's exception vectors stay"),
        }
    }
}

/// Where every exception arrives: the syndrome, the return address and the fault address of the level the image runs
/// at, then the fault screen and a halt.
extern "C" fn fault_entry(kind: u64, sp: u64) -> ! {
    let el = current_el();
    let (esr, elr, far): (u64, u64, u64);
    // SAFETY: reading the syndrome registers of the current level has no side effect.
    unsafe {
        if el == 2 {
            asm!("mrs {}, esr_el2", "mrs {}, elr_el2", "mrs {}, far_el2", out(reg) esr, out(reg) elr, out(reg) far, options(nomem, nostack, preserves_flags));
        } else {
            asm!("mrs {}, esr_el1", "mrs {}, elr_el1", "mrs {}, far_el1", out(reg) esr, out(reg) elr, out(reg) far, options(nomem, nostack, preserves_flags));
        }
    }
    crate::image::cpu_fault(&Fault { kind, el, esr, elr, far, sp })
}

/// A CPU exception as the fault screen shows it: which of the sixteen vectors took it, the exception class from the
/// syndrome (ESR), where it happened (ELR), the address a data or instruction abort was about (FAR) and the stack.
pub struct Fault {
    pub kind: u64,
    pub el: u64,
    pub esr: u64,
    pub elr: u64,
    pub far: u64,
    pub sp: u64,
}

impl Fault {
    /// The exception class (ESR bits 31:26) in words.
    pub fn class(&self) -> &'static str {
        match (self.esr >> 26) & 0x3f {
            0x00 => "an undefined instruction",
            0x01 => "a trapped WFI or WFE",
            0x07 => "a trapped FP or SIMD access",
            0x0e => "an illegal execution state",
            0x15 => "a supervisor call",
            0x16 => "a hypervisor call",
            0x18 => "a trapped system register",
            0x20 | 0x21 => "an instruction abort",
            0x22 => "a misaligned PC",
            0x24 | 0x25 => "a data abort",
            0x26 => "a misaligned stack pointer",
            0x2c => "a floating-point exception",
            0x2f => "an SError",
            0x30..=0x35 => "a debug event",
            0x3c => "a BRK instruction",
            _ => "a reserved exception class",
        }
    }

    /// The fault screen's lines, each short enough for a 1024-pixel screen (QEMU's ramfb has no wider mode): which vector
    /// and its class, the syndrome and the fault address, where it happened and the stack.
    pub fn describe(&self, a: &mut impl Write, b: &mut impl Write, c: &mut impl Write) {
        const TYPES: [&str; 4] = ["synchronous", "IRQ", "FIQ", "SError"];
        // The image runs on SP_ELx and never at a lower level: any other source is worth saying.
        const FROM: [&str; 4] = [" (on SP0)", "", " (from a lower EL, AArch64)", " (from a lower EL, AArch32)"];
        let (ty, from) = (TYPES[(self.kind & 3) as usize], FROM[((self.kind >> 2) & 3) as usize]);
        let _ = write!(a, "{ty} at EL{}{from}: {}", self.el, self.class());
        let _ = write!(b, "esr {:#010x}, far {:#x}", self.esr, self.far);
        let _ = write!(c, "elr {:#x}, sp {:#x}", self.elr, self.sp);
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The keyboard: the serial console, polled; a terminal's bytes and escape sequences as the core's key codes

/// The decoder's state between bytes.
pub struct Keyboard {
    /// 0 plain; 1 after Escape; 2 inside a CSI sequence (ESC [); 3 after ESC O (the arrows in application mode).
    state: u8,
    /// The CSI sequence's number so far (5 and 6 are Page Up and Page Down).
    param: u16,
    /// The last byte was a carriage return (a CR LF pair is one Enter).
    after_cr: bool,
}

impl Keyboard {
    pub fn new() -> Self {
        Keyboard { state: 0, param: 0, after_cr: false }
    }
}

/// One byte from the serial line, as the keys it completes (none for a byte inside a sequence, a lone LF after CR, or a
/// control byte the core has no key for; two for an Escape the byte shows was a key of its own).
pub fn key(kb: &mut Keyboard, b: u8, push: &mut impl FnMut(u32)) {
    let after_cr = core::mem::replace(&mut kb.after_cr, b == b'\r');
    let k = match kb.state {
        1 => match b {
            b'[' => {
                kb.state = 2;
                kb.param = 0;
                None
            }
            b'O' => {
                kb.state = 3;
                None
            }
            // Escape twice (a double press, or Alt and an arrow as PuTTY and rxvt send it): the first is a key, and
            // the second may begin a sequence of its own, so the state stays.
            0x1b => Some(KEY_ESC),
            // Escape then a plain byte (a key typed right after Escape, or Alt and a key): both are keys, so nothing
            // typed is lost.
            _ => {
                kb.state = 0;
                push(KEY_ESC);
                plain(kb, b, after_cr)
            }
        },
        2 => match b {
            b'0'..=b'9' => {
                kb.param = kb.param.saturating_mul(10).saturating_add((b - b'0') as u16);
                None
            }
            b';' => None,
            0x40..=0x7e => {
                kb.state = 0;
                match b {
                    b'A' => Some(KEY_UP),
                    b'B' => Some(KEY_DOWN),
                    b'C' => Some(KEY_RIGHT),
                    b'D' => Some(KEY_LEFT),
                    b'~' if kb.param == 5 => Some(KEY_PAGE_UP),
                    b'~' if kb.param == 6 => Some(KEY_PAGE_DOWN),
                    _ => None,
                }
            }
            _ => {
                kb.state = 0;
                None
            }
        },
        3 => {
            kb.state = 0;
            match b {
                b'A' => Some(KEY_UP),
                b'B' => Some(KEY_DOWN),
                b'C' => Some(KEY_RIGHT),
                b'D' => Some(KEY_LEFT),
                b'M' => Some(KEY_ENTER),
                _ => None,
            }
        }
        _ => plain(kb, b, after_cr),
    };
    if let Some(k) = k {
        push(k);
    }
}

/// A byte outside any sequence: Escape starts one; CR, or an LF that does not end a CR LF pair, is Enter.
fn plain(kb: &mut Keyboard, b: u8, after_cr: bool) -> Option<u32> {
    match b {
        0x1b => {
            kb.state = 1;
            None
        }
        b'\r' => Some(KEY_ENTER),
        b'\n' => (!after_cr).then_some(KEY_ENTER),
        0x08 | 0x7f => Some(KEY_BACKSPACE),
        b'\t' | 0x20..=0x7e => Some(b as u32),
        _ => None,
    }
}

/// The keys typed since the last call, in the core's key codes, into `keys` (what does not fit is dropped); returns how
/// many. A lone Escape is held for one poll (about a frame), so the start of an arrow's sequence split across two polls
/// is not taken for the Escape key.
pub fn poll_keys(kb: &mut Keyboard, keys: &mut [u32]) -> usize {
    let mut n = 0;
    let mut push = |k: u32| {
        if n < keys.len() {
            keys[n] = k;
            n += 1;
        }
    };
    // An Escape that ended the last poll's bytes: a key of its own if nothing follows it in this one.
    let held = kb.state == 1;
    let mut read = 0;
    // Bounded: a line that never stops talking cannot hold the frame.
    while read < 256 {
        let Some(b) = serial_read() else { break };
        read += 1;
        key(kb, b, &mut push);
    }
    if held && read == 0 {
        kb.state = 0;
        push(KEY_ESC);
    }
    n
}
