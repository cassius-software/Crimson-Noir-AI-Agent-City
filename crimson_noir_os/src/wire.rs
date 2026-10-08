// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the hosted runtime's side of the wire to the Phase 12 host's ledger door, with no
//! network crate: a WebSocket client (RFC 6455) over std's TcpStream, and the host's own envelope seal. The pieces:
//! - The handshake. The key is a random nonce; the answer must be 101 with the right Sec-WebSocket-Accept (SHA-1 of
//!   the key and the RFC's GUID) and the `crimson.1` subprotocol.
//! - Frames. The client's are masked; the host's must be unmasked, whole (no fragments) and bounded; pings are
//!   answered.
//! - JSON. A small reader, bounded in size and depth, that refuses anything the host never sends (fractions,
//!   exponents, non-ASCII escapes). A canonical writer: sorted keys, no whitespace, the text integrity.ts's canonical()
//!   produces.
//! - The seal. Every message is {n, body, mac}: the mac is HMAC-SHA256, under the session token, of the canonical
//!   {n, body}, and the numbers rise both ways. replication.ts seals and opens it the same way.
//!
//! It speaks only to this machine: a URL whose host is not a loopback address is refused. The bridge has no TLS, and
//! the operator's reverse proxy (which terminates wss for the room) is how anything off this machine would reach the
//! host. Nothing here listens, and nothing on the bootable image links it: the image stays air-gapped.
//! What breaks if it is removed? The runtime cannot reach the ledger door.

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use noir_core::hash::sha256;

// -------------------------------------------------------------------------------------------------------------------
// Digests and encodings

/// SHA-1 (FIPS 180-4), for the handshake's Sec-WebSocket-Accept only.
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a82_7999),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// Standard base64 with padding.
pub fn base64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(A[((n >> (18 - 6 * k)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// SHA-256 as lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    hex(&sha256(data))
}

/// HMAC-SHA256 (RFC 2104) as lowercase hex: a key longer than the block is hashed first, as integrity.ts does.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend(k.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(message);
    let mut outer = Vec::with_capacity(96);
    outer.extend(k.iter().map(|b| b ^ 0x5c));
    outer.extend_from_slice(&sha256(&inner));
    sha256_hex(&outer)
}

// -------------------------------------------------------------------------------------------------------------------
// JSON

/// JSON as the host sends it: no fractions or exponents (every number it sends is a whole one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Json::Str(s)) => Some(s),
            _ => None,
        }
    }
    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Json::Int(n)) => Some(*n),
            _ => None,
        }
    }
    pub fn obj(fields: &[(&str, Json)]) -> Json {
        Json::Obj(fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
    }
}

/// The canonical text of a value, as integrity.ts canonical() writes it: object keys sorted, no whitespace, strings
/// escaped as JSON.stringify escapes them.
pub fn canonical(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(n) => {
            let _ = write!(out, "{n}");
        }
        Json::Str(s) => quote(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (k, item) in items.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Json::Obj(fields) => {
            let mut sorted: Vec<&(String, Json)> = fields.iter().collect();
            // JavaScript sorts keys by UTF-16 code unit; for the ASCII keys of this protocol that is byte order.
            sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (k, (key, value)) in sorted.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                canonical(value, out);
            }
            out.push('}');
        }
    }
}

pub fn canonical_string(v: &Json) -> String {
    let mut s = String::new();
    canonical(v, &mut s);
    s
}

fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The deepest nesting the reader accepts (the host's messages are three deep at most).
const MAX_DEPTH: usize = 16;

/// Reads one JSON value from `text`, refusing anything malformed, too deep, or not plain data the host would send.
pub fn parse(text: &str) -> Result<Json, String> {
    let b = text.as_bytes();
    let mut at = 0;
    let v = value(b, &mut at, 0)?;
    skip_ws(b, &mut at);
    if at != b.len() {
        return Err(String::from("json: text after the value"));
    }
    Ok(v)
}

fn skip_ws(b: &[u8], at: &mut usize) {
    while *at < b.len() && matches!(b[*at], b' ' | b'\t' | b'\n' | b'\r') {
        *at += 1;
    }
}

fn value(b: &[u8], at: &mut usize, depth: usize) -> Result<Json, String> {
    if depth > MAX_DEPTH {
        return Err(String::from("json: nested too deep"));
    }
    skip_ws(b, at);
    match b.get(*at) {
        None => Err(String::from("json: ended early")),
        Some(b'{') => {
            *at += 1;
            let mut fields: Vec<(String, Json)> = Vec::new();
            skip_ws(b, at);
            if b.get(*at) == Some(&b'}') {
                *at += 1;
                return Ok(Json::Obj(fields));
            }
            loop {
                skip_ws(b, at);
                let key = string(b, at)?;
                if fields.iter().any(|(k, _)| *k == key) {
                    return Err(String::from("json: a key twice"));
                }
                skip_ws(b, at);
                if b.get(*at) != Some(&b':') {
                    return Err(String::from("json: expected ':'"));
                }
                *at += 1;
                let v = value(b, at, depth + 1)?;
                fields.push((key, v));
                skip_ws(b, at);
                match b.get(*at) {
                    Some(b',') => *at += 1,
                    Some(b'}') => {
                        *at += 1;
                        return Ok(Json::Obj(fields));
                    }
                    _ => return Err(String::from("json: expected ',' or '}'")),
                }
            }
        }
        Some(b'[') => {
            *at += 1;
            let mut items = Vec::new();
            skip_ws(b, at);
            if b.get(*at) == Some(&b']') {
                *at += 1;
                return Ok(Json::Arr(items));
            }
            loop {
                items.push(value(b, at, depth + 1)?);
                skip_ws(b, at);
                match b.get(*at) {
                    Some(b',') => *at += 1,
                    Some(b']') => {
                        *at += 1;
                        return Ok(Json::Arr(items));
                    }
                    _ => return Err(String::from("json: expected ',' or ']'")),
                }
            }
        }
        Some(b'"') => Ok(Json::Str(string(b, at)?)),
        Some(b't') if b[*at..].starts_with(b"true") => {
            *at += 4;
            Ok(Json::Bool(true))
        }
        Some(b'f') if b[*at..].starts_with(b"false") => {
            *at += 5;
            Ok(Json::Bool(false))
        }
        Some(b'n') if b[*at..].starts_with(b"null") => {
            *at += 4;
            Ok(Json::Null)
        }
        Some(b'-' | b'0'..=b'9') => {
            let start = *at;
            if b[*at] == b'-' {
                *at += 1;
            }
            let digits = *at;
            while *at < b.len() && b[*at].is_ascii_digit() {
                *at += 1;
            }
            let n = *at - digits;
            if n == 0 || n > 16 || (n > 1 && b[digits] == b'0') {
                return Err(String::from("json: not a whole number the host would write"));
            }
            if matches!(b.get(*at), Some(b'.' | b'e' | b'E')) {
                return Err(String::from("json: a fraction or an exponent"));
            }
            let text = std::str::from_utf8(&b[start..*at]).map_err(|_| String::from("json: number"))?;
            text.parse::<i64>().map(Json::Int).map_err(|_| String::from("json: number"))
        }
        Some(_) => Err(String::from("json: unexpected character")),
    }
}

fn string(b: &[u8], at: &mut usize) -> Result<String, String> {
    if b.get(*at) != Some(&b'"') {
        return Err(String::from("json: expected a string"));
    }
    *at += 1;
    let mut out = String::new();
    loop {
        let start = *at;
        while *at < b.len() && b[*at] != b'"' && b[*at] != b'\\' && b[*at] >= 0x20 {
            *at += 1;
        }
        out.push_str(std::str::from_utf8(&b[start..*at]).map_err(|_| String::from("json: not UTF-8"))?);
        match b.get(*at) {
            Some(b'"') => {
                *at += 1;
                return Ok(out);
            }
            Some(b'\\') => {
                let c = match b.get(*at + 1) {
                    Some(b'"') => '"',
                    Some(b'\\') => '\\',
                    Some(b'/') => '/',
                    Some(b'b') => '\u{8}',
                    Some(b'f') => '\u{c}',
                    Some(b'n') => '\n',
                    Some(b'r') => '\r',
                    Some(b't') => '\t',
                    Some(b'u') => {
                        let h = b.get(*at + 2..*at + 6).ok_or_else(|| String::from("json: short \\u escape"))?;
                        let v = u32::from_str_radix(std::str::from_utf8(h).map_err(|_| String::from("json: \\u"))?, 16)
                            .map_err(|_| String::from("json: \\u"))?;
                        // The host's text is ASCII; an escape outside it (a surrogate half included) is refused.
                        if v >= 0x80 {
                            return Err(String::from("json: a \\u escape outside ASCII"));
                        }
                        *at += 4;
                        char::from_u32(v).ok_or_else(|| String::from("json: \\u"))?
                    }
                    _ => return Err(String::from("json: bad escape")),
                };
                out.push(c);
                *at += 2;
            }
            _ => return Err(String::from("json: unterminated string")),
        }
    }
}

// -------------------------------------------------------------------------------------------------------------------
// The WebSocket client

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// The largest frame the client reads from the host, bytes (a chunk of weights is about 10 KiB).
pub const MAX_FRAME: usize = 65536;
/// The longest a whole message may take to arrive (the read timeout is per read, and a host that drips a byte or a
/// ping at a time would otherwise hold the bridge for ever), and the pings answered within one message.
pub const MESSAGE_DEADLINE: Duration = Duration::from_secs(10);
pub const PINGS_PER_MESSAGE: u32 = 64;

/// Text the host chose, fit for a terminal or a log: every control character (C0, DEL, C1), the line and paragraph
/// separators and the bidi controls are written as escapes, a backslash as two, and the text is cut at 200 characters.
pub fn loggable(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars().take(200) {
        match ch {
            '\\' => out.push_str("\\\\"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') => {
                let _ = write!(out, "\\u{{{:x}}}", c as u32);
            }
            c => out.push(c),
        }
    }
    if text.chars().count() > 200 {
        out.push_str("...");
    }
    out
}
const MAX_HEADERS: usize = 8192;

/// A number nobody can predict from outside this process: std's per-process random hasher keys, and a counter.
fn random_u64(counter: &mut u64) -> u64 {
    use std::hash::BuildHasher;
    *counter = counter.wrapping_add(1);
    std::collections::hash_map::RandomState::new().hash_one(*counter)
}

/// What one read from the host came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Close(u16, String),
}

pub struct Ws {
    stream: TcpStream,
    buf: Vec<u8>,
    counter: u64,
}

/// The loopback address a `ws://` URL names, or why it is refused. Only a literal address is taken (and `localhost`,
/// as 127.0.0.1): no name is looked up, since a lookup would itself send the name to a resolver off this machine.
pub fn loopback(url: &str) -> Result<(String, SocketAddr), String> {
    let rest = url.strip_prefix("ws://").ok_or_else(|| String::from("the bridge speaks ws:// to this machine only (wss is the proxy's)"))?;
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = authority.rsplit_once(':').ok_or_else(|| format!("{authority}: no port"))?;
    let port: u16 = port.parse().map_err(|_| format!("{authority}: the port is not a number"))?;
    let ip: IpAddr = match host {
        "localhost" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        _ => host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host)
            .parse()
            .map_err(|_| format!("{authority} is not an address: the bridge looks up no names and speaks only to the loopback host"))?,
    };
    if !ip.is_loopback() {
        return Err(format!("{authority} is not this machine: the bridge has no TLS and speaks only to the loopback host"));
    }
    Ok((authority.to_string(), SocketAddr::new(ip, port)))
}

impl Ws {
    /// Opens a WebSocket to the loopback host at `url`, offering `protocol` and the session token; the answer must be
    /// a 101 that accepts the key and speaks `protocol`.
    pub fn connect(url: &str, protocol: &str, token: &str) -> Result<Ws, String> {
        let (authority, addr) = loopback(url)?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("connect {authority}: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(20))).map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut ws = Ws { stream, buf: Vec::new(), counter: 0 };
        let mut nonce = [0u8; 16];
        nonce[..8].copy_from_slice(&random_u64(&mut ws.counter).to_le_bytes());
        nonce[8..].copy_from_slice(&random_u64(&mut ws.counter).to_le_bytes());
        let key = base64(&nonce);
        let request = format!(
            "GET / HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: {protocol}, auth.{token}\r\n\r\n"
        );
        ws.stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        // The response's headers, whole, and bounded.
        let end = loop {
            if let Some(p) = ws.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p;
            }
            if ws.buf.len() > MAX_HEADERS {
                return Err(String::from("the host's response headers are too long"));
            }
            ws.fill()?;
        };
        let head = String::from_utf8_lossy(&ws.buf[..end]).to_string();
        ws.buf.drain(..end + 4);
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap_or("");
        if !status.starts_with("HTTP/1.1 101") {
            return Err(format!("the host refused the upgrade: {}", status.trim_start_matches("HTTP/1.1 ")));
        }
        let header = |name: &str| -> Option<String> {
            head.split("\r\n").skip(1).find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
            })
        };
        let accept = base64(&sha1(format!("{key}{GUID}").as_bytes()));
        if header("sec-websocket-accept").as_deref() != Some(accept.as_str()) {
            return Err(String::from("the host's Sec-WebSocket-Accept does not answer the key"));
        }
        if header("sec-websocket-protocol").as_deref() != Some(protocol) {
            return Err(format!("the host does not speak {protocol}"));
        }
        if !header("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket")) {
            return Err(String::from("the host did not upgrade to a WebSocket"));
        }
        Ok(ws)
    }

    fn fill(&mut self) -> Result<(), String> {
        let mut chunk = [0u8; 16384];
        let n = self.stream.read(&mut chunk).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err(String::from("the host closed the connection"));
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(())
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        match payload.len() {
            n if n < 126 => frame.push(0x80 | n as u8),
            n if n <= 0xffff => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        let mask = (random_u64(&mut self.counter) as u32).to_be_bytes();
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame).map_err(|e| format!("write: {e}"))
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), String> {
        self.send_frame(1, text.as_bytes())
    }

    /// The next text or close from the host. Pings are answered on the way; a fragment, a masked or oversized frame,
    /// reserved bits or a binary frame is a protocol error.
    pub fn recv(&mut self) -> Result<Frame, String> {
        let started = Instant::now();
        let mut pings = 0u32;
        loop {
            if started.elapsed() > MESSAGE_DEADLINE {
                return Err(format!("the host did not send a whole message within the deadline ({} s)", MESSAGE_DEADLINE.as_secs()));
            }
            match read_frame(&self.buf)? {
                None => self.fill()?,
                Some((opcode, payload, used)) => {
                    self.buf.drain(..used);
                    match opcode {
                        1 => return String::from_utf8(payload).map(Frame::Text).map_err(|_| String::from("a text frame that is not UTF-8")),
                        8 => {
                            let code = if payload.len() >= 2 { u16::from_be_bytes([payload[0], payload[1]]) } else { 1005 };
                            let reason = String::from_utf8_lossy(payload.get(2..).unwrap_or(&[])).to_string();
                            return Ok(Frame::Close(code, reason));
                        }
                        9 => {
                            pings += 1;
                            if pings > PINGS_PER_MESSAGE {
                                return Err(String::from("too many pings before a message"));
                            }
                            self.send_frame(10, &payload)?;
                        }
                        10 => {}
                        _ => return Err(format!("the host sent opcode {opcode}")),
                    }
                }
            }
        }
    }

    /// The close handshake's first half; the host answers and ends the connection.
    pub fn close(&mut self) {
        let _ = self.send_frame(8, &1000u16.to_be_bytes());
    }
}

/// One frame from the front of `buf` as a host sends it: Ok(None) until it is whole.
pub fn read_frame(buf: &[u8]) -> Result<Option<(u8, Vec<u8>, usize)>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let (b0, b1) = (buf[0], buf[1]);
    if b0 & 0x80 == 0 {
        return Err(String::from("a fragmented frame from the host"));
    }
    if b0 & 0x70 != 0 {
        return Err(String::from("reserved bits set"));
    }
    if b1 & 0x80 != 0 {
        return Err(String::from("a masked frame from the host"));
    }
    let opcode = b0 & 0x0f;
    let (len, mut at) = match b1 & 0x7f {
        126 => {
            if buf.len() < 4 {
                return Ok(None);
            }
            (u16::from_be_bytes([buf[2], buf[3]]) as u64, 4)
        }
        127 => {
            if buf.len() < 10 {
                return Ok(None);
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(&buf[2..10]);
            (u64::from_be_bytes(b), 10)
        }
        n => (n as u64, 2),
    };
    if opcode >= 8 && len > 125 {
        return Err(String::from("a control frame over 125 bytes"));
    }
    if len > MAX_FRAME as u64 {
        return Err(format!("a frame of {len} bytes, over {MAX_FRAME}"));
    }
    let len = len as usize;
    if buf.len() < at + len {
        return Ok(None);
    }
    let payload = buf[at..at + len].to_vec();
    at += len;
    Ok(Some((opcode, payload, at)))
}

// -------------------------------------------------------------------------------------------------------------------
// The seal

/// A session on the ledger door: the socket, the token every envelope is sealed under, and both envelope counters.
pub struct Sealed {
    pub ws: Ws,
    token: String,
    sent: i64,
    received: i64,
}

/// The canonical {n, body} an envelope's mac covers.
fn sealed_text(n: i64, body: &Json) -> String {
    canonical_string(&Json::obj(&[("n", Json::Int(n)), ("body", body.clone())]))
}

impl Sealed {
    pub fn new(ws: Ws, token: &str) -> Sealed {
        Sealed { ws, token: token.to_string(), sent: 0, received: 0 }
    }

    /// `body` as the next envelope, sealed.
    pub fn send(&mut self, body: &Json) -> Result<(), String> {
        self.sent += 1;
        let mac = hmac_sha256(self.token.as_bytes(), sealed_text(self.sent, body).as_bytes());
        let wire = canonical_string(&Json::obj(&[("n", Json::Int(self.sent)), ("body", body.clone()), ("mac", Json::Str(mac))]));
        self.ws.send_text(&wire)
    }

    /// The next message's body: the envelope must parse, its seal must be the token's, and its number must rise. A
    /// close is an error naming the code and reason.
    pub fn recv(&mut self) -> Result<Json, String> {
        match self.ws.recv()? {
            Frame::Close(code, reason) => Err(format!("the host closed the session ({code}): {}", loggable(&reason))),
            Frame::Text(wire) => {
                let env = parse(&wire)?;
                let (Some(n), Some(mac), Some(body)) = (env.int("n"), env.str("mac"), env.get("body")) else {
                    return Err(String::from("an envelope without n, body and mac"));
                };
                if mac != hmac_sha256(self.token.as_bytes(), sealed_text(n, body).as_bytes()) {
                    return Err(String::from("a frame whose seal is not the session token's"));
                }
                if n <= self.received {
                    return Err(String::from("a replayed frame"));
                }
                self.received = n;
                Ok(body.clone())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digests_are_the_standards() {
        // FIPS 180 and RFC 4231 test vectors, and the RFC 6455 handshake example.
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(base64(&sha1(format!("dGhlIHNhbXBsZSBub25jZQ=={GUID}").as_bytes())), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(
            hmac_sha256(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // RFC 4231 case 6: a key longer than the block is hashed first.
        assert_eq!(
            hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn canonical_json_is_integrity_ts_canonical() {
        // The same text replication.ts would hash: keys sorted, no whitespace, escapes as JSON.stringify writes them.
        let v = Json::obj(&[("n", Json::Int(3)), ("body", Json::obj(&[("t", Json::Str("hello".into())), ("v", Json::Int(1))]))]);
        assert_eq!(canonical_string(&v), r#"{"body":{"t":"hello","v":1},"n":3}"#);
        let s = Json::Str("a\"b\\c\nd\u{1}".into());
        assert_eq!(canonical_string(&s), r#""a\"b\\c\nd\u0001""#);
        assert_eq!(canonical_string(&Json::Arr(vec![Json::Int(-5), Json::Null, Json::Bool(true)])), "[-5,null,true]");
    }

    #[test]
    fn the_json_reader_takes_what_the_host_writes_and_refuses_the_rest() {
        let v = parse(r#" {"n": 7, "body": {"t":"weights","list":[[0,12],[9,-3]]}, "mac":"ab\n\u0041"} "#).unwrap();
        assert_eq!(v.int("n"), Some(7));
        assert_eq!(v.str("mac"), Some("ab\nA"));
        for bad in [
            "", "{", "[1,]", "{\"a\":1,\"a\":2}", "1.5", "1e3", "01", "\"\\u00e9\"", "\"\\ud800\"", "tru", "[1] 2",
            "{\"a\" 1}", "\"unterminated", "99999999999999999",
        ] {
            assert!(parse(bad).is_err(), "accepted {bad:?}");
        }
        let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
        assert!(parse(&deep).is_err(), "nested too deep");
    }

    #[test]
    fn frames_are_read_by_the_rules_a_host_must_keep() {
        assert_eq!(read_frame(&[0x81, 0x02, b'h', b'i']).unwrap(), Some((1, b"hi".to_vec(), 4)));
        assert_eq!(read_frame(&[0x81, 0x05, b'h']).unwrap(), None, "waits for the rest");
        assert!(read_frame(&[0x01, 0x00]).is_err(), "a fragment");
        assert!(read_frame(&[0x81, 0x80, 0, 0, 0, 0]).is_err(), "masked");
        assert!(read_frame(&[0xc1, 0x00]).is_err(), "reserved bits");
        assert!(read_frame(&[0x89, 126, 0x00, 0x80]).is_err(), "a long control frame");
        assert!(read_frame(&[0x81, 127, 0, 0, 0, 0, 0x7f, 0, 0, 0]).is_err(), "over the bound");
    }

    #[test]
    fn only_loopback_urls_are_spoken_to() {
        assert!(loopback("ws://127.0.0.1:8787").is_ok());
        assert!(loopback("ws://[::1]:8787/").is_ok());
        assert!(loopback("wss://127.0.0.1:8787").is_err());
        assert!(loopback("http://127.0.0.1:8787").is_err());
        assert!(loopback("ws://10.0.0.1:8787").is_err());
        assert!(loopback("ws://8.8.8.8:80").is_err());
        assert!(loopback("ws://localhost:8787").is_ok_and(|(_, a)| a.ip().is_loopback()));
        // A name is refused without being looked up: no resolver hears it.
        assert!(loopback("ws://example.invalid:8787").is_err_and(|e| e.contains("looks up no names")));
        assert!(loopback("ws://127.0.0.1").is_err());
        assert!(loopback("ws://127.0.0.1:99999").is_err());
    }

    /// Random bytes, and random mutations of good frames and envelopes: the reader and the parser only ever refuse,
    /// they never panic or read out of bounds.
    #[test]
    fn random_bytes_never_panic_the_frame_reader_or_the_json_reader() {
        let mut seed = 0x9e37_79b9u32;
        let mut next = move || {
            seed = noir_core::hash::mix32(seed.wrapping_add(0x6d2b_79f5));
            seed
        };
        let good = br#"{"n":1,"body":{"t":"end","head":"00","count":3,"weights":"ff","pairs":2},"mac":"aa"}"#.to_vec();
        for _ in 0..20_000 {
            let mut bytes: Vec<u8> = if next() % 2 == 0 {
                (0..next() % 64).map(|_| next() as u8).collect()
            } else {
                let mut g = good.clone();
                for _ in 0..1 + next() % 4 {
                    let i = next() as usize % g.len();
                    g[i] = next() as u8;
                }
                g
            };
            let _ = read_frame(&bytes);
            if let Ok(text) = std::str::from_utf8(&bytes) {
                let _ = parse(text);
            }
            bytes.truncate(next() as usize % (bytes.len() + 1));
            let _ = read_frame(&bytes);
        }
    }
}
