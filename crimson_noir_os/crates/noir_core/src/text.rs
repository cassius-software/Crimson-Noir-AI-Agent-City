//! Why does this file exist? Every word the system shows is drawn here: the tutorial's captions, the terminal, the
//! fault screen. Glyphs are the public-domain 8×8 bitmap font of the IBM PC era as the `font8x8` crate ships it (MIT;
//! bit 0 of each row is the leftmost pixel), drawn into a 0x00RRGGBB pixel buffer, scaled by whole pixels and clipped
//! to the buffer. Integer arithmetic only, so it costs the same on the bare-metal image (soft-float) as anywhere.
//! What breaks if it is removed? The system has no way to say anything on screen.

use font8x8::legacy::BASIC_LEGACY;

/// A glyph's side, in font pixels.
pub const GLYPH: i32 = 8;

/// The rows of `c`'s glyph (anything outside printable ASCII is drawn as '?').
pub fn glyph(c: char) -> [u8; 8] {
    let i = c as u32;
    BASIC_LEGACY[if (32..127).contains(&i) { i as usize } else { b'?' as usize }]
}

/// A pixel target: `width` × `height` pixels, `stride` pixels from one row to the next.
pub struct Target<'a> {
    pub pixels: &'a mut [u32],
    pub width: usize,
    pub height: usize,
    pub stride: usize,
}

/// Fills a rectangle, clipped.
pub fn fill(t: &mut Target, x: i32, y: i32, w: i32, h: i32, color: u32) {
    let x0 = x.clamp(0, t.width as i32) as usize;
    let y0 = y.clamp(0, t.height as i32) as usize;
    let x1 = x.saturating_add(w).clamp(0, t.width as i32) as usize;
    let y1 = y.saturating_add(h).clamp(0, t.height as i32) as usize;
    if x0 >= x1 {
        return;
    }
    for row in y0..y1 {
        for p in &mut t.pixels[row * t.stride + x0..row * t.stride + x1] {
            *p = color;
        }
    }
}

/// Draws `s` with its top-left at (x, y), each font pixel `scale` pixels square, in `color`; clipped. Returns the x
/// after the last glyph.
pub fn draw(t: &mut Target, x: i32, y: i32, scale: i32, color: u32, s: &str) -> i32 {
    let mut cx = x;
    for c in s.chars() {
        let rows = glyph(c);
        for (gy, bits) in rows.iter().enumerate() {
            for gx in 0..8 {
                if bits & (1 << gx) != 0 {
                    fill(t, cx + gx * scale, y + gy as i32 * scale, scale, scale, color);
                }
            }
        }
        cx += GLYPH * scale;
    }
    cx
}

/// The width `s` takes at `scale`, in pixels.
pub fn width(s: &str, scale: i32) -> i32 {
    s.chars().count() as i32 * GLYPH * scale
}

/// Draws `s` with a one-pixel dark shadow under and right of it, for legibility on any background.
pub fn draw_shadowed(t: &mut Target, x: i32, y: i32, scale: i32, color: u32, s: &str) -> i32 {
    draw(t, x + scale.max(1), y + scale.max(1), scale, 0x000000, s);
    draw(t, x, y, scale, color, s)
}

/// A line of text in a fixed buffer, for `write!` where nothing may be allocated (after the seal). Past its capacity the
/// text is cut; anything outside ASCII is written as '?'.
pub struct Buf<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    pub const fn new() -> Self {
        Buf { bytes: [0; N], len: 0 }
    }
    pub fn as_str(&self) -> &str {
        // Only ASCII is ever written.
        core::str::from_utf8(&self.bytes[..self.len]).unwrap_or("?")
    }
    pub fn clear(&mut self) {
        self.len = 0;
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> core::fmt::Write for Buf<N> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for c in s.chars() {
            if self.len < N {
                self.bytes[self.len] = if c.is_ascii() { c as u8 } else { b'?' };
                self.len += 1;
            }
        }
        Ok(())
    }
}

/// `n` with thousands separators ("4,274,560").
pub fn grouped(out: &mut impl core::fmt::Write, n: u64) -> core::fmt::Result {
    let mut digits = [0u8; 20];
    let mut k = 0;
    let mut v = n;
    loop {
        digits[k] = b'0' + (v % 10) as u8;
        k += 1;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    for i in (0..k).rev() {
        out.write_char(digits[i] as char)?;
        if i > 0 && i % 3 == 0 {
            out.write_char(',')?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glyph_lands_where_it_is_drawn_and_nothing_spills() {
        let mut px = std::vec![0u32; 32 * 16];
        let mut t = Target { pixels: &mut px, width: 32, height: 16, stride: 32 };
        let end = draw(&mut t, 4, 2, 1, 0xffffff, "A");
        assert_eq!(end, 12);
        // 'A' row 2 is 0x33: columns 0, 1, 4 and 5 of the glyph.
        let row: std::vec::Vec<u32> = (4..12).map(|x| px[(2 + 2) * 32 + x]).collect();
        assert_eq!(row, [0xffffff, 0xffffff, 0, 0, 0xffffff, 0xffffff, 0, 0]);
        // Clipped at every edge, never a panic.
        let mut t = Target { pixels: &mut px, width: 32, height: 16, stride: 32 };
        draw(&mut t, -20, -20, 3, 1, "clip");
        draw(&mut t, 30, 14, 3, 1, "clip");
        assert_eq!(width("abc", 2), 48);
        assert_eq!(glyph('é'), glyph('?'));
    }

    #[test]
    fn a_fixed_line_cuts_at_its_capacity_and_groups_digits() {
        use core::fmt::Write;
        let mut b: Buf<8> = Buf::new();
        write!(b, "{}é3456789", 12).unwrap();
        assert_eq!(b.as_str(), "12?34567");
        let mut g: Buf<32> = Buf::new();
        for n in [0u64, 7, 999, 1000, 4274560, u64::MAX] {
            g.clear();
            grouped(&mut g, n).unwrap();
            let plain: std::string::String = g.as_str().chars().filter(|c| *c != ',').collect();
            assert_eq!(plain, std::format!("{n}"));
        }
        g.clear();
        grouped(&mut g, 4274560).unwrap();
        assert_eq!(g.as_str(), "4,274,560");
    }
}
