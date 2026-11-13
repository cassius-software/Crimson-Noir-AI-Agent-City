// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? A model writes tokens, and a token's bytes may end in the middle of a character, or spell
//! part of the template's own turn marker when the model writes it as text instead of as its special token. Between
//! the model and the page the answer passes three small filters, each tested here without a model:
//! - `Utf8Hold` holds back the bytes of a character not yet complete, so the page only ever gets whole characters;
//! - `StopText` holds back a tail that could still become a turn marker (`<|im_end|>`, `<|im_start|>`), and ends the
//!   answer where one is spelled out, so a marker never reaches Sloane's card;
//! - `Batcher` gathers the pieces into text events of at most `TEXT_MAX` bytes, sent at least every `FLUSH_MS`, so the
//!   page gets a steady stream without one message per token.
//!
//! What breaks if it is removed? Broken characters, stray turn markers and a message per token reach the page.

use std::time::{Duration, Instant};

use crate::wire::TEXT_MAX;

/// How long text may wait in the batcher before it is sent.
pub const FLUSH_MS: u64 = 30;

/// The template's turn markers, which end an answer if the model spells one out as text.
pub const STOP_TEXT: [&str; 2] = ["<|im_end|>", "<|im_start|>"];

/// Holds back an incomplete UTF-8 sequence at the end of what it was given; invalid bytes become U+FFFD.
#[derive(Default, Debug)]
pub struct Utf8Hold {
    held: Vec<u8>,
}

impl Utf8Hold {
    /// The whole characters now complete.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.held.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.held) {
                Ok(s) => {
                    out.push_str(s);
                    self.held.clear();
                    return out;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    // The prefix up to `good` is valid UTF-8 by from_utf8's own word.
                    out.push_str(&String::from_utf8_lossy(&self.held[..good]));
                    match e.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.held.drain(..good + bad);
                        }
                        None => {
                            // An incomplete character at the end: keep it for the next piece.
                            self.held.drain(..good);
                            return out;
                        }
                    }
                }
            }
        }
    }

    /// What is left at the end of the answer (an incomplete character becomes U+FFFD).
    pub fn finish(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.held).into_owned();
        self.held.clear();
        out
    }
}

/// Ends the answer where the model spells out a turn marker, holding back any tail that could still become one.
#[derive(Default, Debug)]
pub struct StopText {
    held: String,
}

impl StopText {
    /// The text that is safe to show, and whether a marker was found (nothing after it is shown, nor the marker).
    pub fn push(&mut self, piece: &str) -> (String, bool) {
        self.held.push_str(piece);
        if let Some(at) = STOP_TEXT.iter().filter_map(|m| self.held.find(m)).min() {
            let out = self.held[..at].to_string();
            self.held.clear();
            return (out, true);
        }
        // The longest tail of what is held that is the start of a marker stays held.
        let keep = STOP_TEXT
            .iter()
            .map(|m| {
                (1..m.len().min(self.held.len() + 1))
                    .rev()
                    .find(|&n| self.held.is_char_boundary(self.held.len() - n) && m.starts_with(&self.held[self.held.len() - n..]))
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0);
        let cut = self.held.len() - keep;
        let out = self.held[..cut].to_string();
        self.held.drain(..cut);
        (out, false)
    }

    /// What is held at the end of the answer: a tail that never became a marker is shown.
    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.held)
    }
}

/// Gathers text into events of at most `TEXT_MAX` bytes, cut on character boundaries.
#[derive(Debug)]
pub struct Batcher {
    buf: String,
    since: Option<Instant>,
    flush: Duration,
}

impl Default for Batcher {
    fn default() -> Self {
        Batcher { buf: String::new(), since: None, flush: Duration::from_millis(FLUSH_MS) }
    }
}

impl Batcher {
    /// Adds text and answers the events due now: every full `TEXT_MAX` piece, and the rest once it has waited
    /// `FLUSH_MS` since its first byte.
    pub fn push(&mut self, text: &str, now: Instant) -> Vec<String> {
        if !text.is_empty() {
            if self.buf.is_empty() {
                self.since = Some(now);
            }
            self.buf.push_str(text);
        }
        let mut out = Vec::new();
        while self.buf.len() >= TEXT_MAX {
            let mut cut = TEXT_MAX;
            while !self.buf.is_char_boundary(cut) {
                cut -= 1;
            }
            out.push(self.buf[..cut].to_string());
            self.buf.drain(..cut);
            self.since = if self.buf.is_empty() { None } else { Some(now) };
        }
        if let Some(since) = self.since {
            if now.duration_since(since) >= self.flush && !self.buf.is_empty() {
                out.push(std::mem::take(&mut self.buf));
                self.since = None;
            }
        }
        out
    }

    /// Whatever is left, at the end of the answer.
    pub fn finish(&mut self) -> Option<String> {
        self.since = None;
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_hold_gives_whole_characters_only() {
        // "é" (2 bytes), "€" (3 bytes), "🙂" (4 bytes), split at every byte.
        let text = "aé€🙂z";
        let bytes = text.as_bytes();
        for cut_a in 0..bytes.len() {
            for cut_b in cut_a..bytes.len() {
                let mut h = Utf8Hold::default();
                let mut out = String::new();
                out += &h.push(&bytes[..cut_a]);
                out += &h.push(&bytes[cut_a..cut_b]);
                out += &h.push(&bytes[cut_b..]);
                out += &h.finish();
                assert_eq!(out, text, "cut at {cut_a} and {cut_b}");
            }
        }
    }

    #[test]
    fn utf8_hold_replaces_invalid_bytes_and_keeps_going() {
        let mut h = Utf8Hold::default();
        assert_eq!(h.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(h.push(b"\xe2\x82"), "");
        assert_eq!(h.finish(), "\u{FFFD}");
    }

    #[test]
    fn stop_text_ends_at_a_spelled_out_marker() {
        let mut s = StopText::default();
        let mut shown = String::new();
        let mut hit = false;
        for piece in ["Hello", " there", "<|im", "_e", "nd|>", "more"] {
            let (out, h) = s.push(piece);
            shown += &out;
            if h {
                hit = true;
                break;
            }
        }
        assert!(hit);
        assert_eq!(shown, "Hello there");
    }

    #[test]
    fn stop_text_shows_a_tail_that_never_became_a_marker() {
        let mut s = StopText::default();
        let (a, hit_a) = s.push("a <|i");
        assert_eq!((a.as_str(), hit_a), ("a ", false));
        let (b, hit_b) = s.push("s not");
        assert_eq!((b.as_str(), hit_b), ("<|is not", false));
        assert_eq!(s.push("<").0, "");
        assert_eq!(s.finish(), "<");
        // A marker in the middle of one piece ends the text there.
        let (c, hit_c) = StopText::default().push("yes<|im_start|>user");
        assert_eq!((c.as_str(), hit_c), ("yes", true));
    }

    #[test]
    fn batcher_sends_full_pieces_at_once_and_the_rest_after_the_flush_time() {
        let t0 = Instant::now();
        let mut b = Batcher::default();
        assert!(b.push("abc", t0).is_empty());
        assert!(b.push("d", t0 + Duration::from_millis(10)).is_empty());
        assert_eq!(b.push("", t0 + Duration::from_millis(FLUSH_MS)), vec!["abcd".to_string()]);
        let big = "é".repeat(TEXT_MAX); // 2 bytes each: 2 x TEXT_MAX bytes
        let out = b.push(&big, t0);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| p.len() <= TEXT_MAX && p.len() >= TEXT_MAX - 1));
        assert_eq!(b.finish(), None);
        b.push("x", t0);
        assert_eq!(b.finish(), Some("x".to_string()));
    }
}
