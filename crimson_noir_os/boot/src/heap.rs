// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the only allocator the bootable image has, and it enforces the containment
//! configuration's memory rule: the image takes exactly `memory.arenaBytes` from the firmware, carves the declared layout
//! out of it in order (every allocation rounded to config::ALLOC_ALIGN, so the bytes used must equal
//! config::declared_bytes), and is then sealed: any allocation after boot fails, and a failed allocation is a fault
//! screen ("an allocation the configuration never declared"). Nothing is ever freed: everything declared lives as long
//! as the system.
//! What breaks if it is removed? `alloc` has no global allocator, and undeclared allocations would go unnoticed.

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;

use noir_core::config::ALLOC_ALIGN;

struct State {
    base: usize,
    next: usize,
    end: usize,
    sealed: bool,
    /// Allocations refused (after the seal, or past the arena).
    refused: usize,
}

pub struct Arena(UnsafeCell<State>);

// SAFETY: one CPU, interrupts off: nothing runs concurrently with an allocation.
unsafe impl Sync for Arena {}

#[global_allocator]
pub static ARENA: Arena = Arena(UnsafeCell::new(State { base: 0, next: 0, end: 0, sealed: false, refused: 0 }));

fn state() -> &'static mut State {
    // SAFETY: as Sync above; no reference to the state outlives the call that takes it.
    unsafe { &mut *ARENA.0.get() }
}

/// Hands the allocator the declared arena.
pub fn init(base: usize, len: usize) {
    let s = state();
    s.base = base;
    s.next = base;
    s.end = base + len;
}

/// No allocation after this.
pub fn seal() {
    state().sealed = true;
}

/// Bytes carved from the arena so far.
pub fn used() -> usize {
    let s = state();
    s.next - s.base
}

/// The arena's part no allocation has touched: [start, end).
pub fn untouched() -> (usize, usize) {
    let s = state();
    (s.next, s.end)
}

pub fn refused() -> usize {
    state().refused
}

/// Asks the sealed allocator for 64 bytes, live: true when it refuses (the tutorial's memory check). The probe's own
/// refusal is not counted, so a later panic is not mistaken for an undeclared allocation.
pub fn seal_holds() -> bool {
    let before = refused();
    // SAFETY: a valid, non-zero layout; a pointer, were one returned, would never be used or freed.
    let p = unsafe { ARENA.alloc(Layout::from_size_align_unchecked(64, 64)) };
    let held = p.is_null() && refused() == before + 1;
    state().refused = before;
    held
}

unsafe impl GlobalAlloc for Arena {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let s = state();
        if s.sealed || s.base == 0 {
            s.refused += 1;
            return core::ptr::null_mut();
        }
        let align = layout.align().max(ALLOC_ALIGN);
        let start = (s.next + align - 1) & !(align - 1);
        let size = layout.size().div_ceil(ALLOC_ALIGN) * ALLOC_ALIGN;
        if start + size > s.end {
            s.refused += 1;
            return core::ptr::null_mut();
        }
        s.next = start + size;
        start as *mut u8
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}
