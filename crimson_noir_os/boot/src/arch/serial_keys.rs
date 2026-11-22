// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? On the machines whose keyboard is the serial console (aarch64 and riscv64: neither has a
//! PS/2 controller, and the image has no USB stack) the keys arrive as a terminal sends them: plain bytes, and escape
//! sequences for the arrows and the page keys. This is the one decoder both machine layers use: bytes in, the core's
//! key codes out, with the state a sequence needs between bytes. Each layer gives it only its way to read one byte
//! from its own serial line (a UART's register on aarch64, the SBI console on riscv64).
//! What breaks if it is removed? Neither serial-console machine can be typed into, so the tutorial and the terminal
//! cannot be driven there, by a person or by the boot test.

use noir_core::system::{KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_LEFT, KEY_PAGE_DOWN, KEY_PAGE_UP, KEY_RIGHT, KEY_UP};

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
fn key(kb: &mut Keyboard, b: u8, push: &mut impl FnMut(u32)) {
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
/// many. `read` gives the next byte the serial line received, if one waits. A lone Escape is held for one poll (about a
/// frame), so the start of an arrow's sequence split across two polls is not taken for the Escape key.
pub fn poll(kb: &mut Keyboard, keys: &mut [u32], mut read: impl FnMut() -> Option<u8>) -> usize {
    let mut n = 0;
    let mut push = |k: u32| {
        if n < keys.len() {
            keys[n] = k;
            n += 1;
        }
    };
    // An Escape that ended the last poll's bytes: a key of its own if nothing follows it in this one.
    let held = kb.state == 1;
    let mut count = 0;
    // Bounded: a line that never stops talking cannot hold the frame.
    while count < 256 {
        let Some(b) = read() else { break };
        count += 1;
        key(kb, b, &mut push);
    }
    if held && count == 0 {
        kb.state = 0;
        push(KEY_ESC);
    }
    n
}
