//! Why does this file exist? Every allocation the system makes is made here, once, at boot, in the order and at the
//! sizes the containment configuration's layout declares (config::layout): the Global Matrix, then the display (the
//! render target and its depth), the scene's triangles (flat arrays, fixed point), and the terminal (its dictionary,
//! stacks and scrollback). The bootable image checks the bytes its sealed allocator handed out against
//! config::declared_bytes; nothing is allocated after.
//! What breaks if it is removed? Every part of the system would size its own memory, and none of it would be declared.

use alloc::vec;
use alloc::vec::Vec;

use crate::config::{Dims, TERM_COLS};
use crate::matrix::{self, Matrix};

/// The display, the scene and the terminal's memory (beside the Global Matrix).
pub struct Buffers {
    /// The render target, 0x00RRGGBB, display_width × display_height.
    pub color: Vec<u32>,
    /// Its depth, one word a pixel.
    pub zbuf: Vec<u32>,
    /// The scene's triangles: three vertices each (x, y, z in Q16.16 metres), and a colour each.
    pub tri_x: Vec<i32>,
    pub tri_y: Vec<i32>,
    pub tri_z: Vec<i32>,
    pub tri_rgb: Vec<u32>,
    /// The terminal: its dictionary cells, data and return stacks, scrollback (term_lines × TERM_COLS) and input line.
    pub term_dict: Vec<i32>,
    pub term_stack: Vec<i32>,
    pub term_rstack: Vec<i32>,
    pub term_text: Vec<u8>,
    pub term_line: Vec<u8>,
}

/// Everything the system holds.
pub struct System {
    pub m: Matrix,
    pub b: Buffers,
}

/// Makes every declared allocation (config::layout's order and sizes).
pub fn allocate(d: &Dims) -> System {
    let m = matrix::new(d);
    let pixels = d.display_width * d.display_height;
    let b = Buffers {
        color: vec![0; pixels],
        zbuf: vec![0; pixels],
        tri_x: vec![0; d.triangles * 3],
        tri_y: vec![0; d.triangles * 3],
        tri_z: vec![0; d.triangles * 3],
        tri_rgb: vec![0; d.triangles],
        term_dict: vec![0; d.term_cells],
        term_stack: vec![0; d.term_stack],
        term_rstack: vec![0; d.term_stack],
        term_text: vec![b' '; d.term_lines * TERM_COLS],
        term_line: vec![0; TERM_COLS * 4],
    };
    System { m, b }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{alloc_bytes, declared_bytes, layout, parse, validate};

    #[test]
    fn every_declared_allocation_is_made_at_its_declared_size() {
        let c = validate(&parse(include_str!("../../../containment.nix")).unwrap()).unwrap();
        let d = &c.dims;
        let s = allocate(d);
        let m = &s.m;
        let b = &s.b;
        let made: [(&str, usize); 31] = [
            ("px", m.px.capacity() * 4),
            ("pz", m.pz.capacity() * 4),
            ("alive", m.alive.capacity() * 4),
            ("doomed", m.doomed.capacity() * 4),
            ("caps", m.caps.capacity() * 4),
            ("req", m.req.capacity() * 4),
            ("role", m.role.capacity() * 4),
            ("goal", m.goal.capacity() * 4),
            ("run", m.run.capacity() * 4),
            ("last", m.last.capacity() * 4),
            ("trips", m.trips.capacity() * 4),
            ("clock", m.clock.capacity() * 4),
            ("heading", m.heading.capacity() * 4),
            ("fate", m.fate.capacity() * 4),
            ("weights", m.weights.capacity() * 4),
            ("memory", m.memory.capacity() * 4),
            ("walls", m.walls.capacity() * 4),
            ("field", m.field.capacity() * 4),
            ("scratch", m.scratch.capacity() * 4),
            ("station", m.station.capacity() * 4),
            ("color", b.color.capacity() * 4),
            ("zbuf", b.zbuf.capacity() * 4),
            ("tri_x", b.tri_x.capacity() * 4),
            ("tri_y", b.tri_y.capacity() * 4),
            ("tri_z", b.tri_z.capacity() * 4),
            ("tri_rgb", b.tri_rgb.capacity() * 4),
            ("term_dict", b.term_dict.capacity() * 4),
            ("term_stack", b.term_stack.capacity() * 4),
            ("term_rstack", b.term_rstack.capacity() * 4),
            ("term_text", b.term_text.capacity()),
            ("term_line", b.term_line.capacity()),
        ];
        let l = layout(d);
        assert_eq!(l.len(), made.len(), "every declared allocation is made, and no other");
        let mut total = 0;
        for (a, (name, bytes)) in l.iter().zip(made) {
            assert_eq!(a.name, name, "in the declared order");
            assert_eq!(a.elems * a.elem_bytes, bytes, "{name}");
            total += alloc_bytes(a);
        }
        assert_eq!(total, declared_bytes(d));
    }
}
