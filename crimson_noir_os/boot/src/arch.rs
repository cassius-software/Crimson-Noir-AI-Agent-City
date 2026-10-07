//! Why does this file exist? It is what the bootable image does to the x86-64 machine itself once the firmware has let
//! go: port I/O; the COM1 serial line the log is written to (a test harness reads it); the time-stamp counter, the only
//! clock it needs; its own GDT and IDT, so that every one of the 32 CPU exceptions (a page fault, a general protection
//! fault, a divide error, an invalid opcode) lands in `fault_entry` and the fault screen instead of a triple fault and a
//! silent reboot; and the PS/2 keyboard, polled, with a US set-1 keymap. Interrupts stay off: the system polls, so no
//! device can preempt the hot path.
//! What breaks if it is removed? After ExitBootServices the image would have no log, no clock, no keyboard, and no way to
//! catch a hardware fault.

use core::arch::{asm, global_asm};

/// Writes a byte to an I/O port.
///
/// # Safety
/// The port must be one this image owns (COM1, the PS/2 controller).
#[inline]
pub unsafe fn outb(port: u16, value: u8) {
    unsafe { asm!("out dx, al", in("dx") port, in("al") value, options(nomem, nostack, preserves_flags)) }
}

/// Reads a byte from an I/O port.
///
/// # Safety
/// As `outb`.
#[inline]
pub unsafe fn inb(port: u16) -> u8 {
    let value: u8;
    unsafe { asm!("in al, dx", out("al") value, in("dx") port, options(nomem, nostack, preserves_flags)) }
    value
}

// -------------------------------------------------------------------------------------------------------------------
// The serial line (COM1, 115200 8N1)

const COM1: u16 = 0x3f8;

pub fn serial_init() {
    // SAFETY: COM1 is the image's alone; on a machine without one the writes go nowhere.
    unsafe {
        outb(COM1 + 1, 0x00); // no interrupts
        outb(COM1 + 3, 0x80); // the divisor latch
        outb(COM1, 0x01); // 115200 baud
        outb(COM1 + 1, 0x00);
        outb(COM1 + 3, 0x03); // 8 bits, no parity, one stop bit
        outb(COM1 + 2, 0xc7); // FIFO on, cleared
        outb(COM1 + 4, 0x0b);
    }
}

fn serial_byte(b: u8) {
    // SAFETY: as serial_init. The wait is bounded: a missing port reads 0xff, a stuck one is given up on.
    unsafe {
        let mut spins = 0;
        while inb(COM1 + 5) & 0x20 == 0 && spins < 100_000 {
            spins += 1;
        }
        outb(COM1, b);
    }
}

/// The serial line as a `core::fmt::Write` (newlines sent as CR LF).
pub struct Serial;

impl core::fmt::Write for Serial {
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

pub fn rdtsc() -> u64 {
    // SAFETY: RDTSC has no preconditions on x86-64.
    unsafe { core::arch::x86_64::_rdtsc() }
}

/// Interrupts off.
pub fn cli() {
    // SAFETY: masks maskable interrupts; nothing of the image relies on them.
    unsafe { asm!("cli", options(nomem, nostack)) }
}

/// Stops the CPU for good.
pub fn halt() -> ! {
    loop {
        // SAFETY: with interrupts off, HLT stops the CPU until reset (an NMI comes back to this loop).
        unsafe { asm!("cli", "hlt", options(nomem, nostack)) }
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The GDT: a null descriptor, 64-bit code (0x08), data (0x10)

#[repr(C, align(16))]
struct Gdt([u64; 3]);

static GDT: Gdt = Gdt([0, 0x00af_9a00_0000_ffff, 0x00cf_9200_0000_ffff]);

#[repr(C, packed)]
struct TablePointer {
    limit: u16,
    base: u64,
}

/// Loads the image's own GDT and reloads every segment register from it (the firmware's lives in memory that is no
/// longer reserved once boot services end).
///
/// # Safety
/// Interrupts must be off.
pub unsafe fn load_gdt() {
    let ptr = TablePointer { limit: (core::mem::size_of::<Gdt>() - 1) as u16, base: &GDT as *const Gdt as u64 };
    unsafe {
        asm!(
            "lgdt [{ptr}]",
            "push 0x08",
            "lea {tmp}, [rip + 2f]",
            "push {tmp}",
            "retfq",
            "2:",
            "mov {tmp:e}, 0x10",
            "mov ds, {tmp:x}",
            "mov es, {tmp:x}",
            "mov ss, {tmp:x}",
            "mov fs, {tmp:x}",
            "mov gs, {tmp:x}",
            ptr = in(reg) &ptr,
            tmp = out(reg) _,
        );
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The IDT: one 16-byte stub per CPU exception, every other vector to one stub; all to fault_entry

/// What the CPU and the stub leave on the stack: the vector, the error code (0 when the CPU pushes none), then the
/// CPU's own frame.
#[repr(C)]
pub struct FaultFrame {
    pub vector: u64,
    pub error: u64,
    pub rip: u64,
    pub cs: u64,
    pub rflags: u64,
    pub rsp: u64,
    pub ss: u64,
}

// Stubs 0..31, each aligned on 16 bytes (stub k at noir_isr_stubs + 16k). Vectors 8, 10–14, 17, 21, 29 and 30 come with
// an error code from the CPU; the others push a zero in its place.
global_asm!(
    ".text",
    ".balign 16",
    ".global noir_isr_stubs",
    "noir_isr_stubs:",
    ".balign 16", "push 0", "push 0", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 1", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 2", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 3", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 4", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 5", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 6", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 7", "jmp noir_isr_common",
    ".balign 16", "push 8", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 9", "jmp noir_isr_common",
    ".balign 16", "push 10", "jmp noir_isr_common",
    ".balign 16", "push 11", "jmp noir_isr_common",
    ".balign 16", "push 12", "jmp noir_isr_common",
    ".balign 16", "push 13", "jmp noir_isr_common",
    ".balign 16", "push 14", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 15", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 16", "jmp noir_isr_common",
    ".balign 16", "push 17", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 18", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 19", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 20", "jmp noir_isr_common",
    ".balign 16", "push 21", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 22", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 23", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 24", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 25", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 26", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 27", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 28", "jmp noir_isr_common",
    ".balign 16", "push 29", "jmp noir_isr_common",
    ".balign 16", "push 30", "jmp noir_isr_common",
    ".balign 16", "push 0", "push 31", "jmp noir_isr_common",
    ".balign 16",
    ".global noir_isr_other",
    "noir_isr_other:",
    "push 0",
    "push 255",
    "noir_isr_common:",
    "mov rdi, rsp",
    "and rsp, -16",
    "call {entry}",
    "3:",
    "cli",
    "hlt",
    "jmp 3b",
    entry = sym fault_entry,
);

unsafe extern "C" {
    fn noir_isr_stubs();
    fn noir_isr_other();
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Gate {
    offset_low: u16,
    selector: u16,
    ist: u8,
    attributes: u8,
    offset_mid: u16,
    offset_high: u32,
    zero: u32,
}

#[repr(C, align(16))]
struct Idt([Gate; 256]);

static mut IDT: Idt = Idt([Gate { offset_low: 0, selector: 0, ist: 0, attributes: 0, offset_mid: 0, offset_high: 0, zero: 0 }; 256]);

fn gate(handler: usize) -> Gate {
    Gate {
        offset_low: handler as u16,
        selector: 0x08,
        ist: 0,
        // Present, ring 0, a 64-bit interrupt gate (interrupts stay off inside).
        attributes: 0x8e,
        offset_mid: (handler >> 16) as u16,
        offset_high: (handler >> 32) as u32,
        zero: 0,
    }
}

/// Fills and loads the IDT.
///
/// # Safety
/// Interrupts must be off, and `load_gdt` must have run (the gates name its code segment).
pub unsafe fn load_idt() {
    let stubs = noir_isr_stubs as *const () as usize;
    let other = noir_isr_other as *const () as usize;
    let idt = &raw mut IDT;
    unsafe {
        for (v, g) in (*idt).0.iter_mut().enumerate() {
            *g = gate(if v < 32 { stubs + 16 * v } else { other });
        }
        let ptr = TablePointer { limit: (core::mem::size_of::<Idt>() - 1) as u16, base: idt as u64 };
        asm!("lidt [{ptr}]", ptr = in(reg) &ptr, options(nostack));
    }
}

/// Where every exception arrives: the fault screen, then a halt.
extern "sysv64" fn fault_entry(frame: *const FaultFrame) -> ! {
    let cr2: u64;
    // SAFETY: reading CR2 has no side effect; the frame is the one the stub just built on this stack.
    unsafe {
        asm!("mov {}, cr2", out(reg) cr2, options(nomem, nostack, preserves_flags));
        crate::image::cpu_fault(&*frame, cr2)
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The keyboard: the PS/2 controller, polled, scancode set 1 (the controller's translation, as firmware leaves it)

use noir_core::system::{KEY_DOWN, KEY_ENTER, KEY_LEFT, KEY_PAGE_DOWN, KEY_PAGE_UP, KEY_RIGHT, KEY_UP};

const NORMAL: &[u8; 59] = b"\x00\x1b1234567890-=\x08\tqwertyuiop[]\r\x00asdfghjkl;'`\x00\\zxcvbnm,./\x00*\x00 \x00";
const SHIFTED: &[u8; 59] = b"\x00\x1b!@#$%^&*()_+\x08\tQWERTYUIOP{}\r\x00ASDFGHJKL:\"~\x00|ZXCVBNM<>?\x00*\x00 \x00";

/// The keyboard's state between scancodes.
pub struct Keyboard {
    pub shift: bool,
    pub caps: bool,
    pub extended: bool,
}

/// The next byte from the keyboard, if one waits (bytes from a PS/2 mouse are dropped).
pub fn ps2_byte() -> Option<u8> {
    // SAFETY: the PS/2 controller's status and data ports; reading data takes the byte off.
    unsafe {
        let status = inb(0x64);
        if status & 1 == 0 {
            return None;
        }
        let b = inb(0x60);
        if status & 0x20 != 0 {
            return None;
        }
        Some(b)
    }
}

/// A scancode as a key, in the core's key codes (noir_core::system::KEY_*: ASCII for characters, Enter '\r',
/// Backspace 8, Escape 27); None for releases and modifiers.
pub fn key(kb: &mut Keyboard, sc: u8) -> Option<u32> {
    if sc == 0xe0 {
        kb.extended = true;
        return None;
    }
    let extended = core::mem::replace(&mut kb.extended, false);
    let release = sc & 0x80 != 0;
    let code = sc & 0x7f;
    if code == 0x2a || code == 0x36 {
        kb.shift = !release;
        return None;
    }
    if release {
        return None;
    }
    if extended {
        return match code {
            0x48 => Some(KEY_UP),
            0x50 => Some(KEY_DOWN),
            0x4b => Some(KEY_LEFT),
            0x4d => Some(KEY_RIGHT),
            0x49 => Some(KEY_PAGE_UP),
            0x51 => Some(KEY_PAGE_DOWN),
            0x1c => Some(KEY_ENTER),
            _ => None,
        };
    }
    if code == 0x3a {
        kb.caps = !kb.caps;
        return None;
    }
    let i = code as usize;
    if i >= NORMAL.len() {
        return None;
    }
    let mut c = if kb.shift { SHIFTED[i] } else { NORMAL[i] };
    if kb.caps && c.is_ascii_alphabetic() {
        c ^= 0x20;
    }
    (c != 0).then_some(c as u32)
}
