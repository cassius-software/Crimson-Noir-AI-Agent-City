// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is what the bootable image does to a riscv64 machine itself once the firmware has let
//! go (arch.rs names what every architecture provides), and, on this architecture alone, how the image comes to be a
//! UEFI application at all. Rust has no riscv64 UEFI target and its linker writes no RISC-V PE file, so the image is
//! built for the bare-metal target `riscv64gc-unknown-none-elf`, linked position-independent at address 0 (riscv64.ld)
//! and written out flat behind the PE32+ header below, which is laid out by hand from the PE format's public
//! description (machine 0x5064, subsystem 10, two sections, no relocation directory). The firmware loads that file
//! wherever it likes and relocates nothing, so the entry applies the image's own relative relocations before any Rust
//! runs, then calls `efi_main` as the firmware would have. After the firmware lets go: the serial line the log is
//! written to and the keys are read from is the SBI console (the supervisor binary interface every RISC-V firmware
//! offers under a UEFI one: its Debug Console extension, or the legacy console calls where that is missing; a test
//! harness reads the log and types into it); the clock is the `time` CSR; and the image's own trap vector (`stvec`)
//! sends every exception to `fault_entry` and the fault screen instead of the firmware's handler on memory that is no
//! longer reserved. Interrupts stay masked: the system polls, so no device can preempt the hot path. The keyboard is
//! the serial console (serial_keys.rs), as on aarch64.
//! What breaks if it is removed? There is no image for riscv64: no header a firmware would load, and after
//! ExitBootServices no log, no clock, no keys, and no way to catch a hardware fault.

use core::arch::{asm, global_asm};
use core::fmt::Write;

use crate::uefi::SystemTable;

// -------------------------------------------------------------------------------------------------------------------
// The PE32+ header and the entry: the image's own relocations, then efi_main

// The header is the file's first 4096 bytes (riscv64.ld puts `.head` at address 0, so every file offset is its
// address in memory). Its sizes and addresses are the linker script's symbols. The firmware is told of no relocations
// (sixteen empty data directories), and the image is not marked as having had them stripped, so a loader places it
// anywhere and leaves it as it is. `.text` holds the code; `.data` holds everything else, the read-only data too,
// because every address the entry rewrites lies there and the section must be writable while it does.
//
// The entry runs where it was loaded, before anything is relocated, so it uses addresses relative to itself alone
// (`lla`). It turns the floating-point unit on (the image is built for a machine that has one, and a firmware may
// hand over with it off, where the first such instruction would trap), then walks the relocation table the linker
// left between `__rela_start` and `__rela_end`: each entry of the relative kind (3) names a place and a value, both
// counted from the image's start, and the place gets the value plus where the image really is. An entry of any other
// kind would be an address this code cannot place, so the image returns the firmware's load error (the top bit and
// 1) instead of running with it wrong; a link that keeps to this file's flags makes none. `gp` and `tp` are the
// firmware's and are never touched (the link is made without relaxation against `gp`).
global_asm!(
    r#"
    .section .head, "a"
    .globl _pe_head
_pe_head:
    .ascii "MZ"
    .zero 58
    .long 0x40                      // where the PE signature is
    .ascii "PE\0\0"
    .short 0x5064                   // machine: RISC-V, 64 bits
    .short 2                        // sections
    .long 0                         // no time stamp: the same source is the same bytes
    .long 0                         // no symbol table
    .long 0
    .short 240                      // size of the optional header (112 and sixteen directories of 8)
    .short 0x0206                   // executable, line numbers and debug information stripped
    .short 0x020b                   // PE32+
    .byte 0, 0                      // linker version: none claimed
    .long _pe_text_size             // size of code
    .long _pe_data_fsize            // size of initialised data
    .long 0                         // size of uninitialised data (counted in .data's virtual size)
    .long _pe_entry_rva             // entry point
    .long _pe_text_rva              // base of code
    .quad 0                         // preferred base: none
    .long 0x1000                    // section alignment
    .long 0x1000                    // file alignment
    .short 0, 0, 0, 0, 0, 0         // operating system, image and subsystem versions
    .long 0
    .long _pe_image_size            // size of the image in memory
    .long _pe_text_rva              // size of the headers
    .long 0                         // no checksum
    .short 10                       // subsystem: an EFI application
    .short 0
    .quad 0, 0, 0, 0                // stack and heap sizes: the firmware's
    .long 0
    .long 16                        // data directories
    .zero 128                       // all sixteen empty
    .ascii ".text\0\0\0"
    .long _pe_text_size             // size in memory
    .long _pe_text_rva              // address in memory
    .long _pe_text_size             // size in the file
    .long _pe_text_rva              // offset in the file
    .long 0, 0
    .short 0, 0
    .long 0x60000020                // code, executable, readable
    .ascii ".data\0\0\0"
    .long _pe_data_vsize            // size in memory (with the zeroed part)
    .long _pe_data_rva
    .long _pe_data_fsize
    .long _pe_data_rva
    .long 0, 0
    .short 0, 0
    .long 0xc0000040                // initialised data, readable, writable

    .section .text.entry, "ax"
    .globl _entry
_entry:
    addi sp, sp, -32
    sd a0, 0(sp)                    // the image handle
    sd a1, 8(sp)                    // the system table
    sd ra, 16(sp)
    li t0, 0x2000                   // sstatus.FS: the floating-point unit on
    csrs sstatus, t0
    lla a0, ImageBase               // where the firmware loaded the image
    lla a1, __rela_start
    lla a2, __rela_end
1:  bgeu a1, a2, 3f
    ld t0, 8(a1)                    // the entry's kind
    li t1, 3                        // relative: the one kind this image has
    bne t0, t1, 4f
    ld t0, 0(a1)                    // the place, from the image's start
    ld t1, 16(a1)                   // the value, from the image's start
    add t0, t0, a0
    add t1, t1, a0
    sd t1, 0(t0)
    addi a1, a1, 24
    j 1b
3:  ld a0, 0(sp)
    ld a1, 8(sp)
    call efi_main
2:  ld ra, 16(sp)
    addi sp, sp, 32
    ret
4:  li a0, 0x8000000000000001       // EFI_LOAD_ERROR: an address the entry cannot place
    j 2b
"#
);

// -------------------------------------------------------------------------------------------------------------------
// The serial line: the SBI console

const SBI_BASE: usize = 0x10;
const SBI_DBCN: usize = 0x4442_434e;

fn sbi(eid: usize, fid: usize, a0: usize, a1: usize, a2: usize) -> (isize, usize) {
    let (e, v): (isize, usize);
    // SAFETY: an environment call to the supervisor execution environment; a0 and a1 carry the answer.
    unsafe { asm!("ecall", inlateout("a0") a0 => e, inlateout("a1") a1 => v, in("a2") a2, in("a6") fid, in("a7") eid, options(nostack)) }
    (e, v)
}

/// Whether the SBI has the Debug Console extension (set once in serial_init).
struct Flag(core::cell::UnsafeCell<bool>);
// SAFETY: one CPU, interrupts off; written once in serial_init, before anything reads it.
unsafe impl Sync for Flag {}
static DBCN: Flag = Flag(core::cell::UnsafeCell::new(false));

fn dbcn() -> bool {
    // SAFETY: as Flag.
    unsafe { *DBCN.0.get() }
}

pub fn serial_init(_st: *const SystemTable) {
    let (e, v) = sbi(SBI_BASE, 3, SBI_DBCN, 0, 0);
    // SAFETY: as Flag; nothing has read it yet.
    unsafe { *DBCN.0.get() = e == 0 && v != 0 };
}

fn serial_byte(b: u8) {
    if dbcn() {
        sbi(SBI_DBCN, 2, b as usize, 0, 0);
    } else {
        sbi(1, 0, b as usize, 0, 0);
    }
}

/// The next byte the serial line received, if one waits.
fn serial_read() -> Option<u8> {
    if dbcn() {
        let mut b = 0u8;
        // The buffer's address is physical: the firmware's page table maps memory one to one.
        let (e, n) = sbi(SBI_DBCN, 1, 1, &mut b as *mut u8 as usize, 0);
        (e == 0 && n == 1).then_some(b)
    } else {
        let (c, _) = sbi(2, 0, 0, 0, 0);
        (c >= 0).then_some(c as u8)
    }
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

/// The clock: the time CSR, which counts at the platform's fixed timebase.
pub fn ticks() -> u64 {
    let v: u64;
    // SAFETY: the time CSR is readable in S-mode (the SBI emulates it where the hart does not have it).
    unsafe { asm!("rdtime {}", out(reg) v, options(nomem, nostack)) }
    v
}

pub const CLOCK: &str = "the time CSR";
pub const TAKEN: &str = "the image's own trap vector";

/// Interrupts off: the supervisor interrupt enable, and every source.
pub fn cli() {
    // SAFETY: masks interrupts nothing of the image relies on.
    unsafe { asm!("csrci sstatus, 2", "csrw sie, zero", options(nomem, nostack)) }
}

pub fn halt() -> ! {
    loop {
        // SAFETY: with everything masked, WFI waits for an event that changes nothing.
        unsafe { asm!("csrci sstatus, 2", "wfi", options(nomem, nostack)) }
    }
}

global_asm!(
    r#"
    .section .text.noir_trap, "ax"
    .balign 4
    .globl noir_trap
noir_trap:
    mv a0, sp
    andi sp, sp, -16
    call {entry}
1:  csrci sstatus, 2
    wfi
    j 1b
"#,
    entry = sym fault_entry,
);

unsafe extern "C" {
    fn noir_trap();
}

/// The image's own trap handling: stvec (direct mode) points at its handler.
///
/// # Safety
/// Interrupts must be off.
pub unsafe fn take_over() {
    let base = noir_trap as *const () as usize;
    if base & 3 != 0 {
        log::error!("the trap vector is not on a 4-byte boundary ({base:#x}); the firmware's stays");
        return;
    }
    // SAFETY: the handler is the image's and ends in fault_entry; interrupts are masked. The floating-point unit is
    // left on (sstatus.FS), as the firmware had it.
    unsafe { asm!("csrw stvec, {}", in(reg) base, options(nostack)) }
}

extern "C" fn fault_entry(sp: u64) -> ! {
    let (scause, sepc, stval): (u64, u64, u64);
    // SAFETY: reading the trap CSRs has no side effect.
    unsafe { asm!("csrr {}, scause", "csrr {}, sepc", "csrr {}, stval", out(reg) scause, out(reg) sepc, out(reg) stval, options(nomem, nostack)) }
    crate::image::cpu_fault(&Fault { scause, sepc, stval, sp })
}

pub struct Fault {
    pub scause: u64,
    pub sepc: u64,
    pub stval: u64,
    pub sp: u64,
}

impl Fault {
    pub fn class(&self) -> &'static str {
        if self.scause >> 63 != 0 {
            return "an interrupt the system never enabled";
        }
        match self.scause {
            0 => "a misaligned instruction address",
            1 => "an instruction access fault",
            2 => "an illegal instruction",
            3 => "a breakpoint",
            4 => "a misaligned load",
            5 => "a load access fault",
            6 => "a misaligned store",
            7 => "a store access fault",
            8 | 9 => "an environment call",
            12 => "an instruction page fault",
            13 => "a load page fault",
            15 => "a store page fault",
            _ => "a reserved exception",
        }
    }

    pub fn describe(&self, a: &mut impl Write, b: &mut impl Write, c: &mut impl Write) {
        let _ = write!(a, "scause {:#x}: {}", self.scause, self.class());
        let _ = write!(b, "stval {:#x}", self.stval);
        let _ = write!(c, "sepc {:#x}, sp {:#x}", self.sepc, self.sp);
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The keyboard: the serial console, polled; a terminal's bytes and escape sequences as the core's key codes
// (serial_keys.rs, the decoder every serial-console machine shares)

pub use super::serial_keys::Keyboard;

/// The keys typed since the last call, in the core's key codes, into `keys` (what does not fit is dropped); returns how
/// many.
pub fn poll_keys(kb: &mut Keyboard, keys: &mut [u32]) -> usize {
    super::serial_keys::poll(kb, keys, serial_read)
}
